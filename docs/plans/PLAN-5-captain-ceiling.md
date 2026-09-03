> **Executed.** Delivered in `e95f23d` — "Captaincy and Triple Captain on the distribution, not the mean".
>
> Kept for the reasoning, not as outstanding work. Anything below written in the
> present tense ("currently", "today", "does not exist yet") describes the codebase
> *before* that commit. Executed as written. The mean-reconciliation test caught a real bug on its first run: the expected counts handed over are already averaged over whether the player features, so enumerating a separate "did not play" outcome discounted the same thing twice. Fixed by converting the inputs to conditional-on-playing rather than by loosening the tolerance. The plan's page-timing criterion was also mis-read during execution - see the commit.

# PLAN 5 — Captaincy and Triple Captain on the distribution, not the mean

**Rank: 5 of 5.**
**Size: medium-large (new module, ~250 lines, ~10 tests).**
**Type: decision-quality improvement on the highest-stakes weekly choice.**

---

## Goal

The captain scores double. The Triple Captain chip scores treble, once a season. Both decisions
are currently made on **expected points alone**:

- The captain is chosen inside the ILP objective in `selectBestEleven`, weighted by
  `selectionValue`, which is `xPts × confidence × startRisk`. A mean.
- `chips.ts` values Triple Captain as `captainXPts × (tripleMultiplier − captainMultiplier)`.
  Also a mean.

Expected value is the right criterion for the other ten slots, where errors average out across a
season. It is the wrong criterion for a doubled or trebled single pick, where what you actually
want is the *shape* of the distribution — and it is the wrong criterion by a mile for a one-shot
chip, where the whole point is to catch a haul, not to bank an average.

Give the model an explicit distribution per player, then use it: captain by expected points
*with a ceiling tiebreak that actually works*, and Triple Captain by ceiling outright.

---

## Where the captain is actually chosen — read this before touching anything

The captain is **not** picked by the sort in `buildEleven`. It is picked inside the integer
program, in `selectBestEleven` in `src/optimise/squad.ts` (~line 240), as an objective
coefficient:

```ts
...selectable.map((player) => ({
  variable: IS_CAPTAIN(player.playerId),
  coefficient:
    selectionValue(player, weights) * (rules.captain.multiplier - 1) +
    captainBonusFor(player, options),
})),
```

`captainBonusFor` is the horizon-consistency bonus — a small, bounded, upward-only additive
term. **That is the pattern to copy, and that coefficient is where the ceiling term belongs.**
Editing `buildEleven` will not change the captain, and the change will look like it did nothing.

The sort in `buildEleven` (~line 131) picks the **vice-captain** only.

## The three concrete defects

**1. The captain objective has no ceiling term at all.** It is `selectionValue × (multiplier
− 1)` plus a consistency bonus — a pure mean, doubled. Nothing in it distinguishes a striker
with a 25% chance of a double-figure haul from a midfielder who reliably returns 8–10.

**2. The vice-captain's ceiling tiebreak never fires.** `buildEleven`, line ~131:

```ts
.sort(
  (a, b) =>
    selectionValue(b, weights) - selectionValue(a, weights) ||
    (b.breakdown.goals ?? 0) * weights.captain.ceilingWeight - ...
)
```

`selectionValue` returns a float. `||` short-circuits only on exactly `0`, which two
independently computed floats essentially never are. So `weights.captain.ceilingWeight` is dead
config today — it affects nothing, anywhere. Verify this before starting: set it to 0 and to 100
and confirm the whole suite is unchanged either way.

**3. Triple Captain is chosen by mean.** For a chip you get once a season that is the wrong
criterion — you want the week with the best chance of a haul, not the best average.

---

## Files to touch

| File | Change |
|---|---|
| `src/model/distribution.ts` | **New.** Score distribution from the existing breakdown |
| `src/model/xpts.ts` | Return the inputs the distribution needs |
| `src/domain/types.ts` | Add `ceiling` / `haulProbability` to `ProjectedPlayer` |
| `src/optimise/squad.ts` | Ceiling term in the captain ILP objective; fix the vice sort |
| `src/optimise/chips.ts` | Value Triple Captain on ceiling |
| `src/config/schema.ts` + `config/model.weights.json` | New `captain` keys; bump `modelVersion` |
| `src/report/views.ts` | Show ceiling and haul chance for the captain and TC candidates |
| `test/unit/distribution.test.ts` | **New** |
| `test/unit/optimise.test.ts`, `test/unit/chips.test.ts` | Extend |
| `README.md` | New `###` section |

---

## Step-by-step

### Step 1 — The distribution module

Create `src/model/distribution.ts`.

The model already has everything needed. `projectPlayer` computes, per fixture, an expected goal
count (`goalRate × minutesShare × attackScale`), an expected assist count, a clean-sheet
probability and a play probability. Goals and assists are close enough to Poisson for this
purpose, clean sheets are Bernoulli, and appearance points are deterministic given minutes.

`poissonPmf(k, lambda)` is **already exported** from `src/model/xpts.ts`. Reuse it; do not write
a second one.

```ts
export interface ScoreDistribution {
  /** P(final score >= haulThreshold). */
  haulProbability: number;
  /** The 90th-percentile score: a realistic good week, not the theoretical maximum. */
  ceiling: number;
  /** P(score <= 2), the blank risk that matters most for a captain. */
  blankProbability: number;
  /** Sanity check: must be within a rounding error of the player's own xPts. */
  mean: number;
}

/**
 * The distribution of a player's score, not just its mean.
 *
 * Built by enumerating goal and assist counts as independent Poissons around the same rates
 * the points model already uses, then adding the deterministic parts (appearance, clean sheet,
 * bonus, DefCon) at their expected values. Enumeration rather than simulation: the counts that
 * matter are small (0-4 goals covers essentially all of it), so the exact answer is cheaper
 * than a sampled approximation and does not wobble between runs, which matters when a page is
 * regenerated and the reader expects the same numbers back.
 *
 * Goals and assists are treated as independent. They are mildly positively correlated in
 * reality - a player in a team scoring four has more chances at both - which means this
 * slightly understates the top tail. Stated here rather than hidden, and acceptable because
 * the number is used to rank candidates against each other, and the understatement applies to
 * all of them in the same direction.
 */
export function scoreDistribution(
  input: DistributionInput,
  rules: Rules,
  weights: ModelWeights,
): ScoreDistribution
```

`DistributionInput` needs: `expectedGoals`, `expectedAssists` (the per-gameweek totals across
all fixtures, not per-90 rates), `playProbability`, `sixtyPlusProbability`,
`cleanSheetProbability`, `goalPoints`, `assistPoints`, `cleanSheetPoints`, and a `fixedPoints`
figure for everything else (appearance + bonus + DefCon + conceding).

Algorithm:

1. Enumerate `g` from 0 to 5 and `a` from 0 to 3.
2. For each `(g, a)`, `p = poissonPmf(g, expectedGoals) × poissonPmf(a, expectedAssists)`.
3. For each, branch on clean sheet: with probability `cleanSheetProbability × sixtyPlusProbability`
   add `cleanSheetPoints`.
4. Score for that outcome = `fixedPoints + g × goalPoints + a × assistPoints + (cs ? csPoints : 0)`.
5. Multiply every branch's probability by `playProbability`; the remaining
   `1 − playProbability` is a single outcome scoring 0.
6. Accumulate into a `Map<number, number>` of score → probability.
7. `haulProbability` = total probability of score ≥ `weights.captain.haulThreshold`.
8. `ceiling` = the smallest score `s` such that `P(score ≤ s) ≥ 0.90`.
9. `blankProbability` = `P(score ≤ 2)`.
10. `mean` = `Σ score × p`.

Normalise at the end (`Σp` will be slightly under 1 because the Poisson tails are truncated) —
divide every probability by the total before computing the statistics, so `ceiling` is a true
90th percentile of what was enumerated.

### Step 2 — Plumb the inputs through

`projectPlayer` in `src/model/xpts.ts` accumulates `goals` and `assists` as *points* in the
breakdown. The distribution needs the underlying *counts*. Add to the returned `Projection`:

```ts
/** Expected goal and assist counts for the gameweek - the counts, not the points they are
 *  worth. The points model only ever needs the mean; the distribution needs the parameter. */
expectedGoalCount: number;
expectedAssistCount: number;
cleanSheetProbability: number;
```

These are already computed inside the fixture loop — accumulate them into locals alongside
`goals` and `assists` and return them. **Do not recompute them in the distribution module**: two
implementations of the same quantity will drift, and the mean of the distribution must reconcile
with `xPts` (test 1 below depends on it).

### Step 3 — Config

Add to the `captain` block in `src/config/schema.ts` and `config/model.weights.json`:

```json
"captain": {
  "$comment": [
    "The captain scores double and the Triple Captain chip scores treble, once a season, which",
    "makes both the wrong decisions to take on an average alone. haulThreshold 10: a double-",
    "figure return is what a captaincy is actually trying to catch.",
    "ceilingWeight 0.1 with maxCeilingBonus 0.6, applied to how much upside a player carries",
    "beyond his own mean rather than to the raw ceiling - the raw ceiling correlates so strongly",
    "with expected points that using it would just be a second, noisier vote for the same thing.",
    "Capped deliberately: a ceiling breaks a tie between similar bets, it never justifies taking",
    "a worse one. tiebreakEpsilon is the vice-captain sort's definition of near-equal.",
    "tripleCaptainUsesCeiling: a chip you play once is not an expected-value bet. You want the",
    "week with the best chance of a haul, not the best average."
  ],
  "ceilingWeight": 0.1,
  "maxCeilingBonus": 0.6,
  "haulThreshold": 10,
  "tiebreakEpsilon": 0.35,
  "tripleCaptainUsesCeiling": true
}
```

Bump `modelVersion`.

### Step 4a — Add a ceiling term to the captain objective

In `src/optimise/squad.ts`, add alongside `captainBonusFor`:

```ts
/**
 * A small, bounded, upward-only nudge toward a captain with a higher ceiling.
 *
 * The captaincy doubles one player's score, which makes it the one slot where the shape of the
 * distribution matters and not just its mean. Deliberately shaped like the consistency bonus
 * next to it - additive, capped, never negative - so it can separate two candidates the
 * expected-points term already rates as near-equal, without ever overturning a clear difference
 * between them. A ceiling is a reason to prefer one of two similar bets, never a reason to take
 * a worse one.
 */
function captainCeilingBonusFor(player: ProjectedPlayer, weights: ModelWeights): number {
  const excess = Math.max(0, (player.ceiling ?? 0) - player.xPts);
  return Math.min(weights.captain.maxCeilingBonus, excess * weights.captain.ceilingWeight);
}
```

Then add it to the `IS_CAPTAIN` coefficient:

```ts
coefficient:
  selectionValue(player, weights) * (rules.captain.multiplier - 1) +
  captainBonusFor(player, options) +
  captainCeilingBonusFor(player, weights),
```

It is driven by `ceiling - xPts` — how much upside the player carries *beyond his own mean* —
not by the raw ceiling. The raw ceiling correlates strongly with expected points, so using it
directly would just be a second, noisier vote for what the first term already said.

`selectBestEleven` is not the only place this coefficient appears. Grep `IS_CAPTAIN(` and check
every objective that uses it. Apply the same term in all of them, or the squad-build path and
the transfer-plan path will disagree with the XI path about who should wear the armband.

### Step 4b — Fix the vice-captain tiebreak

In `buildEleven`, replace the `||` chain with an explicit epsilon:

```ts
/**
 * Rank vice-captain candidates by risk-adjusted value, with ceiling separating anyone within
 * tiebreakEpsilon of each other.
 *
 * The previous version chained the ceiling comparison after `||`, which short-circuits only on
 * exactly zero - and two independently computed floats are essentially never exactly equal, so
 * the ceiling term was unreachable and captain.ceilingWeight affected nothing at all. An
 * explicit epsilon is what "near-equal" was always meant to mean here.
 */
function compareViceCandidates(
  a: ProjectedPlayer,
  b: ProjectedPlayer,
  weights: ModelWeights,
): number {
  const difference = selectionValue(b, weights) - selectionValue(a, weights);
  if (Math.abs(difference) > weights.captain.tiebreakEpsilon) return difference;
  return (b.ceiling ?? 0) - (a.ceiling ?? 0);
}
```

`ceiling` replaces `breakdown.goals` as the ceiling proxy — that was always a stand-in for the
real thing.

### Step 5 — Triple Captain on ceiling

In `src/optimise/chips.ts`, around line 203:

```ts
tripleCaptainGain =
  captainProjection * (rules.captain.tripleCaptainMultiplier - rules.captain.multiplier);
```

When `weights.captain.tripleCaptainUsesCeiling` is true, use the captain's `ceiling` in place of
`captainProjection` for the *ranking* of candidate gameweeks. Keep reporting the expected-value
figure too — the chips page must show both, because they answer different questions and a reader
who sees only the ceiling will think the app is promising that score.

Add both to whatever shape the chips page renders, labelled "expected" and "if it goes well".

---

## Edge cases a weaker model will get wrong

1. **The distribution's mean must reconcile with `xPts`.** Not exactly — `xPts` includes the
   availability weighting and the differential nudge, which the distribution does not model — but
   the *pre-adjustment* mean must match `xPtsRaw` to within about 0.15 points. If it does not,
   the distribution is modelling a different player from the one being recommended, and every
   number downstream is decorative. Test 1 asserts this. Do not weaken the tolerance to make it
   pass; find the discrepancy.

2. **Double gameweeks.** `input.fixtures` can have two entries, so `expectedGoalCount` is the
   sum across both. A single Poisson over the summed rate is correct for the count. Do not
   enumerate the two fixtures separately unless you also handle the clean-sheet branch twice —
   and if you do, note that two clean sheets are not independent of each other in the way the
   simple version assumes.

3. **Blank gameweeks.** Zero fixtures → all rates 0 → the distribution must return
   `ceiling: 0`, `haulProbability: 0`, and not `NaN`. Guard `poissonPmf(0, 0)`, which should be
   1, and confirm the existing implementation handles `lambda = 0` before relying on it.

4. **Enumeration bounds.** Goals 0–5 covers well past any realistic single-gameweek total for
   one player, but a double gameweek striker with `expectedGoalCount` near 2 has meaningful mass
   at 4 and 5. Do not lower the bound to 3 for speed; this runs a few hundred times per page,
   not a few million.

5. **Normalise before taking percentiles**, not after. Taking the 90th percentile of an
   unnormalised distribution summing to 0.97 silently returns the ~87th percentile.

6. **`ceiling` must be on `ProjectedPlayer`, computed once in `buildProjections`**, not
   recomputed inside the optimiser. `selectBestEleven` is called once per candidate transfer in
   `findTransfers` — that is hundreds of solves, and recomputing distributions inside them would
   turn a fast page into a slow one.

7. **Do not let the ceiling touch `xPts`.** It informs captaincy and chip choice only. `xPts` is
   what the Accuracy page grades, and grading a projection against a number that has been
   ceiling-adjusted would make the model look wrong when it was not.

8. **The vice-captain should not be picked on ceiling the way the captain is.** The armband
   falls to the vice only when the captain does not play — an unlikely branch you would rather
   was safe than spectacular. Use the same comparator but consider whether `ceilingWeight`
   should be halved for the vice. Either choice is defensible; make one deliberately and write
   the reasoning into the code comment.

---

## Tests

**`test/unit/distribution.test.ts`:**
1. `'has a mean that reconciles with the points model'` — edge case 1, ±0.15.
2. `'gives a striker a higher ceiling than a defender at the same expected points'` — the whole
   point of the module.
3. `'gives a nailed-on consistent scorer a lower ceiling than an explosive one at equal xPts'`
4. `'returns zeroes rather than NaN for a blank gameweek'`
5. `'handles a double gameweek without exceeding the enumeration bounds'` — assert probabilities
   still sum to ~1 before normalisation (≥ 0.99).

**`test/unit/optimise.test.ts`:**
6. `'prefers the higher-ceiling captain between two near-equal candidates'` — two starters
   whose `selectionValue` differs by well under a point, one carrying much more upside beyond
   his own mean. Assert the higher-ceiling player is captain. **This test must fail before
   Step 4a** — verify that. If it passes without Step 4a you have almost certainly edited
   `buildEleven` (which picks the vice) rather than the ILP objective (which picks the captain);
   re-read "Where the captain is actually chosen".
7. `'does not let ceiling overturn a clear difference in expected points'` — a two-point gap in
   expected points with the ceiling favouring the lower player. Assert expected points wins.
   This is what `maxCeilingBonus` exists for.
8. `'separates two near-equal vice-captains by ceiling'` — the `buildEleven` path from Step 4b.
   This one *does* fail against the old `||` comparator.

**`test/unit/chips.test.ts`:**
9. `'picks the Triple Captain week by ceiling, not by average'` — two gameweeks, one with a
   higher expected captain score and one with a higher ceiling. Assert the ceiling week is
   recommended when `tripleCaptainUsesCeiling` is true.
10. `'reports both the expected and the good-case figure'` — assert both appear in the output.
11. `'falls back to expected value when tripleCaptainUsesCeiling is false'`.

---

## Acceptance criteria

- [ ] `npx tsc --noEmit` clean; `npx vitest run` all pass, 11 new tests.
- [ ] Test 6 fails before Step 4a, and test 8 fails before Step 4b. Verify both by stashing.
      A test that passes before and after is testing nothing.
- [ ] `weights.captain.ceilingWeight` demonstrably affects output: set it to 0 and to 5 and
      confirm the captain changes in the test 6 fixture. It is currently dead config; the point
      of this plan is that it stops being so.
- [ ] Page timing does not regress: time `/optimise` before and after. An increase beyond ~15%
      means edge case 6 was missed and distributions are being computed inside the transfer
      search.
- [ ] The Chips page shows both the expected and good-case captain figure, clearly labelled so
      neither reads as a promise.
- [ ] README gains a section explaining why a doubled pick is not an expected-value decision,
      what the ceiling is (a 90th percentile, not a maximum), and the independence assumption
      between goals and assists with its known direction of error.

---

## Why this is fifth, not first

It is the most speculative of the five. Plans 1 and 2 fix things that are demonstrably wrong;
plan 3 supplies data the app is currently guessing; plan 4 is cheap insurance. This one improves
a judgement call that is already defensible, and its benefit is real but harder to verify — you
will not be able to prove it helped from a handful of gameweeks. Do it once the foundations
underneath it are sound, and once calibration is measuring whether changes to the model actually
help.
