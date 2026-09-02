# PLAN 1 — Shrink the last-season anchor by its own sample size

**Rank: 1 of 5. Do this first.**
**Size: small (one function, ~30 lines changed, 4 tests).**
**Type: correctness bug, currently live in production.**

---

## Goal

`heuristic-0.15.0` changed thin per-90 rates to shrink toward **the player's own last-season
per-90** instead of toward zero. That direction is right and must be kept. But the anchor it
shrinks toward is taken at **full face value regardless of how many minutes it came from**, and
then given the weight of 900 or 2700 minutes of evidence. A player who played 200 minutes last
season and happened to score twice is currently treated as a proven ~0.9 goals-per-90 threat,
and that fiction then dominates his whole projection.

Fix: shrink the anchor itself, by the minutes behind it, toward the position's baseline rate,
before using it as the anchor for this season.

### Why this is the first job

Every other plan in this set consumes projections. Plan 2 (calibration) in particular learns
correction factors *from* projection error — calibrating on top of this bug would bake the bug
into the learned constants. Fix the input before building anything that learns from it.

---

## The exact bug

`src/model/build.ts`, around line 379, inside `buildProjections()`:

```ts
const anchor = lastSeason.get(row.playerId);
const anchorMinutes = anchor?.minutes ?? 0;
const anchorRate = (total: number | null): number | null =>
  anchor === undefined || anchorMinutes <= 0 ? null : per90(total, anchorMinutes);
```

`per90(total, anchorMinutes)` is a raw division. No shrinkage. A 200-minute sample and a
3000-minute sample produce equally confident anchors.

That anchor is then passed to `shrinkRate` (line ~150) as `priorRate`:

```ts
return (rate * mins + anchor * priorWeightMinutes) / (mins + priorWeightMinutes);
```

with `priorWeightMinutes` of 900 (or 2700 for GKP/DEF goal involvement). So a 200-minute
last-season sample is asserted with the confidence of ten to thirty full matches.

### Worked example (use this to sanity-check your fix)

Forward. Last season: 2 goals in 200 minutes → raw anchor 0.90 goals/90.
This season: 1 goal in 180 minutes → raw 0.50 goals/90. `priorWeightMinutes` = 900.

- **Now (buggy):** `(0.50×180 + 0.90×900) / 1080` = **0.834**
- **After the fix**, with the anchor itself shrunk over 900 minutes toward a 0.35 FWD baseline:
  anchor becomes `(0.90×200 + 0.35×900) / 1100` = 0.464, so the final rate is
  `(0.50×180 + 0.464×900) / 1080` = **0.470**

The buggy version reports a player who has scored three goals in his life as a near-elite
scorer. The fixed version says "slightly above an average forward", which is what the evidence
supports.

---

## Files to touch

| File | Change |
|---|---|
| `src/model/build.ts` | Add `shrinkAnchorRate()`; use it in `anchorRate`; add baseline lookup |
| `src/config/schema.ts` | Add `attacking.anchorPriorWeightMinutes` and `attacking.positionBaselineRates` |
| `config/model.weights.json` | Add the two new keys with `$comment`; bump `modelVersion` |
| `test/unit/history.test.ts` | Add 4 tests (names given below) |
| `README.md` | Add a paragraph under the existing anchoring section |

Do **not** touch `src/model/xpts.ts`, `src/optimise/squad.ts` or any view file. The bug is
entirely upstream of them.

---

## Step-by-step

### Step 1 — Add the config keys

In `src/config/schema.ts`, find the `attacking` object in the model-weights schema (it already
contains `priorWeightMinutes` and `lowThreatPriorWeightMinutes`). Add:

```ts
/**
 * How many minutes of last-season evidence it takes to half-trust that season's own per-90
 * rate as an anchor for this season. The anchor is a prior, and a prior built from a thin
 * sample is not a strong prior - it is a guess wearing a prior's clothes. Without this, two
 * goals in 200 minutes last season anchored a player at 0.9 goals per 90 and then asserted
 * that with the weight of ten full matches.
 */
anchorPriorWeightMinutes: positiveNumber,

/**
 * What a thin last-season sample shrinks toward, per position: roughly what an average
 * player in that position does per 90. Not zero - "we know almost nothing about this
 * player" should resolve to "assume he is ordinary for his position", not "assume he
 * cannot play". Keys must match the position short names in rules.json.
 */
positionBaselineRates: z.record(z.string(), z.object({
  goals: nonNegativeNumber,
  assists: nonNegativeNumber,
  saves: nonNegativeNumber,
  defensiveContribution: nonNegativeNumber,
  bonus: nonNegativeNumber,
})),
```

Match the existing validator helper names in that file exactly — read the surrounding lines and
reuse whatever `positiveNumber` / `nonNegativeNumber` are actually called there. Do not invent
new helper names.

### Step 2 — Add the values

In `config/model.weights.json`, inside `"attacking"`, after `"lowThreatPriorWeightMinutes"`:

```json
"anchorPriorWeightMinutes": 900,
"positionBaselineRates": {
  "GKP": { "goals": 0.0,  "assists": 0.01, "saves": 3.0, "defensiveContribution": 0.0,  "bonus": 0.25 },
  "DEF": { "goals": 0.05, "assists": 0.06, "saves": 0.0, "defensiveContribution": 9.0,  "bonus": 0.20 },
  "MID": { "goals": 0.15, "assists": 0.14, "saves": 0.0, "defensiveContribution": 7.0,  "bonus": 0.25 },
  "FWD": { "goals": 0.35, "assists": 0.12, "saves": 0.0, "defensiveContribution": 3.0,  "bonus": 0.30 }
}
```

Add a `$comment` entry to the `attacking.$comment` array explaining both keys, in the same
voice as the entries already there (the existing comments explain *why*, not *what* — match
that).

Bump `"modelVersion"` from `"heuristic-0.15.0"` to `"heuristic-0.16.0"`. This is a real scoring
change, so the bump is mandatory — stored projections carry the version they were made under and
the Accuracy page groups by it.

### Step 3 — Add the shrink function

In `src/model/build.ts`, directly below the existing `shrinkRate` function, add:

```ts
/**
 * Shrink a previous-season per-90 by the minutes behind it, toward the position's baseline.
 *
 * The anchor is the prior this season's thin evidence updates away from, and it has to earn
 * that status. Two goals in 200 minutes is not evidence of a 0.9-per-90 threat, and handing
 * that number to shrinkRate at the weight of ten full matches asserts it far more strongly
 * than the raw sample ever supported. Same Bayesian shape as shrinkRate itself, one level up:
 * the anchor is a rate with a sample size like any other.
 */
function shrinkAnchorRate(
  rate: number | null,
  minutes: number,
  baseline: number,
  priorWeightMinutes: number,
): number | null {
  if (rate === null) return null;
  return (rate * minutes + baseline * priorWeightMinutes) / (minutes + priorWeightMinutes);
}
```

### Step 4 — Use it

Replace the `anchorRate` closure (around line 379) with:

```ts
const anchor = lastSeason.get(row.playerId);
const anchorMinutes = anchor?.minutes ?? 0;
const baselines = weights.attacking.positionBaselineRates[row.position] ?? null;

/**
 * `baselineKey` names which baseline this stat shrinks toward. A stat with no baseline for
 * this position - or a position the config does not list at all - falls back to 0, which is
 * the old behaviour and the honest answer when there is nothing better to say.
 */
const anchorRate = (
  total: number | null,
  baselineKey: 'goals' | 'assists' | 'saves' | 'defensiveContribution' | 'bonus',
): number | null => {
  if (anchor === undefined || anchorMinutes <= 0) return null;
  const baseline = baselines?.[baselineKey] ?? 0;
  return shrinkAnchorRate(
    per90(total, anchorMinutes),
    anchorMinutes,
    baseline,
    weights.attacking.anchorPriorWeightMinutes,
  );
};
```

### Step 5 — Pass the baseline key at every call site

`anchorRate` is called once, inside the `rate` closure:

```ts
const priorRate = anchorTotal === undefined ? 0 : anchorRate(anchorTotal);
```

`rate` needs a new parameter for the key. Change its signature (currently ends with
`anchorTotal?: number | null`) to also take `anchorBaseline`:

```ts
const rate = (
  total: number | null,
  recentField: (r: RecentFixtureRow) => number | null,
  recentWeight: number,
  priorWeightMinutesOverride: number = priorMins,
  anchorTotal?: number | null,
  anchorBaseline?: 'goals' | 'assists' | 'saves' | 'defensiveContribution' | 'bonus',
): number | null => {
```

and inside it:

```ts
const priorRate =
  anchorTotal === undefined || anchorBaseline === undefined ? 0 : anchorRate(anchorTotal, anchorBaseline);
```

Then update the seven call sites. They are contiguous, at `src/model/build.ts` lines 482-488,
and all match `grep -n "Per90: rate(" src/model/build.ts` — that grep must return exactly 7
lines before and after your change. The mapping is:

| Field | 5th arg (already there) | New 6th arg |
|---|---|---|
| `xgPer90` | `anchor?.expectedGoals` | `'goals'` |
| `xaPer90` | `anchor?.expectedAssists` | `'assists'` |
| `goalsPer90` | `anchor?.goals` | `'goals'` |
| `assistsPer90` | `anchor?.assists` | `'assists'` |
| `savesPer90` | `anchor?.saves` | `'saves'` |
| `defconPer90` | `anchor?.defensiveContribution` | `'defensiveContribution'` |
| `bonusPer90` | `anchor?.bonus` | `'bonus'` |

Note `xgPer90` uses the `'goals'` baseline and `xaPer90` uses `'assists'`. That is deliberate:
xG and goals are the same quantity measured two ways, and the baselines above are set for the
underlying rate, not for the specific column.

---

## Edge cases a weaker model will get wrong

1. **Do not change the `usingPrevious` branch.** Inside `rate`, the first branch is
   `if (usingPrevious) { return shrinkRate(...) }`. When the model is *using* last season's rate
   as the rate itself (a player with no minutes this season, before the season is under way),
   there is nothing separate to anchor it to, and `shrinkRate` already shrinks it by its own
   minutes. Adding an anchor there would shrink the same sample twice. Leave it exactly as is.

2. **A position missing from `positionBaselineRates` must not throw.** `rules.json` reconciles
   positions against whatever the live API declares (see `reconcilePositions`), so a position
   code could appear that the config does not list. `baselines?.[baselineKey] ?? 0` handles it —
   keep the `?? 0`, and do not switch to a non-null assertion.

3. **`anchorMinutes` of exactly 0 must return `null`, not `NaN`.** The guard
   `anchorMinutes <= 0` already does this. If you refactor, keep it. `per90(x, 0)` would divide
   by zero.

4. **Do not shrink toward the baseline when the anchor is genuinely absent.** A player with no
   last-season row at all returns `null`, which `shrinkRate` reads as an anchor of 0. That is
   correct and deliberate: an unknown player is not the same as an average player, because he
   may not play at all. Do not "improve" this by substituting the baseline.

5. **The config keys must be added to the schema before the JSON.** The config loader is
   strict — an unrecognised key fails the load, so adding the JSON first breaks every test with
   a confusing error. Schema first, then JSON.

6. **`positionBaselineRates` is a record, not an array.** Zod records need both key and value
   schemas in the version this repo pins. Check how other records are declared in
   `src/config/schema.ts` and match that call shape exactly.

7. **DefCon baselines are in CBIT units per 90, not points.** 9.0 for a defender is roughly the
   threshold in `rules.json`; 3.0 for a forward is well below it. Do not "correct" these to
   look like point values.

---

## Tests

Add to `test/unit/history.test.ts`, alongside the existing test
`"anchors a thin rate to the player's own last season, not to zero"` (which must keep passing).

Use the existing `pastSeason()` helper in that file; read how the existing test builds two
players with identical this-season lines and differing `history_past`, and copy that shape.

1. **`'does not treat a thin last season as a proven rate'`**
   Two forwards, identical this season (1 goal, 90 min, xG 0.9). Player A: 2 goals in 200
   minutes last season. Player B: 22 goals in 3000 minutes last season. Assert
   `B.breakdown.goals! > A.breakdown.goals! * 1.5` — B's anchor survives shrinkage, A's largely
   does not. (Under the current bug the two are near-identical, so this test fails before the
   fix and passes after. Verify that.)

2. **`'shrinks a thin last season toward its position, not toward zero'`**
   One forward with 2 goals in 200 minutes last season, and one defender with the same 2 goals
   in 200 minutes. Assert `forward.breakdown.goals! > defender.breakdown.goals!`. The forward
   falls back to a 0.35 baseline, the defender to 0.05.

3. **`'leaves a full last season almost untouched'`**
   A forward with 22 goals in 3000 minutes. Compute the raw per-90 (22/3000×90 = 0.66) and
   assert the effective anchor retains most of it: the resulting `breakdown.goals` must be
   within 25% of what the same player produces when `anchorPriorWeightMinutes` is set very low
   (e.g. 1). Load a modified weights object in the test rather than editing the config file.

4. **`'projects a player with no last-season history at all without throwing'`**
   A player with an empty `history_past`. Assert the projection is produced, `breakdown.goals`
   is a finite number, and it is not `NaN`.

Write the *reasoning* into each test body as a comment, in the style of the existing tests in
this repo — they explain why the assertion is the right one, not what the code does.

---

## Acceptance criteria

Run these exactly. All must hold.

- [ ] `npx tsc --noEmit` — clean, no output.
- [ ] `npx vitest run` — all tests pass, and the total count is **4 higher** than before.
- [ ] Test 1 above **fails** if you temporarily revert `anchorRate` to the old raw `per90` form.
      (Do this check. A test that passes both before and after is not testing the fix. Restore
      the fix afterwards — use `git stash` / `git stash pop`, never `git checkout --`, which
      discards uncommitted work.)
- [ ] `config/model.weights.json` has `"modelVersion": "heuristic-0.16.0"`.
- [ ] `grep -c "anchorRate(" src/model/build.ts` returns `2` (one definition, one call).
- [ ] Setting `anchorPriorWeightMinutes` to `0` in a locally-loaded weights object reproduces
      the old behaviour exactly. Confirm with a quick throwaway assertion, then delete it. This
      proves the change is a strict generalisation with a switch, not a rewrite.
- [ ] README has a paragraph under the existing "shrinkage now has the right anchor" section
      explaining that the anchor is itself shrunk, with the worked example above.

---

## Commit

Direct to `main` (this repo has no PR flow; Render auto-deploys on push). Message must explain
the mechanism and the arithmetic, not just the change — match the existing commit style in
`git log`. Do not mention any model or assistant name in the commit.
