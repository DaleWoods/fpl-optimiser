> **Executed.** Delivered in `62f2e39` — "Learn from the model's own error, per position".
>
> Kept for the reasoning, not as outstanding work. Anything below written in the
> present tense ("currently", "today", "does not exist yet") describes the codebase
> *before* that commit. Executed as written. The plan's central warning - that the naive implementation fails by reverting rather than diverging - held up, and the xpts_uncalibrated column and its test are what prevent it.

# PLAN 2 — Close the loop: learn from the model's own error

**Rank: 2 of 5. Do this after Plan 1.**
**Size: medium (one new module, ~200 lines, plus wiring and a page section).**
**Type: the feature the whole Accuracy page exists to enable, and which does not exist yet.**

---

## Goal

Right now the app **measures** its own error and then throws the measurement away. `evaluateGameweek()`
computes mean absolute error, bias overall, bias per position and bias per confidence tier — and
nothing anywhere reads any of it. The next projection is made exactly as if the previous ones had
never been graded.

Build the missing half: derive a small set of **calibration factors** from the model's own
historical error, store them, apply them to future projections, and show on the page what was
learned and what it changed.

### Hard constraint on scope

This is a *bias correction*, not a rewrite of the model and not machine learning. One
multiplicative factor per position, learned from measured signed error, heavily shrunk, tightly
bounded, fully visible, and switchable off with one config value. Anything more ambitious is out
of scope for this plan — a wrong nudge here is actively costly, and an opaque one destroys the
transparency that is the point of this app.

---

## Why this is high leverage

It compounds. Every gameweek that finishes makes every subsequent projection slightly better,
with no human input. It is also the one thing that turns the Accuracy page from a report card
into a mechanism.

**It must come after Plan 1.** Calibration learns constants from projection error. Fit those
constants on top of a known bug and you bake the bug into the constants, then have to unpick two
things at once when the bug is fixed.

---

## Files to touch

| File | Change |
|---|---|
| `src/model/calibration.ts` | **New.** Compute, store and load calibration factors |
| `src/db/migrations/0005_calibration.sql` | **New.** One table, plus a `projection` column |
| `src/model/build.ts` | Apply factors at the end of `buildProjections()` |
| `src/config/schema.ts` | Add the `calibration` block |
| `config/model.weights.json` | Add values, bump `modelVersion` |
| `src/report/views.ts` | New section in `renderAccuracy` |
| `src/report/recommend.ts` | Add `calibration` to `Recommendation.evidence` |
| `test/unit/calibration.test.ts` | **New.** 8 tests |
| `README.md` | New `###` section under "Measuring the model" |

---

## Step-by-step

### Step 1 — Migration

Create `src/db/migrations/0005_calibration.sql`. Read `0004_price_trend.sql` first and match its
comment style and formatting exactly.

```sql
-- What the model learned from its own error, per position.
--
-- Recomputed whenever a gameweek is graded, and stamped with the model version it was measured
-- against: a factor learned from heuristic-0.15.0's mistakes says nothing useful about
-- heuristic-0.17.0, and silently carrying it over would be learning from a model that no longer
-- exists. Rows are kept rather than replaced so the correction itself has a history.
CREATE TABLE calibration_factor (
  model_version   TEXT    NOT NULL,
  position        TEXT    NOT NULL,
  factor          REAL    NOT NULL,   -- multiplier applied to xPts, 1.0 = no correction
  observed_bias   REAL    NOT NULL,   -- mean signed error the factor was derived from
  sample_players  INTEGER NOT NULL,   -- projections behind it
  gameweeks       INTEGER NOT NULL,   -- graded gameweeks behind it
  computed_at     INTEGER NOT NULL,

  PRIMARY KEY (model_version, position)
);

-- The projection before any calibration was applied. This is what a future correction is
-- measured against; the calibrated `xpts` next to it stays the thing the Accuracy page grades,
-- because that is the number the page actually showed. Measuring a correction against already-
-- corrected output makes a working correction look unnecessary and reverts it - see the plan.
ALTER TABLE projection ADD COLUMN xpts_uncalibrated REAL;
```

`src/db/migrate.ts` discovers migrations with `readdirSync(MIGRATIONS_DIR)` and records applied
ones, so dropping the file in is all that is needed — there is no list to update, and it will
not re-run. Confirm the `projection` table shape in `0001_init.sql` before writing the
`ALTER TABLE`: it has `xpts` and `xpts_raw` today and no uncalibrated column.

### Step 2 — Config

`src/config/schema.ts`, top level of the model-weights schema (sibling of `attacking`,
`minutes`, etc.):

```ts
/**
 * Correcting the model using its own measured error.
 *
 * The Accuracy page has always measured bias per position; this is what finally does something
 * with it. Deliberately conservative: one multiplicative factor per position, shrunk hard by
 * sample size and clamped, so it can nudge a systematic lean out of the model but can never
 * rewrite a projection. Set enabled to false to turn the whole mechanism off and project
 * exactly as before.
 */
calibration: z.object({
  enabled: z.boolean(),
  /**
   * Projections needed before a position's correction is half-trusted. Bias measured over one
   * gameweek is mostly the week's own variance - a striker drought and a defensive haul are
   * not evidence that the model leans, they are evidence that football happened.
   */
  priorWeightPlayers: positiveNumber,
  /** Graded gameweeks before any correction is applied at all. */
  minGameweeks: positiveInt,
  /**
   * Hard bounds on the factor. A model that needs a 40% correction has a bug to fix, not a
   * lean to tune out, and quietly applying one would hide it.
   */
  minFactor: positiveNumber,
  maxFactor: positiveNumber,
}),
```

Reuse whatever the existing helper validators in that file are actually named. Then in
`config/model.weights.json`, add a top-level block with a `$comment` array in the house style:

```json
"calibration": {
  "$comment": [
    "Correcting the model with its own measured error, per position. The Accuracy page has",
    "always computed bias per position and nothing has ever read it; this is what does.",
    "priorWeightPlayers 400: bias over a single gameweek is mostly that week's own variance,",
    "so a position needs a few hundred graded projections before its lean is believable.",
    "minGameweeks 3: below that there is no lean to speak of, only noise.",
    "minFactor/maxFactor 0.8/1.25: a model needing more correction than that has a bug to fix,",
    "not a lean to tune out, and silently applying a bigger one would hide it.",
    "Set enabled to false to project exactly as if none of this existed."
  ],
  "enabled": true,
  "priorWeightPlayers": 400,
  "minGameweeks": 3,
  "minFactor": 0.8,
  "maxFactor": 1.25
}
```

Bump `modelVersion` to `heuristic-0.17.0` (assuming Plan 1 took `0.16.0`).

### Step 3 — The calibration module

Create `src/model/calibration.ts`.

```ts
export interface CalibrationFactor {
  position: string;
  factor: number;
  observedBias: number;
  samplePlayers: number;
  gameweeks: number;
}

/**
 * Derive a per-position correction from the model's own graded error.
 *
 * The correction is multiplicative and derived from the ratio of what actually happened to
 * what was projected, not from the raw bias in points. A 0.5-point lean means something very
 * different for a goalkeeper projected at 3 than for a captain projected at 9, and a single
 * additive correction would be wrong for both.
 *
 * Shrunk toward 1.0 by sample size, for exactly the reason every other rate in this model is
 * shrunk: a thin sample of a noisy quantity is not evidence. Then clamped, because a large
 * required correction is a bug report, not a tuning parameter.
 */
export function computeCalibration(
  db: Database,
  rules: Rules,
  weights: ModelWeights,
  entryId?: number | null,
): CalibrationFactor[]
```

Implementation notes, in order:

1. Query every graded projection joined to its actual, restricted to the **current
   `weights.modelVersion`**. The join is the one already used in `evaluateSeason` around
   line 693 of `src/model/accuracy.ts` — copy that query shape, add
   `WHERE pr.model_version = ?`, and select `position` alongside `predicted` and `actual`.

2. Count distinct `event_id`. If that count `< weights.calibration.minGameweeks`, return `[]`.
   No correction at all until there is something to learn from.

3. Group by position. For each position, sum predicted and sum actual across all rows.

4. Raw factor = `sumActual / sumPredicted`. Guard `sumPredicted <= 0` → skip that position
   entirely (do not emit a factor of 0 or Infinity).

5. Shrink toward 1.0 by sample size:
   ```ts
   const n = rows.length;
   const w = n / (n + weights.calibration.priorWeightPlayers);
   const shrunk = 1 + (rawFactor - 1) * w;
   ```

6. Clamp to `[minFactor, maxFactor]`.

7. Return the factors with `observedBias` = mean signed error `(predicted - actual)`, matching
   the sign convention `evaluateGameweek` already uses (positive = too optimistic). Check that
   convention in `src/model/accuracy.ts` before writing it and match it — a flipped sign here
   would be invisible in tests but wrong on the page.

Also export:

- `saveCalibration(db, modelVersion, factors)` — upsert into `calibration_factor`, `ON CONFLICT
  (model_version, position) DO UPDATE`.
- `loadCalibration(db, modelVersion): Map<string, CalibrationFactor>` — read back for one model
  version only. Never fall back to another version's rows.

### Step 4 — Apply it

In `src/model/build.ts`, at the very end of `buildProjections()`, after every `ProjectedPlayer`
is built and before the array is returned:

```ts
// Correct the model with what it has learned about its own lean, per position. Applied last,
// to the finished projection, so every component in the breakdown still adds up to xPtsRaw and
// the explanation on the page stays literally true. The factor is recorded on the player so
// the page can show what was applied rather than silently shifting the numbers.
if (weights.calibration.enabled) {
  const factors = loadCalibration(db, weights.modelVersion);
  for (const player of projected) {
    const calibration = factors.get(player.position);
    if (calibration === undefined || calibration.factor === 1) continue;
    player.xPts = round(player.xPts * calibration.factor);
    player.calibrationFactor = calibration.factor;
    player.reasons.push(
      `Calibrated ×${calibration.factor.toFixed(3)} from ${calibration.gameweeks} graded ` +
        `gameweek(s): ${player.position} projections have run ` +
        `${calibration.observedBias > 0 ? 'high' : 'low'} by ` +
        `${Math.abs(calibration.observedBias).toFixed(2)} points on average.`,
    );
  }
}
```

Add `calibrationFactor?: number` to `ProjectedPlayer` in `src/domain/types.ts`, with a comment
saying it is absent when no correction applied.

### Step 5 — Recompute when a gameweek is graded

Find where `evaluateGameweek` is called after results land. Add a `saveCalibration(db,
weights.modelVersion, computeCalibration(db, rules, weights))` call there. If there is no such
hook, call it at the top of `recommend()` in `src/report/recommend.ts`, immediately before
`buildProjections` — cheap, and guarantees the factors are current for the projection about to
be made.

### Step 6 — Show it

Two places.

**Accuracy page** (`renderAccuracy` in `src/report/views.ts`) — a new section after the
scorecards, before "How reliable each projection is":

```
<h2>What the model has learned</h2>
```
A table: Position | Graded projections | Measured lean | Correction applied. Then a
`<details class="explain">` explaining that the correction is derived from measured error,
shrunk by sample size and clamped, and that it is off if `enabled` is false. If
`computeCalibration` returns `[]`, render one line: "Not enough graded gameweeks yet — a
correction needs at least N." Do not render an empty table.

**My Team page** — add the applied factors to the "Evidence behind these projections" list in
`renderRecommendation`. One `<li>`: which positions are being corrected and by how much, or
"No calibration applied yet" when there is none.

---

## Edge cases a weaker model will get wrong

1. **Never learn across model versions.** A factor measured against `heuristic-0.15.0` describes
   a model that no longer exists. `loadCalibration` must filter on the *current*
   `weights.modelVersion` and return empty when there are no rows for it. It must **not** fall
   back to the most recent version available. This means bumping `modelVersion` correctly resets
   the learning, which is the intended behaviour, not a bug.

2. **The feedback loop must not eat itself — and the danger is not the one you expect.**

   `saveProjections` in `src/model/build.ts` stores `xpts` *and* `xpts_raw`, and the accuracy
   grading queries join on `pr.xpts`. So if you calibrate `xPts` in place, the stored and graded
   number is the calibrated one.

   The failure that causes is **not** runaway growth. It is **reversion**: suppose the model
   projects low, you learn a factor of 1.2, apply it, and the projections become accurate. The
   next round measures the corrected output, finds a ratio of ≈ 1.0, and writes a factor of 1.0
   — throwing away the correction that was working. The week after, the error returns, the
   factor climbs back to 1.2, and the model oscillates between corrected and uncorrected
   forever, with no way for a reader to tell which state a given week's advice was in.

   The fix, and you must implement it this way:

   - Add an `xpts_uncalibrated REAL` column to the `projection` table in migration `0005`, and
     write the pre-calibration value into it in `saveProjections`.
   - `computeCalibration` reads **`xpts_uncalibrated`** (falling back to `xpts` for rows written
     before this migration, which have no calibration applied and so are equivalent).
   - The Accuracy page keeps grading **`xpts`**, the calibrated figure. That is honest: it is
     the number the page actually showed you, and it is what the advice was.

   So the factor is always an *absolute* correction measured against the uncorrected model,
   never a correction of a correction. Test 6 exists to prove this and is the single most
   important test in this plan.

3. **`xPtsRaw` must not be calibrated.** It is the pre-availability figure used for
   explanation. Multiply `xPts` only.

4. **The breakdown must still add up.** After calibration, `sum(breakdown) !== xPts`. That is
   acceptable *only* because the reason string says a factor was applied. Do not scale each
   breakdown component individually to make them tally — that would imply the model learned
   something per-component, which it did not.

5. **Selection value and the optimiser read `xPts`.** That is correct and intended: the
   corrected number should drive selection. But check `selectionValue` in
   `src/optimise/squad.ts` — it multiplies by confidence and start risk. Calibration must not be
   applied a second time there.

6. **Positions with no rows get no factor**, not a factor of 1 written to the table. An absent
   row and a neutral row look the same when applied but different on the page, and "we have not
   measured this yet" is not the same claim as "we measured this and it was fine".

7. **Guard against zero and negative sums.** `sumPredicted` can be ≤ 0 for a position early in
   a season. Skip, do not divide.

8. **The migration must be idempotent-safe.** Check whether `migrate.ts` tracks applied
   migrations in a table; if it does, nothing extra is needed. If it re-runs files, add
   `IF NOT EXISTS`.

---

## Tests

New file `test/unit/calibration.test.ts`. Use `openTestDatabase()` and the seeding helpers from
`test/unit/accuracy.test.ts` — read that file first and reuse its fixtures rather than inventing
new ones.

1. `'returns nothing until enough gameweeks have been graded'` — 2 graded gameweeks with
   `minGameweeks: 3` → `[]`.
2. `'corrects upward when the model has been projecting low'` — actuals consistently double the
   projections → factor > 1, and ≤ `maxFactor`.
3. `'corrects downward when the model has been projecting high'` — mirror of the above,
   factor < 1 and ≥ `minFactor`.
4. `'shrinks a thin sample toward no correction at all'` — 20 projections with a large ratio
   produce a factor much closer to 1.0 than 2000 projections with the same ratio. Assert the
   ordering, not exact values.
5. `'clamps a correction that is too large to be a lean'` — actuals 5× projections → factor
   exactly `maxFactor`.
6. `'grades the uncalibrated projection, so the correction cannot feed on itself'` — the
   critical one. Compute a factor, run `buildProjections`, save, grade, recompute. Assert the
   second factor is not further from 1.0 than the first. If this fails you have edge case 2.
7. `'never applies a factor learned under a different model version'` — write a row under
   `'heuristic-0.99.0'`, load under the current version, assert empty.
8. `'projects exactly as before when calibration is disabled'` — run `buildProjections` with
   `enabled: false` against a database that has factors stored, and assert every `xPts` matches
   the run with no factors at all, to 6 decimal places.

---

## Acceptance criteria

- [ ] `npx tsc --noEmit` clean.
- [ ] `npx vitest run` all pass; 8 new tests.
- [ ] Test 6 and test 8 both pass. These are the two that matter — 6 proves the loop is stable,
      8 proves the whole mechanism is switchable off.
- [ ] With `enabled: false`, a full `recommend()` produces byte-identical `xPts` to before this
      change. Verify by stashing the change and diffing `/optimise.json` output.
- [ ] The Accuracy page renders the new section with real numbers, and renders the
      "not enough gameweeks yet" line on a fresh database instead of an empty table.
      Screenshot both.
- [ ] A player whose projection was corrected has a reason string saying so, visible in the
      "why each pick" table on My Team.
- [ ] `modelVersion` bumped, and confirm that bumping it clears the stored factors as intended
      (query `calibration_factor` and confirm the new version has no rows until regraded).

---

## What this plan deliberately does not do

- No per-player calibration. There is nowhere near enough sample per player, and it would
  amount to fitting noise.
- No calibration of the *minutes* model separately from the points model. Worth doing later;
  doing both at once makes it impossible to tell which one helped.
- No automatic tuning of the weights in `model.weights.json`. Those are the model's structure
  and should change deliberately, with a version bump and a commit message explaining why.
