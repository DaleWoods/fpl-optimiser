import type { Database } from 'better-sqlite3';

/**
 * Deleting stored data, deliberately in scopes.
 *
 * Wiping everything is rarely what you want. Last season's history took effort to load and can
 * never change, so the default scope leaves it alone; a squad can be re-imported in seconds, so
 * clearing just that is the common case. Every scope names exactly what it removes and what it
 * keeps, and returns the row counts, so there is no doubt about what happened.
 */

export type ResetScope =
  | 'this-season'
  | 'fixtures'
  | 'last-season'
  | 'squad'
  | 'projections'
  | 'season'
  | 'all';

export interface ResetPlan {
  scope: ResetScope;
  /** Human name shown on the page, mirroring the import slots. */
  title: string;
  description: string;
  /** What survives, in plain English. */
  keeps: string;
  tables: string[];
}

export interface ResetResult {
  scope: ResetScope;
  title: string;
  deleted: Record<string, number>;
  totalRows: number;
  description: string;
  keeps: string;
}

/**
 * Ordered to mirror the Import Data slots, so "undo one import" is a straight mapping:
 * this season's player data, fixtures, last season's stats, your squad - then the wider scopes.
 */
export const RESET_PLANS: Record<ResetScope, ResetPlan> = {
  'this-season': {
    scope: 'this-season',
    title: "This season's player data",
    description:
      "This season's price/injury/form snapshots and the change log (the bootstrap-static import)",
    keeps:
      'The player list itself, fixtures, last season, your squad and stored projections. ' +
      'Re-import bootstrap-static to refill it.',
    tables: ['player_snapshot', 'snapshot', 'change_log'],
  },
  fixtures: {
    scope: 'fixtures',
    title: 'Fixtures',
    description: 'The fixture list and difficulty ratings (the fixtures import)',
    keeps: 'Everything else. Re-import fixtures to refill it.',
    tables: ['fixture'],
  },
  'last-season': {
    scope: 'last-season',
    title: "Last season's stats",
    description:
      "Last season's per-gameweek stats and season totals (the last-season CSV import)",
    keeps: 'Everything about this season, including your squad',
    tables: ['player_gameweek_stat', 'player_season_history'],
  },
  squad: {
    scope: 'squad',
    title: 'Your squad',
    description: 'Your loaded squad, bank and chip history (the squad import)',
    keeps: 'All player data, fixtures, last season and stored projections',
    tables: ['squad_pick', 'manager_state'],
  },
  projections: {
    scope: 'projections',
    title: 'Generated teams & projections',
    description: 'Stored projections and every generated recommendation',
    keeps: 'Everything you imported. Click Generate again for a fresh team.',
    tables: ['projection', 'recommendation'],
  },
  season: {
    scope: 'season',
    title: 'Whole current season',
    description:
      "Everything about this season: players' snapshots, fixtures, projections, results and your squad",
    keeps: "Last season's history, so it never needs uploading again",
    tables: [
      'squad_pick',
      'manager_state',
      'gameweek_result',
      'actual_points',
      'projection',
      'recommendation',
      'elite_ownership',
      'elite_sample',
      'change_log',
      'player_snapshot',
      'snapshot',
      'player_fixture_history',
      'fixture',
      'ingest_run',
    ],
  },
  all: {
    scope: 'all',
    title: 'Everything',
    description: 'Everything, including last season',
    keeps: 'Nothing - the database is emptied and you start from scratch',
    tables: [
      'squad_pick',
      'manager_state',
      'gameweek_result',
      'actual_points',
      'projection',
      'recommendation',
      'elite_ownership',
      'elite_sample',
      'change_log',
      'player_snapshot',
      'snapshot',
      'player_fixture_history',
      'player_gameweek_stat',
      'player_season_history',
      'fixture',
      'player',
      'event',
      'team',
      'position',
      'ingest_run',
    ],
  },
};

/** What a reset would remove, without removing it. */
export function planReset(db: Database, scope: ResetScope): ResetResult {
  const plan = RESET_PLANS[scope];
  const deleted: Record<string, number> = {};
  let totalRows = 0;

  for (const table of plan.tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    deleted[table] = row.n;
    totalRows += row.n;
  }

  return {
    scope,
    title: plan.title,
    deleted,
    totalRows,
    description: plan.description,
    keeps: plan.keeps,
  };
}

/**
 * Delete stored data for the given scope.
 *
 * Runs in a single transaction: a reset that half-completed would leave the database
 * referentially broken, which is worse than either outcome. Tables are listed child-first so
 * foreign keys never block the delete.
 */
export function resetData(db: Database, scope: ResetScope): ResetResult {
  const plan = RESET_PLANS[scope];
  const preview = planReset(db, scope);

  const run = db.transaction(() => {
    for (const table of plan.tables) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    // Reclaim the autoincrement counters so a fresh start really looks fresh.
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN (SELECT name FROM sqlite_sequence)").run();
  });

  run();

  return preview;
}
