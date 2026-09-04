import { z } from 'zod';

/**
 * Schemas for the three config files. Everything is strict: an unrecognised key is a typo,
 * and a typo in a rules file that silently does nothing is exactly the failure mode this app
 * cannot afford. `$comment` keys are stripped before parsing (see stripComments in load.ts).
 */

/** A position is identified by its FPL element_type short code (GKP/DEF/MID/FWD today). */
const PositionCode = z.string().min(1);

const positionMap = <T extends z.ZodTypeAny>(value: T) => z.record(PositionCode, value);

const nonNegativeInt = z.number().int().min(0);
const positiveInt = z.number().int().positive();
const probability = z.number().min(0).max(1);

export const rulesSchema = z.strictObject({
  season: z.string(),
  squad: z.strictObject({
    size: positiveInt,
    /** Tenths of a million, matching the API's now_cost units. 1000 = £100.0m. */
    budget: positiveInt,
    maxPerClub: positiveInt,
    positionCounts: positionMap(nonNegativeInt),
  }),
  startingXi: z.strictObject({
    size: positiveInt,
    positionBounds: positionMap(
      z.strictObject({ min: nonNegativeInt, max: nonNegativeInt }),
    ),
  }),
  bench: z.strictObject({
    size: positiveInt,
    positionCounts: positionMap(nonNegativeInt),
  }),
  captain: z.strictObject({
    multiplier: positiveInt,
    tripleCaptainMultiplier: positiveInt,
  }),
  transfers: z.strictObject({
    freePerGameweek: nonNegativeInt,
    maxBanked: positiveInt,
    hitCost: nonNegativeInt,
    keepBankedOnWildcard: z.boolean(),
    keepBankedOnFreeHit: z.boolean(),
    unlimitedBeforeFirstDeadline: z.boolean(),
  }),
  sellingPrice: z.strictObject({
    profitDivisor: z.number().positive(),
    rounding: z.enum(['floor', 'round', 'ceil']),
  }),
  chips: z.strictObject({
    oneChipPerGameweek: z.boolean(),
    firstSetExpiresAfterGameweek: positiveInt,
    setsPerSeason: positiveInt,
    available: z.array(z.string()).min(1),
    names: z.record(z.string(), z.string()),
    effects: z.record(
      z.string(),
      z.strictObject({
        unlimitedTransfers: z.boolean().optional(),
        revertsAfterGameweek: z.boolean().optional(),
        benchScores: z.boolean().optional(),
        captainMultiplier: positiveInt.optional(),
      }),
    ),
  }),
  scoring: z.strictObject({
    appearance: z.strictObject({
      anyMinutes: z.number(),
      sixtyPlusMinutes: z.number(),
    }),
    goal: positionMap(z.number()),
    assist: z.number(),
    cleanSheet: positionMap(z.number()),
    goalsConceded: z.strictObject({
      perGoals: positiveInt,
      points: z.number(),
      appliesTo: z.array(PositionCode),
    }),
    saves: z.strictObject({
      perSaves: positiveInt,
      points: z.number(),
      appliesTo: z.array(PositionCode),
    }),
    defensiveContribution: z.strictObject({
      points: z.number(),
      /** null = this position cannot earn DefCon points. */
      thresholds: positionMap(positiveInt.nullable()),
    }),
    bonus: z.strictObject({ max: nonNegativeInt }),
  }),
});

export const modelWeightsSchema = z.strictObject({
  modelVersion: z.string().min(1),
  availability: z.strictObject({
    statusProbability: z.record(z.string(), probability),
    chanceOfPlayingOverridesStatus: z.boolean(),
    unknownStatusProbability: probability,
  }),
  minutes: z.strictObject({
    recentMatches: positiveInt,
    recentWeight: probability,
    startThresholdMinutes: positiveInt,
    expectedMinutesIfStarting: z.number().min(0).max(90),
    expectedMinutesIfBenched: z.number().min(0).max(90),
    /**
     * The baseline prior for a player the crowd says nothing about. On its own this is applied
     * to everyone equally, which after one match swamps the evidence entirely: 1 start in 1
     * match lands on a 51% start chance whether the player is a nailed-on £15.5m striker or a
     * £4.0m fringe defender. See ownershipPriorPivot for what separates them.
     */
    priorStartProbability: probability,
    /**
     * Ownership percentage at which the start prior reaches ownershipPriorMax. Ownership is the
     * crowd's aggregated team news - the same evidence lowOwnershipThreshold already trusts over
     * our own start count, just used as a two-sided signal rather than only as a floor-level cap.
     * A player two-thirds of managers own is owned *because* he is nailed on; a 2%-owned one is
     * not. Without this the minutes model cannot tell those apart until several matches have
     * been played, which flattens every projection into the same narrow band early in a season.
     */
    ownershipPriorPivot: z.number().positive().max(100),
    /** The start prior for a player at or above ownershipPriorPivot. */
    ownershipPriorMax: probability,
    priorWeightMatches: z.number().min(0),
    starterCompletesSixty: probability,
    benchAppearanceProbability: probability,
    /**
     * Below this ownership percentage, the crowd (every other manager's team news, injuries and
     * press-conference reading) is stronger evidence than a couple of appearances in our own
     * data - so the start probability is capped rather than trusted. See lowOwnershipStartCap.
     */
    lowOwnershipThreshold: z.number().min(0).max(100),
    /** The start-probability ceiling applied below lowOwnershipThreshold. */
    lowOwnershipStartCap: probability,
    /**
     * A club playing again this soon after its last fixture - most often a European tie
     * sandwiched between two league gameweeks, since that is the only reason a top-flight club's
     * own league fixtures get shuffled this tight - is a real rotation risk the model has no
     * other way to see: the FPL API carries no European fixtures at all, only the Premier League
     * ones already imported, so a short gap between two of those is the signal, not a curated
     * list of "clubs in Europe" that would need separate upkeep and still not know the exact
     * date. Below this many days since the club's previous fixture, rotationRiskDiscount applies.
     */
    rotationRiskRestDaysThreshold: z.number().min(0),
    /** Multiplicative discount to start probability when rotationRiskRestDaysThreshold applies.
     *  1.0 disables it entirely. */
    rotationRiskDiscount: probability,
  }),
  teamStrength: z.strictObject({
    leagueAverageGoalsPerGame: z.number().positive(),
    homeAdvantage: z.number().positive(),
    awayFactor: z.number().positive(),
    strengthExponent: z.number().min(0),
    /** How much the computed league table bends club strength. 0 disables it. */
    tableWeight: z.number().min(0),
    minExpectedGoals: z.number().min(0),
    maxExpectedGoals: z.number().positive(),
    fallbackStrength: z.number().positive(),
  }),
  attacking: z.strictObject({
    recentMatches: positiveInt,
    recentWeight: probability,
    xgWeight: probability,
    fixtureScalingWeight: z.number().min(0),
    priorWeightMinutes: z.number().min(0),
    /**
     * A stronger version of priorWeightMinutes, applied only to goal involvement (goals,
     * assists, and the xG/xA behind them) for a goalkeeper or defender. One shared prior cannot
     * be right for both a striker, whose true goal rate is genuinely close to that prior, and a
     * defender, whose true rate is close to zero - a defender's one early goal needs far more
     * evidence behind it before it reads as a real, repeatable threat rather than a one-off.
     */
    lowThreatPriorWeightMinutes: z.number().min(0),
    /**
     * How many minutes of last-season evidence it takes to half-trust that season's own per-90
     * as the anchor for this season. The anchor is a prior, and a prior built from a thin
     * sample is not a strong prior - it is a guess wearing a prior's clothes. Without this, two
     * goals in 200 minutes last season anchored a player at 0.9 goals per 90 and then asserted
     * that with the weight of ten full matches, because priorWeightMinutes does not care where
     * the anchor came from.
     */
    anchorPriorWeightMinutes: z.number().min(0),
    /**
     * What a thin last-season sample shrinks toward, per position: roughly what an ordinary
     * player in that position does per 90. Not zero - "we know almost nothing about this
     * player" should resolve to "assume he is ordinary for his position", not "assume he cannot
     * play at all". Keys are position short names; a position absent here falls back to zero,
     * which is the older behaviour and still the honest answer when there is nothing better to
     * say.
     */
    positionBaselineRates: positionMap(
      z.strictObject({
        goals: z.number().min(0),
        assists: z.number().min(0),
        saves: z.number().min(0),
        defensiveContribution: z.number().min(0),
        bonus: z.number().min(0),
      }),
    ),
  }),
  cleanSheet: z.strictObject({
    maxProbability: probability,
    minProbability: probability,
  }),
  saves: z.strictObject({
    savesPerExpectedGoalConceded: z.number().min(0),
    recentWeight: probability,
  }),
  defensiveContribution: z.strictObject({
    steepness: z.number().positive(),
    fallbackProbability: probability,
    recentWeight: probability,
  }),
  bonus: z.strictObject({
    recentWeight: probability,
    shrinkage: probability,
    maxExpectedBonus: z.number().min(0),
  }),
  differential: z.strictObject({
    weight: z.number().min(0),
    ownershipPivot: z.number().min(0).max(100),
    maxAdjustment: z.number().min(0),
  }),
  /** Real evidence of what top-ranked managers actually own, once their squads go public. */
  eliteOwnership: z.strictObject({
    weight: z.number().min(0),
    captainWeight: z.number().min(0),
    maxAdjustment: z.number().min(0),
  }),
  /**
   * A selection-time risk discount on xPts, by confidence tier. Applied only when the solver is
   * choosing between players - never to what is displayed or graded for accuracy, so the app
   * never shows a number different from the one it optimised on. 1.0 means no discount.
   */
  confidence: z.strictObject({
    high: probability,
    medium: probability,
    low: probability,
  }),
  /**
   * How far ahead transfers and captaincy look, beyond the single gameweek being planned for.
   * A transfer keeps paying off for as long as the player is held, and a captaincy pick is more
   * trustworthy when it is not a one-off spike, so both are judged against a run of fixtures -
   * weighted most heavily toward the near term, since further-out projections are less certain.
   */
  horizon: z.strictObject({
    /** Gameweeks considered, including the target one. */
    length: positiveInt,
    /** Weight multiplier per gameweek further out: 1.0 for the target week, decay^1 the next, etc. */
    decay: probability,
    /** Bounded bonus (points) nudging captaincy toward a consistently strong performer over a
     *  one-off spike, when the two are otherwise close. Never a penalty, only ever a nudge. */
    captainConsistencyWeight: z.number().min(0),
    /** How far, at most, to relax the bench discount when a double gameweek sits within the
     *  horizon - 0 leaves the bench discount untouched, 1 would treat bench like starters. */
    benchBoostRelief: probability,
  }),
  chips: z.strictObject({
    /**
     * Per-gameweek discount on a chip's value in a *future* week, when deciding when to play it.
     *
     * A chip advisor that ranks purely on projected gain treats a projection thirteen weeks out
     * as exactly as trustworthy as one for this week. It is not. The fixture may be rearranged,
     * the opponent's strength rating will have moved, the player may be injured or out of the
     * side, and you may not even own him by then - a banked chip is only worth its projection
     * multiplied by the chance the whole plan survives to that week.
     *
     * This is a different thing from horizon.decay, which discounts future gameweeks for
     * transfers because points now are worth more than points later. This one is about
     * *confidence*, not timing: it says a distant projection is a weaker claim.
     *
     * 0.97 per gameweek: four weeks out keeps 89%, thirteen weeks out keeps 67%. Deliberately
     * gentle - it breaks a near-tie in favour of acting on what you can actually see, and a
     * genuinely better future week still wins. Set to 1.0 to rank purely on projected gain, which
     * is exactly the previous behaviour.
     */
    futureDiscountPerGameweek: probability,
    /**
     * How far ahead of the next-best gameweek a chip has to score before the model claims it has
     * actually found the right week.
     *
     * A chip is worth one play a season, and playing it on a week the model cannot separate from
     * three others is throwing it away for nothing. Below this margin the advice says the weeks
     * are indistinguishable and names the earliest of them - if they are all the same, the only
     * thing left to prefer is the one you can actually see - rather than presenting an arbitrary
     * pick as a finding.
     *
     * 0.75 points: comfortably inside the noise on a projection of this kind, and well below any
     * gap a genuine standout week would open up.
     */
    indistinguishableMargin: z.number().min(0),
  }),
  captain: z.strictObject({
    /**
     * How much a captain candidate's upside beyond his own mean is worth, per point of it.
     * Applied to (ceiling - xPts), not to the raw ceiling: the raw ceiling correlates strongly
     * with expected points, so using it directly would just be a second, noisier vote for what
     * the expected-points term already said.
     */
    ceilingWeight: z.number().min(0),
    /** Hard cap on that nudge. A ceiling breaks a tie; it never justifies a worse captain. */
    maxCeilingBonus: z.number().min(0),
    /** Score at or above which a gameweek counts as a haul, for haulProbability. */
    haulThreshold: z.number().positive(),
    /**
     * How close two vice-captain candidates' risk-adjusted values have to be before ceiling
     * separates them. Previously this comparison sat behind a `||`, which short-circuits only on
     * exactly zero - and two independently computed floats never are - so ceilingWeight was dead
     * config that affected nothing anywhere. An explicit epsilon is what "near-equal" means.
     */
    tiebreakEpsilon: z.number().min(0),
    /**
     * Include the same bounded upside bonus when timing the Triple Captain chip.
     *
     * This used to rank gameweeks by the raw ceiling, which was wrong and a failing
     * double-gameweek test is what exposed it: the ceiling is a 90th percentile of a discrete
     * distribution and saturates, so a double gameweek raised the captain's expected gain far
     * more than it raised his ceiling. Ranking on it discarded most of the reason a double
     * gameweek is the week a Triple Captain wants.
     */
    tripleCaptainUsesCeiling: z.boolean(),
  }),
  optimiser: z.strictObject({
    benchWeight: probability,
    benchGoalkeeperWeight: probability,
    /**
     * Extra selection-time discount for a player who might not be on the pitch at all, applied
     * on top of the expected minutes already baked into xPts. See startRiskFactor() in
     * src/optimise/squad.ts: a 20%-to-start player is not "a fifth of a player", he is
     * overwhelmingly likely to return nothing, and an XI slot spent on him cannot be recovered.
     * 0 disables it and goes back to pure expected value; 1 applies it in full.
     */
    startRiskWeight: probability,
  }),
  /**
   * A squad member projected below this many points this gameweek is effectively a dead
   * squad slot (hurt, dropped down the pecking order, lost to a summer signing - the model has
   * already worked that out). Below it, that player's best available replacement is guaranteed
   * to be shown even if fixing them ranks below a flashier upgrade elsewhere by raw point swing
   * - a squad slot scoring nothing is worse than any single point total suggests.
   */
  transfers: z.strictObject({
    priorityFixXPtsThreshold: z.number().min(0),
    /**
     * Purely informational, never a recommendation to wait or a scoring change - see
     * transferTimingNoteFor() in src/report/recommend.ts. The top non-priority transfer target's
     * this-gameweek projection is compared against their own average across the rest of the
     * horizon; a ratio this far from 1 in either direction earns a note about which weeks their
     * value is really concentrated in, so a manager can weigh timing for themselves.
     */
    timingNoteRatio: z.number().min(0).max(1),
  }),
  /**
   * A soft, informational signal only - never an xPts adjustment, never a gate on selection.
   * FPL's real price-change algorithm is unpublished; this is not a prediction of exactly when a
   * price will move, only a "worth knowing" flag for whoever is otherwise close to a transfer
   * decision.
   */
  priceTrend: z.strictObject({
    /** How many of the most-transferred-in and most-transferred-out players get flagged. */
    topN: positiveInt,
    /** Net transfers this gameweek (in minus out) below which a top-N rank is not flagged at
     *  all - early season, or a quiet gameweek, produces a top 20 that is really just noise. */
    netTransfersFloor: nonNegativeInt,
  }),
  /**
   * Correcting the model using its own measured error.
   *
   * The accuracy tables have always measured bias per position and nothing ever read it; this is
   * what finally does. Deliberately conservative: one multiplicative factor per position, shrunk
   * hard by sample size and clamped, so it can nudge a systematic lean out of the model but can
   * never rewrite a projection. Set enabled to false to project exactly as if none of it existed.
   */
  calibration: z.strictObject({
    enabled: z.boolean(),
    /**
     * Graded projections before a position's correction is half-trusted. Bias measured over a
     * single gameweek is mostly that week's own variance - a striker drought and a defensive
     * haul are not evidence that the model leans, they are evidence that football happened.
     */
    priorWeightPlayers: z.number().positive(),
    /** Graded gameweeks below which no correction is applied at all. */
    minGameweeks: positiveInt,
    /**
     * Hard bounds on the factor. A model that needs a 40% correction has a bug to be found, not
     * a lean to be tuned out, and quietly applying one would hide it.
     */
    minFactor: z.number().positive(),
    maxFactor: z.number().positive(),
  }),
});

export const appConfigSchema = z.strictObject({
  /** FPL entry ID. null until the user supplies it; squad commands fail with a clear message. */
  teamId: positiveInt.nullable(),
  api: z.strictObject({
    baseUrl: z.url(),
    userAgent: z.string().min(1),
    minRequestIntervalMs: nonNegativeInt,
    requestTimeoutMs: positiveInt,
    maxRetries: nonNegativeInt,
    retryBackoffMs: nonNegativeInt,
    cacheDir: z.string().min(1),
    cacheTtlSeconds: z.strictObject({
      bootstrap: nonNegativeInt,
      fixtures: nonNegativeInt,
      elementSummary: nonNegativeInt,
      entry: nonNegativeInt,
      live: nonNegativeInt,
    }),
  }),
  database: z.strictObject({
    path: z.string().min(1),
  }),
  staleness: z.strictObject({
    warnAfterSeconds: nonNegativeInt,
  }),
});

export type Rules = z.infer<typeof rulesSchema>;
export type ModelWeights = z.infer<typeof modelWeightsSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

export interface Config {
  rules: Rules;
  weights: ModelWeights;
  app: AppConfig;
}
