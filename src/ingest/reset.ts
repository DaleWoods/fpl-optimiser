import type { Database } from 'better-sqlite3';

/**
 * Deleting stored data, deliberately in scopes.
 *
 * Wiping everything is rarely what you want. Last season's history took effort to load and can
 * never change, so the default scope leaves it alone; a squad can be re-imported in seconds, so
 * clearing just that is the common case. Every scope names exactly what it removes and what it
 * keeps, and returns the row counts, so there is no doubt about what happened.
 */

export type ResetScope = 'squad' | 'projections' | 'season' | 'all';

export interface ResetPlan {
  scope: ResetScope;
  description: string;
  /** What survives, in plain English. */
  keeps: string;
  tables: string[];
}

export interface ResetResult {
  scope: ResetScope;
  deleted: Record<string, number>;
  totalRows: number;
  description: string;
  keeps: string;
}

export const RESET_PLANS: Record<ResetScope, ResetPlan> = {
  squad: {
    scope: 'squad',
    description: 'Your loaded squad, bank and chip history',
    keeps: 'All player data, fixtures, last season and stored projections',
    tables: ['squad_pick', 'manager_state'],
  },
  projections: {
    scope: 'projections',
    description: 'Stored projections and past recommendations',
    keeps: 'Everything else, including your squad and all player data',
    tables: ['projection', 'recommendation'],
  },
  season: {
    scope: 'season',
    description:
      "This season's players, prices, fixtures, snapshots, projections and your squad",
    keeps: "Last season's history, so it never needs uploading again",
    tables: [
      'squad_pick',
      'manager_state',
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
    description: 'Everything, including last season',
    keeps: 'Nothing - the database is emptied and you start from scratch',
    tables: [
      'squad_pick',
      'manager_state',
      'projection',
      'recommendation',
      'elite_ownership',
      'elite_sample',
      'change_log',
      'player_snapshot',
      'snapshot',
      'player_fixture_history',
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

  return { scope, deleted, totalRows, description: plan.description, keeps: plan.keeps };
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
