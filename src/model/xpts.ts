import type { ModelWeights, Rules } from '../config/schema.js';
import type { Availability } from '../domain/availability.js';

/**
 * The expected-points model.
 *
 * Deliberately a transparent weighted heuristic rather than a black box: every component is a
 * named number in the returned breakdown, every constant lives in config/model.weights.json,
 * and the whole thing is a pure function of its inputs. That makes it testable in isolation and
 * means any recommendation can be explained back to the numbers that produced it.
 *
 * A statistical model can be swapped in later behind the same signature.
 */

export interface FixtureContext {
  /** Attacking strength of the player's own club, from the API's team ratings. */
  teamAttack: number;
  /** Defensive strength of the player's own club. */
  teamDefence: number;
  opponentAttack: number;
  opponentDefence: number;
  isHome: boolean;
  opponentShort: string;
  /** The API's fixture difficulty rating, carried through for explanation only. */
  difficulty: number | null;
}

export interface PlayerModelInput {
  playerId: number;
  name: string;
  position: string;
  availability: Availability;
  /** Percentage of managers who own the player, for the differential knob. */
  ownership: number | null;

  /** Minutes played across the matches we have history for. */
  minutesPlayed: number;
  /** Number of matches in that history (appearances and non-appearances alike). */
  matchesAvailable: number;
  /** Matches the player started. */
  starts: number;

  /** Per-90 rates. Null when the API does not supply the stat - never treated as zero. */
  xgPer90: number | null;
  xaPer90: number | null;
  goalsPer90: number | null;
  assistsPer90: number | null;
  savesPer90: number | null;
  defconPer90: number | null;
  bonusPer90: number | null;

  /** The fixtures this player's club plays in the gameweek. Empty = blank, two = double. */
  fixtures: FixtureContext[];

  /**
   * True when the per-90 rates above come from a previous season rather than this one.
   * Early in a season that is the honest source of evidence, but it must be visible in the
   * explanation and reflected in confidence - squads and roles change over a summer.
   */
  usingPreviousSeason?: boolean;
  previousSeasonName?: string | null;
  /** Total points in that previous season, for the explanation. */
  previousSeasonPoints?: number | null;
  /** Minutes behind those rates. A per-90 rate from 90 minutes is noise, not evidence. */
  previousSeasonMinutes?: number | null;

  /**
   * The FPL API's own expected-points figure (ep_next), used only as a fallback.
   *
   * At the start of a season every season-to-date stat is zero, so a form-based model has
   * nothing to separate players by and would rank on noise. Rather than pretend otherwise,
   * the projection falls back to this and reports low confidence.
   */
  fallbackExpectedPoints?: number | null;
}

export interface Projection {
  playerId: number;
  xPts: number;
  xPtsRaw: number;
  expectedMinutes: number;
  breakdown: Record<string, number>;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

/** Poisson probability of exactly k events given mean lambda. */
export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i += 1) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Expected goals for a club in one fixture, from the two clubs' strength ratings.
 * A ratio of attack to opposing defence, scaled by the league average and home advantage.
 */
export function expectedTeamGoals(
  attack: number,
  opponentDefence: number,
  isHome: boolean,
  weights: ModelWeights,
): number {
  const { teamStrength } = weights;
  const safeAttack = attack > 0 ? attack : teamStrength.fallbackStrength;
  const safeDefence = opponentDefence > 0 ? opponentDefence : teamStrength.fallbackStrength;

  const ratio = (safeAttack / safeDefence) ** teamStrength.strengthExponent;
  const venue = isHome ? teamStrength.homeAdvantage : teamStrength.awayFactor;
  const goals = teamStrength.leagueAverageGoalsPerGame * ratio * venue;

  return Math.min(teamStrength.maxExpectedGoals, Math.max(teamStrength.minExpectedGoals, goals));
}

/** Probability of a clean sheet: the Poisson chance of conceding zero, clamped. */
export function cleanSheetProbability(expectedConceded: number, weights: ModelWeights): number {
  const raw = poissonPmf(0, expectedConceded);
  return Math.min(weights.cleanSheet.maxProbability, Math.max(weights.cleanSheet.minProbability, raw));
}

/**
 * Expected points deducted for goals conceded: -1 per 2 conceded, so the expectation is
 * over floor(k/2) rather than simply half the expected goals.
 */
export function expectedConcedingPenalty(
  expectedConceded: number,
  rules: Rules,
): number {
  const { perGoals, points } = rules.scoring.goalsConceded;
  let expectedBands = 0;
  for (let k = 0; k <= 10; k += 1) {
    expectedBands += Math.floor(k / perGoals) * poissonPmf(k, expectedConceded);
  }
  return expectedBands * points;
}

export interface MinutesProjection {
  startProbability: number;
  playProbability: number;
  sixtyPlusProbability: number;
  expectedMinutes: number;
}

/**
 * How much football we expect the player to get.
 *
 * The start rate is shrunk toward a prior, so one appearance cannot produce a confident
 * projection. Everything else in the model scales off this.
 */
export function projectMinutes(
  input: PlayerModelInput,
  weights: ModelWeights,
): MinutesProjection {
  const { minutes } = weights;
  const observedStarts = input.starts;
  const observedMatches = input.matchesAvailable;

  // Bayesian shrinkage toward the prior start probability.
  const startProbability =
    (observedStarts + minutes.priorStartProbability * minutes.priorWeightMatches) /
    (observedMatches + minutes.priorWeightMatches || 1);

  const clampedStart = Math.min(1, Math.max(0, startProbability));
  const benchAppearance = (1 - clampedStart) * minutes.benchAppearanceProbability;

  return {
    startProbability: clampedStart,
    playProbability: Math.min(1, clampedStart + benchAppearance),
    sixtyPlusProbability: clampedStart * minutes.starterCompletesSixty,
    expectedMinutes:
      clampedStart * minutes.expectedMinutesIfStarting +
      benchAppearance * minutes.expectedMinutesIfBenched,
  };
}

/** Probability of reaching the DefCon threshold, from the player's per-90 rate. */
export function defconProbability(
  ratePer90: number | null,
  threshold: number | null,
  weights: ModelWeights,
): number {
  if (threshold === null) return 0;
  if (ratePer90 === null) return weights.defensiveContribution.fallbackProbability;
  // Logistic around the threshold: a player averaging exactly the threshold is a coin flip.
  const z = (ratePer90 - threshold) * weights.defensiveContribution.steepness;
  return 1 / (1 + Math.exp(-z));
}

function blendRate(
  primary: number | null,
  secondary: number | null,
  primaryWeight: number,
): number | null {
  if (primary === null && secondary === null) return null;
  if (primary === null) return secondary;
  if (secondary === null) return primary;
  return primary * primaryWeight + secondary * (1 - primaryWeight);
}

/**
 * Project one player's expected points for the upcoming gameweek.
 *
 * Handles blanks (no fixture -> zero) and doubles (two fixtures -> both counted) naturally,
 * because it sums over whatever fixtures the club actually has.
 */
export function projectPlayer(
  input: PlayerModelInput,
  weights: ModelWeights,
  rules: Rules,
): Projection {
  const breakdown: Record<string, number> = {};
  const reasons: string[] = [];
  const minutes = projectMinutes(input, weights);

  if (input.fixtures.length === 0) {
    return {
      playerId: input.playerId,
      xPts: 0,
      xPtsRaw: 0,
      expectedMinutes: 0,
      breakdown: { blank: 0 },
      confidence: 'high',
      reasons: ['No fixture this gameweek (blank)'],
    };
  }

  // No season history at all - typically gameweek 1. Every rate is zero or absent, so a
  // form-based projection would just be noise dressed up as a number.
  const hasNoHistory =
    input.minutesPlayed <= 0 &&
    input.xgPer90 === null &&
    input.goalsPer90 === null &&
    input.xaPer90 === null;

  if (hasNoHistory && input.fallbackExpectedPoints != null) {
    const perFixture = input.fallbackExpectedPoints;
    const raw = perFixture * input.fixtures.length;
    return {
      playerId: input.playerId,
      xPts: round(Math.max(0, raw * input.availability.probability)),
      xPtsRaw: round(raw),
      expectedMinutes: round(minutes.expectedMinutes),
      breakdown: { fplExpectedPoints: round(raw) },
      confidence: 'low',
      reasons: [
        `No season history yet, so this uses the FPL API's own expected-points figure ` +
          `(${perFixture.toFixed(1)} per fixture) rather than form. Treat early-season ` +
          `projections as rough.`,
        ...input.fixtures.map(
          (fx) =>
            `${fx.isHome ? 'vs' : 'away to'} ${fx.opponentShort}` +
            (fx.difficulty !== null ? ` (FDR ${fx.difficulty})` : ''),
        ),
      ],
    };
  }

  const scoring = rules.scoring;
  const goalPoints = scoring.goal[input.position] ?? 0;
  const cleanSheetPoints = scoring.cleanSheet[input.position] ?? 0;
  const concedingApplies = scoring.goalsConceded.appliesTo.includes(input.position);
  const savesApply = scoring.saves.appliesTo.includes(input.position);
  const defconThreshold = scoring.defensiveContribution.thresholds[input.position] ?? null;

  // Attacking rates: prefer expected stats, which stabilise faster than raw goals.
  const goalRate = blendRate(input.xgPer90, input.goalsPer90, weights.attacking.xgWeight);
  const assistRate = blendRate(input.xaPer90, input.assistsPer90, weights.attacking.xgWeight);

  let appearance = 0;
  let goals = 0;
  let assists = 0;
  let cleanSheets = 0;
  let conceding = 0;
  let saves = 0;
  let defcon = 0;
  let bonus = 0;

  for (const fixture of input.fixtures) {
    const teamGoals = expectedTeamGoals(fixture.teamAttack, fixture.opponentDefence, fixture.isHome, weights);
    const teamConceded = expectedTeamGoals(
      fixture.opponentAttack,
      fixture.teamDefence,
      !fixture.isHome,
      weights,
    );

    // How favourable this fixture is, relative to an average one.
    const attackScale =
      1 +
      weights.attacking.fixtureScalingWeight *
        (teamGoals / weights.teamStrength.leagueAverageGoalsPerGame - 1);

    const minutesShare = minutes.expectedMinutes / 90;

    appearance +=
      minutes.sixtyPlusProbability * scoring.appearance.sixtyPlusMinutes +
      Math.max(0, minutes.playProbability - minutes.sixtyPlusProbability) * scoring.appearance.anyMinutes;

    if (goalRate !== null) {
      goals += goalRate * minutesShare * attackScale * goalPoints;
    }
    if (assistRate !== null) {
      assists += assistRate * minutesShare * attackScale * scoring.assist;
    }

    if (cleanSheetPoints > 0) {
      // A clean sheet only pays if the player is on the pitch for 60 minutes.
      cleanSheets +=
        cleanSheetProbability(teamConceded, weights) *
        cleanSheetPoints *
        minutes.sixtyPlusProbability;
    }

    if (concedingApplies) {
      conceding += expectedConcedingPenalty(teamConceded, rules) * minutes.sixtyPlusProbability;
    }

    if (savesApply) {
      const saveRate =
        input.savesPer90 ?? teamConceded * weights.saves.savesPerExpectedGoalConceded;
      saves += (saveRate * minutesShare * scoring.saves.points) / scoring.saves.perSaves;
    }

    if (defconThreshold !== null) {
      defcon +=
        defconProbability(input.defconPer90, defconThreshold, weights) *
        scoring.defensiveContribution.points *
        minutes.startProbability;
    }

    if (input.bonusPer90 !== null) {
      bonus += Math.min(
        weights.bonus.maxExpectedBonus,
        input.bonusPer90 * minutesShare * weights.bonus.shrinkage,
      );
    }

    reasons.push(
      `${fixture.isHome ? 'vs' : 'away to'} ${fixture.opponentShort}` +
        (fixture.difficulty !== null ? ` (FDR ${fixture.difficulty})` : '') +
        `: team xG ${teamGoals.toFixed(2)}, xGA ${teamConceded.toFixed(2)}`,
    );
  }

  breakdown.appearance = round(appearance);
  breakdown.goals = round(goals);
  breakdown.assists = round(assists);
  breakdown.cleanSheet = round(cleanSheets);
  breakdown.goalsConceded = round(conceding);
  breakdown.saves = round(saves);
  breakdown.defensiveContribution = round(defcon);
  breakdown.bonus = round(bonus);

  let xPtsRaw = appearance + goals + assists + cleanSheets + conceding + saves + defcon + bonus;

  // Differential adjustment (open decision D4). Off by default: weight 0 means pure
  // expected-points maximisation. It never gates a selection, only nudges the ordering.
  const { differential } = weights;
  if (differential.weight > 0 && input.ownership !== null) {
    const below = Math.max(0, differential.ownershipPivot - input.ownership);
    const adjustment = Math.min(
      differential.maxAdjustment,
      (below / differential.ownershipPivot) * differential.weight,
    );
    breakdown.differential = round(adjustment);
    xPtsRaw += adjustment;
    if (adjustment > 0) {
      reasons.push(`Differential bonus: owned by ${input.ownership.toFixed(1)}% of managers`);
    }
  }

  const xPts = xPtsRaw * input.availability.probability;

  if (input.usingPreviousSeason) {
    reasons.unshift(
      `Rates are from ${input.previousSeasonName ?? 'last season'}` +
        (input.previousSeasonPoints != null ? ` (${input.previousSeasonPoints} points)` : '') +
        (input.previousSeasonMinutes != null ? ` over ${input.previousSeasonMinutes} minutes` : '') +
        ' because this season has no minutes yet - treat with caution, roles change over a summer.',
    );
    if ((input.previousSeasonMinutes ?? 0) < 900) {
      reasons.push(
        `Small sample: only ${input.previousSeasonMinutes ?? 0} minutes last season, so these ` +
          'rates are heavily damped and this projection is low confidence.',
      );
    }
  }

  if (input.availability.probability < 1) {
    reasons.push(
      `Weighted to ${Math.round(input.availability.probability * 100)}% for availability: ${input.availability.reason}`,
    );
  }

  return {
    playerId: input.playerId,
    xPts: round(Math.max(0, xPts)),
    xPtsRaw: round(xPtsRaw),
    expectedMinutes: round(minutes.expectedMinutes),
    breakdown,
    confidence: assessConfidence(input, weights),
    reasons,
  };
}

function assessConfidence(
  input: PlayerModelInput,
  weights: ModelWeights,
): 'high' | 'medium' | 'low' {
  // Last season's rates are real evidence, but a summer of transfers and new managers means
  // they can never be high confidence - and a thin sample of minutes is barely evidence at all.
  if (input.usingPreviousSeason) {
    if ((input.previousSeasonMinutes ?? 0) < 900) return 'low';
    return input.xgPer90 !== null ? 'medium' : 'low';
  }
  if (input.minutesPlayed >= weights.attacking.priorWeightMinutes && input.xgPer90 !== null) {
    return 'high';
  }
  if (input.minutesPlayed > 0) return 'medium';
  return 'low';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
