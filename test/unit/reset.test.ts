import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { importPayload } from '../../src/ingest/import.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { planReset, resetData, RESET_PLANS } from '../../src/ingest/reset.js';
import { fakeBootstrap, fakeFixture, fakePicks } from '../support/fakeApi.js';

const rules = loadRules();
const teamId = 2651633;

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('reset', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
    await ingestFixtures(db, new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2)] }), );
    await importPayload(
      db,
      rules,
      JSON.stringify(fakePicks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])),
      { teamId },
    );
    await importPayload(
      db,
      rules,
      JSON.stringify({
        history: [{ element: 1, fixture: 500, minutes: 90 }],
        history_past: [{ season_name: '2025/26', total_points: 180, minutes: 3000 }],
      }),
    );
  });

  it('previews without deleting anything', () => {
    const before = count(db, 'squad_pick');
    const plan = planReset(db, 'squad');

    expect(plan.totalRows).toBeGreaterThan(0);
    expect(plan.deleted.squad_pick).toBe(15);
    expect(count(db, 'squad_pick')).toBe(before);
  });

  it('clears the squad but keeps every player and their history', () => {
    const result = resetData(db, 'squad');

    expect(result.totalRows).toBeGreaterThan(0);
    expect(count(db, 'squad_pick')).toBe(0);
    expect(count(db, 'manager_state')).toBe(0);
    // The point of the scope: player data survives.
    expect(count(db, 'player')).toBe(60);
    expect(count(db, 'player_season_history')).toBe(1);
    expect(count(db, 'fixture')).toBe(1);
  });

  it("clears the season but keeps last season, which never needs uploading again", () => {
    resetData(db, 'season');

    expect(count(db, 'player_snapshot')).toBe(0);
    expect(count(db, 'fixture')).toBe(0);
    expect(count(db, 'squad_pick')).toBe(0);
    expect(count(db, 'snapshot')).toBe(0);
    // The whole reason this scope exists.
    expect(count(db, 'player_season_history')).toBe(1);
    expect(count(db, 'player')).toBe(60);
  });

  it('clears everything on the all scope', () => {
    resetData(db, 'all');

    for (const table of [
      'player',
      'team',
      'position',
      'fixture',
      'player_snapshot',
      'player_season_history',
      'squad_pick',
      'manager_state',
    ]) {
      expect(count(db, table), table).toBe(0);
    }
  });

  it('leaves the schema intact so the app still works afterwards', async () => {
    resetData(db, 'all');

    // A fresh import must succeed straight after a full reset.
    const summary = await importPayload(db, rules, JSON.stringify(fakeBootstrap()));
    expect(summary.kind).toBe('bootstrap');
    expect(count(db, 'player')).toBe(60);
  });

  it('is safe to run twice', () => {
    resetData(db, 'squad');
    const second = resetData(db, 'squad');
    expect(second.totalRows).toBe(0);
  });

  it('reports zero rows when there is nothing to delete', () => {
    const empty = openTestDatabase();
    expect(planReset(empty, 'all').totalRows).toBe(0);
  });

  it('names what each scope removes and keeps, so the choice is informed', () => {
    for (const scope of Object.keys(RESET_PLANS) as (keyof typeof RESET_PLANS)[]) {
      const plan = RESET_PLANS[scope];
      expect(plan.description.length).toBeGreaterThan(10);
      expect(plan.keeps.length).toBeGreaterThan(10);
      expect(plan.tables.length).toBeGreaterThan(0);
    }
  });

  it('deletes children before parents so foreign keys never block it', () => {
    // squad_pick references manager_state and player; a wrong order would throw here.
    expect(() => resetData(db, 'all')).not.toThrow();
  });
});
