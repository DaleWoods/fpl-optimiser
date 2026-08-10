import type { Database } from 'better-sqlite3';
import { ApiError, type FplApi } from '../api/client.js';
import type { ApiElementSummary } from '../api/schemas.js';
import { isoToUnix, nowSeconds, toSqliteBool } from '../db/index.js';
import { withIngestRun } from './run.js';

export interface SummariesIngestResult {
  rowsWritten: number;
  fromCache: boolean;
  fetchedAt: number;
  playersIngested: number;
  playersFailed: number;
  failures: { playerId: number; reason: string }[];
}

export interface SummaryIngestOptions {
  /** Limit to these players. Defaults to every player in the database. */
  playerIds?: number[];
  /** Called after each player, for progress reporting on a long pull. */
  onProgress?: (done: number, total: number, playerId: number) => void;
}

/**
 * Ingest per-player match history from element-summary.
 *
 * This is the slowest ingestion by far - one request per player, deliberately throttled. One
 * player failing must not lose the rest, so failures are collected and reported rather than
 * thrown: a single 404 on a departed player should not cost us the other 700 histories.
 */
export async function ingestPlayerSummaries(
  db: Database,
  api: FplApi,
  options: SummaryIngestOptions = {},
): Promise<SummariesIngestResult> {
  return withIngestRun(db, 'element-summary', async () => {
    const playerIds =
      options.playerIds ??
      (db.prepare('SELECT id FROM player ORDER BY id').all() as { id: number }[]).map(
        (row) => row.id,
      );

    let rowsWritten = 0;
    let playersIngested = 0;
    let anyFromCache = false;
    const failures: { playerId: number; reason: string }[] = [];
    let latestFetchedAt = 0;

    for (const [index, playerId] of playerIds.entries()) {
      try {
        const { data, fetchedAt, fromCache } = await api.elementSummary(playerId);
        rowsWritten += ingestElementSummaryPayload(db, playerId, data);
        playersIngested += 1;
        anyFromCache = anyFromCache || fromCache;
        latestFetchedAt = Math.max(latestFetchedAt, fetchedAt);
      } catch (cause) {
        failures.push({
          playerId,
          reason: cause instanceof ApiError ? `HTTP ${cause.status ?? '?'}` : (cause as Error).message,
        });
      }
      options.onProgress?.(index + 1, playerIds.length, playerId);
    }

    return {
      rowsWritten,
      fromCache: anyFromCache,
      fetchedAt: latestFetchedAt || nowSeconds(),
      playersIngested,
      playersFailed: failures.length,
      failures,
    };
  });
}

/** Upsert one player's match history. Returns the number of rows written. */
export function ingestElementSummaryPayload(
  db: Database,
  playerId: number,
  data: ApiElementSummary,
): number {
  const at = nowSeconds();

  const playerExists = db.prepare('SELECT 1 FROM player WHERE id = ?').get(playerId);
  if (!playerExists) return 0;

  const upsert = db.prepare(`
    INSERT INTO player_fixture_history (
      player_id, fixture_id, event_id, opponent_team_id, was_home, kickoff_time_iso, kickoff_time,
      minutes, total_points, goals_scored, assists, clean_sheets, goals_conceded, saves, bonus,
      bps, yellow_cards, red_cards, starts, value, expected_goals, expected_assists,
      expected_goal_involvements, expected_goals_conceded, defensive_contribution,
      updated_at, raw_json
    ) VALUES (
      @player_id, @fixture_id, @event_id, @opponent_team_id, @was_home, @kickoff_time_iso, @kickoff_time,
      @minutes, @total_points, @goals_scored, @assists, @clean_sheets, @goals_conceded, @saves, @bonus,
      @bps, @yellow_cards, @red_cards, @starts, @value, @expected_goals, @expected_assists,
      @expected_goal_involvements, @expected_goals_conceded, @defensive_contribution,
      @updated_at, @raw_json
    )
    ON CONFLICT (player_id, fixture_id) DO UPDATE SET
      event_id = excluded.event_id, opponent_team_id = excluded.opponent_team_id,
      was_home = excluded.was_home, kickoff_time_iso = excluded.kickoff_time_iso,
      kickoff_time = excluded.kickoff_time, minutes = excluded.minutes,
      total_points = excluded.total_points, goals_scored = excluded.goals_scored,
      assists = excluded.assists, clean_sheets = excluded.clean_sheets,
      goals_conceded = excluded.goals_conceded, saves = excluded.saves, bonus = excluded.bonus,
      bps = excluded.bps, yellow_cards = excluded.yellow_cards, red_cards = excluded.red_cards,
      starts = excluded.starts, value = excluded.value, expected_goals = excluded.expected_goals,
      expected_assists = excluded.expected_assists,
      expected_goal_involvements = excluded.expected_goal_involvements,
      expected_goals_conceded = excluded.expected_goals_conceded,
      defensive_contribution = excluded.defensive_contribution,
      updated_at = excluded.updated_at, raw_json = excluded.raw_json
  `);

  const upsertSeason = db.prepare(`
    INSERT INTO player_season_history (
      player_id, season_name, element_code, start_cost, end_cost, total_points, minutes, starts,
      goals_scored, assists, clean_sheets, goals_conceded, saves, bonus, bps,
      yellow_cards, red_cards, expected_goals, expected_assists, expected_goal_involvements,
      expected_goals_conceded, defensive_contribution, updated_at, raw_json
    ) VALUES (
      @player_id, @season_name, @element_code, @start_cost, @end_cost, @total_points, @minutes, @starts,
      @goals_scored, @assists, @clean_sheets, @goals_conceded, @saves, @bonus, @bps,
      @yellow_cards, @red_cards, @expected_goals, @expected_assists, @expected_goal_involvements,
      @expected_goals_conceded, @defensive_contribution, @updated_at, @raw_json
    )
    ON CONFLICT (player_id, season_name) DO UPDATE SET
      element_code = excluded.element_code, start_cost = excluded.start_cost,
      end_cost = excluded.end_cost, total_points = excluded.total_points,
      minutes = excluded.minutes, starts = excluded.starts,
      goals_scored = excluded.goals_scored, assists = excluded.assists,
      clean_sheets = excluded.clean_sheets, goals_conceded = excluded.goals_conceded,
      saves = excluded.saves, bonus = excluded.bonus, bps = excluded.bps,
      yellow_cards = excluded.yellow_cards, red_cards = excluded.red_cards,
      expected_goals = excluded.expected_goals, expected_assists = excluded.expected_assists,
      expected_goal_involvements = excluded.expected_goal_involvements,
      expected_goals_conceded = excluded.expected_goals_conceded,
      defensive_contribution = excluded.defensive_contribution,
      updated_at = excluded.updated_at, raw_json = excluded.raw_json
  `);

  const write = db.transaction(() => {
    let count = 0;

    // Previous seasons. At the start of a season this is the only evidence there is.
    for (const season of data.history_past) {
      upsertSeason.run({
        player_id: playerId,
        season_name: season.season_name,
        element_code: season.element_code,
        start_cost: season.start_cost,
        end_cost: season.end_cost,
        total_points: season.total_points,
        minutes: season.minutes,
        starts: season.starts,
        goals_scored: season.goals_scored,
        assists: season.assists,
        clean_sheets: season.clean_sheets,
        goals_conceded: season.goals_conceded,
        saves: season.saves,
        bonus: season.bonus,
        bps: season.bps,
        yellow_cards: season.yellow_cards,
        red_cards: season.red_cards,
        expected_goals: season.expected_goals,
        expected_assists: season.expected_assists,
        expected_goal_involvements: season.expected_goal_involvements,
        expected_goals_conceded: season.expected_goals_conceded,
        defensive_contribution: season.defensive_contribution,
        updated_at: at,
        raw_json: JSON.stringify(season),
      });
      count += 1;
    }

    for (const match of data.history) {
      upsert.run({
        player_id: playerId,
        fixture_id: match.fixture,
        event_id: match.round,
        opponent_team_id: match.opponent_team,
        was_home: toSqliteBool(match.was_home),
        kickoff_time_iso: match.kickoff_time,
        kickoff_time: isoToUnix(match.kickoff_time),
        minutes: match.minutes,
        total_points: match.total_points,
        goals_scored: match.goals_scored,
        assists: match.assists,
        clean_sheets: match.clean_sheets,
        goals_conceded: match.goals_conceded,
        saves: match.saves,
        bonus: match.bonus,
        bps: match.bps,
        yellow_cards: match.yellow_cards,
        red_cards: match.red_cards,
        starts: match.starts,
        value: match.value,
        expected_goals: match.expected_goals,
        expected_assists: match.expected_assists,
        expected_goal_involvements: match.expected_goal_involvements,
        expected_goals_conceded: match.expected_goals_conceded,
        defensive_contribution: match.defensive_contribution,
        updated_at: at,
        raw_json: JSON.stringify(match),
      });
      count += 1;
    }
    return count;
  });

  return write();
}
