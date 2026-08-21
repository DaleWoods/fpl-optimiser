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
    priorStartProbability: probability,
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
  captain: z.strictObject({
    ceilingWeight: z.number().min(0),
  }),
  optimiser: z.strictObject({
    benchWeight: probability,
    benchGoalkeeperWeight: probability,
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
