import { z } from 'zod';

/**
 * Schemas for the FPL API payloads.
 *
 * Deliberately permissive: every object is a *loose* object, so fields we have not modelled
 * survive into raw_json instead of being rejected. The API is unofficial and gains fields
 * between seasons - being strict here would mean a new field takes the whole app down.
 *
 * We are strict about the handful of fields the optimiser actually depends on. If `element_type`
 * or `now_cost` goes missing, that must fail loudly, because every downstream decision rests
 * on it.
 *
 * The API returns many numbers as strings ("form": "4.2", "expected_goals": "0.35"). numeric()
 * accepts either and yields a number, or null when the value is absent or unparseable - never
 * NaN, which would silently poison a projection.
 */

/**
 * A number that the API may send as a string. Unparseable, null, or an absent key all become
 * null. The key being *missing* has to be tolerated, not just a null value: the API drops
 * fields between seasons, and a partial recording should still replay.
 */
export const numeric = () =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((value): number | null => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    });

/** Like numeric(), but the field must be present and parseable. */
export const requiredNumeric = () =>
  z.union([z.number(), z.string()]).transform((value, ctx): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: 'custom', message: `expected a number, received ${JSON.stringify(value)}` });
      return Number.NaN;
    }
    return parsed;
  });

const nullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => v ?? null);

const boolish = z
  .union([z.boolean(), z.number(), z.null()])
  .optional()
  .transform((v) => v === true || v === 1);

// ---------------------------------------------------------------------------
// bootstrap-static
// ---------------------------------------------------------------------------

export const eventSchema = z.looseObject({
  id: z.number().int(),
  name: nullableString,
  deadline_time: nullableString,
  is_current: boolish,
  is_next: boolish,
  is_previous: boolish,
  finished: boolish,
  data_checked: boolish,
  average_entry_score: numeric(),
  highest_score: numeric(),
});

export const teamSchema = z.looseObject({
  id: z.number().int(),
  code: numeric(),
  name: z.string(),
  short_name: z.string(),
  strength: numeric(),
  strength_overall_home: numeric(),
  strength_overall_away: numeric(),
  strength_attack_home: numeric(),
  strength_attack_away: numeric(),
  strength_defence_home: numeric(),
  strength_defence_away: numeric(),
});

export const elementTypeSchema = z.looseObject({
  id: z.number().int(),
  /** The short code config rules are keyed by: GKP / DEF / MID / FWD. */
  singular_name_short: z.string().min(1),
  singular_name: z.string(),
  plural_name: nullableString,
  squad_select: numeric(),
  squad_min_play: numeric(),
  squad_max_play: numeric(),
  element_count: numeric(),
});

export const elementSchema = z.looseObject({
  id: z.number().int(),
  code: numeric(),
  web_name: z.string(),
  first_name: nullableString,
  second_name: nullableString,
  /** Club and position always come from here - never hardcoded, never inferred. */
  team: z.number().int(),
  element_type: z.number().int(),

  now_cost: requiredNumeric(),
  cost_change_start: numeric(),
  cost_change_event: numeric(),
  transfers_in_event: numeric(),
  transfers_out_event: numeric(),

  status: z.string().min(1),
  chance_of_playing_this_round: numeric(),
  chance_of_playing_next_round: numeric(),
  news: nullableString,
  news_added: nullableString,

  form: numeric(),
  points_per_game: numeric(),
  total_points: numeric(),
  selected_by_percent: numeric(),
  ep_this: numeric(),
  ep_next: numeric(),

  minutes: numeric(),
  starts: numeric(),
  goals_scored: numeric(),
  assists: numeric(),
  clean_sheets: numeric(),
  goals_conceded: numeric(),
  saves: numeric(),
  bonus: numeric(),
  bps: numeric(),
  yellow_cards: numeric(),
  red_cards: numeric(),

  expected_goals: numeric(),
  expected_assists: numeric(),
  expected_goal_involvements: numeric(),
  expected_goals_conceded: numeric(),
  defensive_contribution: numeric(),
});

export const bootstrapSchema = z.looseObject({
  events: z.array(eventSchema),
  teams: z.array(teamSchema).min(1),
  element_types: z.array(elementTypeSchema).min(1),
  elements: z.array(elementSchema).min(1),
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

export const fixtureSchema = z.looseObject({
  id: z.number().int(),
  event: z.union([z.number().int(), z.null()]).optional().transform((v) => v ?? null),
  team_h: z.number().int(),
  team_a: z.number().int(),
  kickoff_time: nullableString,
  team_h_difficulty: numeric(),
  team_a_difficulty: numeric(),
  team_h_score: numeric(),
  team_a_score: numeric(),
  started: boolish,
  finished: boolish,
});

export const fixturesSchema = z.array(fixtureSchema);

// ---------------------------------------------------------------------------
// element-summary/{id}
// ---------------------------------------------------------------------------

export const historyEntrySchema = z.looseObject({
  element: z.number().int(),
  fixture: z.number().int(),
  round: numeric(),
  opponent_team: numeric(),
  was_home: boolish,
  kickoff_time: nullableString,
  minutes: numeric(),
  total_points: numeric(),
  goals_scored: numeric(),
  assists: numeric(),
  clean_sheets: numeric(),
  goals_conceded: numeric(),
  saves: numeric(),
  bonus: numeric(),
  bps: numeric(),
  yellow_cards: numeric(),
  red_cards: numeric(),
  starts: numeric(),
  value: numeric(),
  expected_goals: numeric(),
  expected_assists: numeric(),
  expected_goal_involvements: numeric(),
  expected_goals_conceded: numeric(),
  defensive_contribution: numeric(),
});

/**
 * A previous season's totals. At the start of a season this is the only real evidence about a
 * player, so it is modelled properly rather than skipped.
 */
export const pastSeasonSchema = z.looseObject({
  season_name: z.string(),
  element_code: numeric(),
  start_cost: numeric(),
  end_cost: numeric(),
  total_points: numeric(),
  minutes: numeric(),
  starts: numeric(),
  goals_scored: numeric(),
  assists: numeric(),
  clean_sheets: numeric(),
  goals_conceded: numeric(),
  saves: numeric(),
  bonus: numeric(),
  bps: numeric(),
  yellow_cards: numeric(),
  red_cards: numeric(),
  expected_goals: numeric(),
  expected_assists: numeric(),
  expected_goal_involvements: numeric(),
  expected_goals_conceded: numeric(),
  defensive_contribution: numeric(),
});

export const elementSummarySchema = z.looseObject({
  history: z.array(historyEntrySchema),
  fixtures: z.array(z.looseObject({})).optional(),
  history_past: z.array(pastSeasonSchema).default([]),
});

// ---------------------------------------------------------------------------
// leagues-classic/{id}/standings - used to sample what top managers own
// ---------------------------------------------------------------------------

export const leagueStandingsSchema = z.looseObject({
  league: z.looseObject({ id: z.number().int(), name: nullableString }).optional(),
  standings: z.looseObject({
    has_next: z.union([z.boolean(), z.null()]).optional().transform((v) => v === true),
    results: z.array(
      z.looseObject({
        entry: z.number().int(),
        entry_name: nullableString,
        player_name: nullableString,
        rank: numeric(),
        total: numeric(),
      }),
    ),
  }),
});

// ---------------------------------------------------------------------------
// entry/{id} and its sub-resources
// ---------------------------------------------------------------------------

export const entrySchema = z.looseObject({
  id: z.number().int(),
  name: nullableString,
  summary_overall_points: numeric(),
  summary_overall_rank: numeric(),
  /** Tenths of a million, as at the last deadline. The public API exposes nothing live. */
  last_deadline_bank: numeric(),
  last_deadline_value: numeric(),
  last_deadline_total_transfers: numeric(),
  current_event: numeric(),
});

export const pickSchema = z.looseObject({
  element: z.number().int(),
  /** 1-15: 1-11 start, 12-15 bench in auto-sub priority order. */
  position: z.number().int(),
  multiplier: z.number().int(),
  is_captain: boolish,
  is_vice_captain: boolish,
});

export const picksSchema = z.looseObject({
  active_chip: nullableString,
  picks: z.array(pickSchema),
  entry_history: z
    .looseObject({
      event: numeric(),
      bank: numeric(),
      value: numeric(),
      event_transfers: numeric(),
      event_transfers_cost: numeric(),
      points: numeric(),
      total_points: numeric(),
      points_on_bench: numeric(),
    })
    .optional(),
});

/**
 * The authenticated my-team endpoint.
 *
 * Not reachable by the automatic refresh - it needs the session cookie of a logged-in browser -
 * so it arrives only by hand through the import screen, the same way every other file this app
 * cannot fetch for itself does. It is the only source of two numbers the app otherwise has to
 * infer: what each player would actually sell for, and how many free transfers you really have.
 */
export const myTeamPickSchema = z.looseObject({
  element: z.number().int(),
  position: z.number().int(),
  /** Tenths of a million. What FPL would actually give you for this player right now. */
  selling_price: numeric(),
  /** Tenths of a million. What you paid. */
  purchase_price: numeric(),
  multiplier: z.number().int(),
  is_captain: boolish,
  is_vice_captain: boolish,
});

export const myTeamSchema = z.looseObject({
  picks: z.array(myTeamPickSchema),
  transfers: z.looseObject({
    /** The real free-transfer count. Null during a wildcard, where the concept does not apply. */
    limit: numeric(),
    made: numeric(),
    bank: numeric(),
    value: numeric(),
  }),
});

export const entryHistorySchema = z.looseObject({
  current: z.array(
    z.looseObject({
      event: z.number().int(),
      points: numeric(),
      total_points: numeric(),
      bank: numeric(),
      value: numeric(),
      event_transfers: numeric(),
      event_transfers_cost: numeric(),
      points_on_bench: numeric(),
    }),
  ),
  past: z.array(z.looseObject({})).optional(),
  chips: z
    .array(
      z.looseObject({
        name: z.string(),
        event: numeric(),
        time: nullableString,
      }),
    )
    .default([]),
});

export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type ApiEvent = z.infer<typeof eventSchema>;
export type ApiTeam = z.infer<typeof teamSchema>;
export type ApiElementType = z.infer<typeof elementTypeSchema>;
export type ApiElement = z.infer<typeof elementSchema>;
export type ApiFixture = z.infer<typeof fixtureSchema>;
export type ApiFixtures = z.infer<typeof fixturesSchema>;
export type ApiElementSummary = z.infer<typeof elementSummarySchema>;
export type ApiHistoryEntry = z.infer<typeof historyEntrySchema>;
export type ApiEntry = z.infer<typeof entrySchema>;
export type ApiPicks = z.infer<typeof picksSchema>;
export type ApiPick = z.infer<typeof pickSchema>;
export type ApiEntryHistory = z.infer<typeof entryHistorySchema>;
export type ApiMyTeam = z.infer<typeof myTeamSchema>;
export type ApiPastSeason = z.infer<typeof pastSeasonSchema>;
export type ApiLeagueStandings = z.infer<typeof leagueStandingsSchema>;
