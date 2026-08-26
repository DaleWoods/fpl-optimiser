import type { Database } from 'better-sqlite3';

/**
 * One player's actual gameweek, straight from player_fixture_history (this season only - that
 * table only ever holds the FPL API's own current-season element-summary history).
 */
export interface RecentFixtureRow {
  eventId: number;
  minutes: number | null;
  starts: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  bonus: number | null;
  defensiveContribution: number | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
}

/**
 * Every player's most recent `maxWindow` gameweeks, most recent first.
 *
 * A single query rather than one per player: player_fixture_history is small enough (one row
 * per player per gameweek played, this season only) to read in full and group here, which also
 * sidesteps depending on window-function support in whatever SQLite build is running.
 */
export function recentFixturesByPlayer(
  db: Database,
  maxWindow: number,
): Map<number, RecentFixtureRow[]> {
  const rows = db
    .prepare(
      `SELECT player_id AS playerId, event_id AS eventId, minutes, starts, goals_scored AS goals,
              assists, saves, bonus, defensive_contribution AS defensiveContribution,
              expected_goals AS expectedGoals, expected_assists AS expectedAssists
       FROM player_fixture_history
       WHERE event_id IS NOT NULL
       ORDER BY player_id ASC, event_id DESC`,
    )
    .all() as (RecentFixtureRow & { playerId: number })[];

  const byPlayer = new Map<number, RecentFixtureRow[]>();
  for (const row of rows) {
    const list = byPlayer.get(row.playerId) ?? [];
    if (list.length < maxWindow) list.push(row);
    byPlayer.set(row.playerId, list);
  }
  return byPlayer;
}

/** Sum one field across a window of recent fixtures, treating a null reading as zero. */
export function sumRecent(
  window: readonly RecentFixtureRow[],
  field: (row: RecentFixtureRow) => number | null,
): number {
  return window.reduce((total, row) => total + (field(row) ?? 0), 0);
}
