import type { ModelWeights } from '../config/schema.js';
import { poissonPmf, type Projection } from './xpts.js';

/**
 * A player's score distribution, not just its mean.
 *
 * Expected points is the right basis for ten of the eleven slots, where errors average out over
 * a season. It is the wrong basis for the captaincy, which doubles one pick, and badly wrong for
 * the Triple Captain chip, which trebles one pick once a season: what you want there is the
 * chance of a haul, not the best average. Two players projected at 9.0 are not the same bet when
 * one is a striker with a real chance of fifteen and the other is a midfielder who reliably
 * returns eight to ten.
 */

export interface ScoreDistribution {
  /** P(score >= captain.haulThreshold). */
  haulProbability: number;
  /** The 90th-percentile score: a realistic good week, not the theoretical maximum. */
  ceiling: number;
  /** P(score <= 2). The blank risk, which is what a doubled pick most has to avoid. */
  blankProbability: number;
  /** Should reconcile with the projection's own xPtsRaw - see the test that asserts it does. */
  mean: number;
}

/** How far to enumerate. Well past any realistic single-gameweek return, double gameweeks included. */
const MAX_GOALS = 5;
const MAX_ASSISTS = 3;

/**
 * Build the distribution by enumerating goal and assist counts as independent Poissons around
 * exactly the rates the points model already used, then adding the deterministic parts.
 *
 * Enumerated rather than simulated: the counts that matter are small, so the exact answer is
 * cheaper than a sampled approximation and does not wobble between runs - which matters when a
 * page is regenerated and the reader expects the same numbers back.
 *
 * Goals and assists are treated as independent. They are mildly positively correlated in reality
 * (a player in a team scoring four has more chances at both), so this slightly understates the
 * top tail. Stated rather than hidden, and acceptable because the figure is used to rank
 * candidates against each other and the understatement applies to all of them the same way.
 */
export function scoreDistribution(
  projection: Projection,
  weights: ModelWeights,
): ScoreDistribution | null {
  const input = projection.distributionInput;
  if (input === undefined) return null;

  const outcomes = new Map<number, number>();
  const add = (score: number, probability: number): void => {
    if (probability <= 0) return;
    // Rounded to a tenth: floating-point scores that differ in the twelfth decimal are the same
    // outcome, and left unrounded they would each get their own bucket and break the percentile.
    const key = Math.round(score * 10) / 10;
    outcomes.set(key, (outcomes.get(key) ?? 0) + probability);
  };

  const play = input.playProbability;
  if (play <= 0) return null;

  // Every quantity the points model hands over is already averaged over whether the player
  // features - expected minutes are baked into the rates, and the appearance and DefCon terms
  // carry their own play and start probabilities. Enumerating a "did not play" outcome on top of
  // that would discount the same thing twice and understate the whole distribution, so the
  // inputs are first divided back out into what they would be *given that he plays*. The
  // enumeration then re-applies the probability once, in the right place, where it can also
  // produce the explicit blank that a doubled pick most needs priced in.
  const givenPlaying = (value: number) => value / play;
  const goalMean = givenPlaying(input.expectedGoalCount);
  const assistMean = givenPlaying(input.expectedAssistCount);
  const fixed = givenPlaying(input.fixedPoints);
  const csProbability = Math.min(1, Math.max(0, givenPlaying(input.cleanSheetProbability)));

  // Each Poisson term computed once and reused across the grid, rather than recomputed in every
  // cell of it: 10 exp/log calls per player instead of 48. Measured at no meaningful difference
  // to a page load - the whole distribution costs well under a millisecond per player - so this
  // is tidiness, not a hot path.
  const goalPmf = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(k, goalMean));
  const assistPmf = Array.from({ length: MAX_ASSISTS + 1 }, (_, k) => poissonPmf(k, assistMean));

  for (let goals = 0; goals <= MAX_GOALS; goals += 1) {
    const pGoals = goalPmf[goals]!;
    if (pGoals <= 0) continue;
    for (let assists = 0; assists <= MAX_ASSISTS; assists += 1) {
      const pAssists = assistPmf[assists]!;
      if (pAssists <= 0) continue;

      const base = fixed + goals * input.goalPoints + assists * input.assistPoints;
      const joint = pGoals * pAssists * play;

      if (input.cleanSheetPoints > 0 && csProbability > 0) {
        add(base + input.cleanSheetPoints, joint * csProbability);
        add(base, joint * (1 - csProbability));
      } else {
        add(base, joint);
      }
    }
  }

  // Not playing at all is a single outcome scoring nothing, and it is the outcome a captaincy
  // most needs to price in.
  add(0, 1 - play);

  const total = [...outcomes.values()].reduce((sum, p) => sum + p, 0);
  if (total <= 0) return null;

  // Normalised before any percentile is taken: the Poisson tails are truncated, so the mass sums
  // slightly under 1, and the 90th percentile of an unnormalised distribution is not the 90th.
  const sorted = [...outcomes.entries()]
    .map(([score, p]) => [score, p / total] as const)
    .sort((a, b) => a[0] - b[0]);

  let cumulative = 0;
  let ceiling = sorted[sorted.length - 1]![0];
  let ceilingFound = false;
  let blankProbability = 0;
  let haulProbability = 0;
  let mean = 0;

  for (const [score, p] of sorted) {
    cumulative += p;
    mean += score * p;
    if (score <= 2) blankProbability += p;
    if (score >= weights.captain.haulThreshold) haulProbability += p;
    if (!ceilingFound && cumulative >= 0.9) {
      ceiling = score;
      ceilingFound = true;
    }
  }

  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    haulProbability: round(haulProbability),
    ceiling: round(ceiling),
    blankProbability: round(blankProbability),
    mean: round(mean),
  };
}
