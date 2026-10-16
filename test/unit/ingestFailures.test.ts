import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadRules } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap } from '../../src/ingest/index.js';
import { lastFailedRun, lastSuccessfulRun } from '../../src/ingest/run.js';
import { getStateOfPlay } from '../../src/report/state.js';
import { renderDashboard } from '../../src/report/views.js';
import { fakeBootstrap, fakeEvent } from '../support/fakeApi.js';

const rules = loadRules();

/**
 * A source failed every refresh for a week, and the Dashboard said "stale" - the same word it
 * uses for data nobody has got round to refreshing. The reason was sitting in ingest_run.note
 * the entire time and was never read, so the obvious response was to press refresh again, which
 * failed again, silently.
 */
describe('saying why a refresh failed', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({ bootstrap: fakeBootstrap({ events: [fakeEvent(1, { is_next: true })] }) }),
      rules,
    );
  });

  function recordRun(source: string, ok: boolean, note: string | null, startedAt: number): void {
    db.prepare(
      `INSERT INTO ingest_run (source, started_at, finished_at, ok, rows_written, note)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(source, startedAt, startedAt + 1, ok ? 1 : 0, note);
  }

  it('reports the reason a source is failing', () => {
    recordRun('entry', false, 'HTTP 503 from the FPL API', nowSeconds());
    const failed = lastFailedRun(db, 'entry')!;
    expect(failed.note).toBe('HTTP 503 from the FPL API');
  });

  it('forgets a failure once the source has succeeded since', () => {
    // Otherwise every transient blip would be reported forever as a current problem.
    recordRun('entry', false, 'HTTP 503', 100);
    recordRun('entry', true, null, 200);

    expect(lastFailedRun(db, 'entry')).toBeNull();
    expect(lastSuccessfulRun(db, 'entry')).not.toBeNull();
  });

  it('still reports a failure that came after the last success', () => {
    recordRun('entry', true, null, 100);
    recordRun('entry', false, 'disk I/O error', 200);

    expect(lastFailedRun(db, 'entry')!.note).toBe('disk I/O error');
  });

  it('puts the error on the dashboard instead of only the word "stale"', () => {
    recordRun('entry', false, 'HTTP 503 from the FPL API', nowSeconds());
    const state = getStateOfPlay(db, { teamId: 1, staleAfterSeconds: 3600 });
    const page = renderDashboard({ ...state, squadLoaded: false }).replace(/\s+/g, ' ');

    expect(page).toMatch(/HTTP 503 from the FPL API/);
    // And it must stop telling someone to press a button that will fail the same way.
    expect(page).toMatch(/failed to refresh/);
    expect(page).toMatch(/Pressing refresh again will not help/);
  });

  it('keeps the plain stale wording when nothing has actually failed', () => {
    // Never refreshed and failing to refresh are different problems with different answers.
    const state = getStateOfPlay(db, { teamId: 1, staleAfterSeconds: 1 });
    const page = renderDashboard({ ...state, squadLoaded: false }).replace(/\s+/g, ' ');

    expect(page).toMatch(/Some data is stale/);
    expect(page).not.toMatch(/failed to refresh/);
  });
});

describe('one broken step not taking the rest down', () => {
  /**
   * The cascade that caused this: per-player results failed, so the squad step after it never
   * ran, so the Dashboard reported the squad stale and pointed at a refresh button that would
   * fail in exactly the same place. Order in ingestAll is a dependency, not a chain of command.
   */
  it('refreshes the squad even when per-player results fail', async () => {
    const { ingestAll } = await import('../../src/ingest/index.js');
    const { StubFplApi: Stub } = await import('../../src/api/replayClient.js');
    const { fakeEntry, fakePicks, fakeFixture } = await import('../support/fakeApi.js');

    const db2 = openTestDatabase();
    const api = new Stub({
      bootstrap: fakeBootstrap({ events: [fakeEvent(1, { finished: true })] }),
      fixtures: [fakeFixture(1, 1, 1, 2)],
    });
    // Every element-summary request fails - the step that used to abort the whole refresh.
    api.elementSummary = async () => {
      throw new Error('HTTP 503');
    };

    const result = await ingestAll(db2, api, rules, { teamId: 77 });

    // The failing step is reported by name rather than thrown...
    expect(result.failures.join(' ')).toMatch(/Per-player results failed/);
    // ...and the refresh carried on to the steps after it instead of stopping dead.
    expect(result.failures.join(' ')).toMatch(/Your squad failed/);
    expect(result.bootstrap.rowsWritten).toBeGreaterThan(0);
  });

  it('treats every single player failing as an outage, not a quiet success', async () => {
    // Collecting per-player failures is right - one departed player must not cost the other
    // 700 histories. All of them failing is a different event entirely, and reporting it as a
    // successful import leaves the Dashboard saying "updated just now" while nothing was
    // written and the gameweek stays ungraded with no error anywhere.
    const { ingestPlayerSummaries } = await import('../../src/ingest/playerSummaries.js');
    const { StubFplApi: Stub } = await import('../../src/api/replayClient.js');

    const db2 = openTestDatabase();
    await ingestBootstrap(
      db2,
      new Stub({ bootstrap: fakeBootstrap({ events: [fakeEvent(1, { finished: true })] }) }),
      rules,
    );

    const api = new Stub({});
    api.elementSummary = async () => {
      throw new Error('HTTP 503');
    };

    await expect(ingestPlayerSummaries(db2, api)).rejects.toThrow(/None of the .* could be fetched/);
    // And it is recorded against the source, so the Dashboard can show why.
    expect(lastFailedRun(db2, 'element-summary')!.note).toMatch(/HTTP 503/);
  });

  it('still refuses to carry on without bootstrap', async () => {
    // The one step that is a real dependency: everything after it references the players and
    // gameweeks it writes, so a refresh that skipped it would look successful and leave the
    // database inconsistent.
    const { ingestAll } = await import('../../src/ingest/index.js');
    const { StubFplApi: Stub } = await import('../../src/api/replayClient.js');

    const db2 = openTestDatabase();
    const api = new Stub({});
    api.bootstrap = async () => {
      throw new Error('HTTP 500');
    };

    await expect(ingestAll(db2, api, rules, {})).rejects.toThrow(/HTTP 500/);
  });
});
