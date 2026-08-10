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
    available: z.array(z.string()).min(1),
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
  }),
  teamStrength: z.strictObject({
    leagueAverageGoalsPerGame: z.number().positive(),
    homeAdvantage: z.number().positive(),
    awayFactor: z.number().positive(),
    strengthExponent: z.number().min(0),
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
  captain: z.strictObject({
    ceilingWeight: z.number().min(0),
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
