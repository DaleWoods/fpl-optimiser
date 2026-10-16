import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadRules } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap } from '../../src/ingest/index.js';
import {
  gameweeksMissingResults,
  syncActualPointsFromFixtureHistory,
} from '../../src/ingest/playerSummaries.js';
import { fakeBootstrap, fakeEvent } from '../support/fakeApi.js';

const rules = loadRules();

/**
 * A gameweek finished while the app was down with a full disk, and it never graded afterwards.
 * The trigger that should have fetched its results asked the wrong question in two ways, and
 * both are reproduced here because both were live.
 */
describe('catching up a gameweek that finished while the app was down', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [
            fakeEvent(5, { finished: true }),
            fakeEvent(6, { finished: true }),
            fakeEvent(7, { finished: false, is_current: true }),
          ],
        }),
      }),
      rules,
    );
  });

  function addHistory(eventId: number, playerIds: number[]): void {
    const insert = db.prepare(
      `INSERT INTO player_fixture_history (player_id, fixture_id, event_id, minutes, total_points,
                                           updated_at, raw_json)
       VALUES (?, ?, ?, 90, 6, 0, '{}')`,
    );
    for (const id of playerIds) insert.run(id, eventId * 1000 + id, eventId);
  }

  function addResults(eventId: number, playerIds: number[]): void {
    const insert = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, ?, 6, 90, 'test', ?)`,
    );
    for (const id of playerIds) insert.run(id, eventId, nowSeconds());
  }

  it('spots a finished gameweek with no results, not just the most recent one', () => {
    // The second half of the fault. Only the latest finished gameweek was ever examined, so
    // anything that finished while the app was down was written off the moment a later one
    // arrived - and never looked at again.
    addResults(6, [1, 2, 3]);

    expect(gameweeksMissingResults(db)).toEqual([5]);
  });

  it('asks whether a gameweek can be graded, not whether history happens to exist', () => {
    // The first half, and the one that actually bit. History for gameweek 6 was written, the
    // step that turns it into results never ran, and the old trigger - which checked for
    // history - considered the gameweek captured from then on.
    addHistory(6, [1, 2, 3]);
    addResults(5, [1, 2, 3]);

    expect(gameweeksMissingResults(db)).toContain(6);
  });

  it('turns stored history into results without fetching anything', () => {
    // The cheap half of the repair: when the history is already on disk, grading needs no
    // requests at all - and this now runs on every refresh rather than only inside the fetch
    // it was previously buried in.
    addHistory(6, [1, 2, 3, 4]);
    expect(gameweeksMissingResults(db)).toContain(6);

    const recorded = syncActualPointsFromFixtureHistory(db);

    expect(recorded).toBe(4);
    expect(gameweeksMissingResults(db)).not.toContain(6);
  });

  it('never claims a gameweek still being played is missing its results', () => {
    // Gameweek 7 has not finished. Reporting it as ungraded would send the app fetching 700
    // players' histories every refresh for results that do not exist yet.
    addResults(5, [1]);
    addResults(6, [1]);

    expect(gameweeksMissingResults(db)).toEqual([]);
  });

  it('is safe to run twice', () => {
    // It runs on every refresh now, so a second pass must record nothing new rather than
    // rewriting every row it already wrote.
    addHistory(6, [1, 2, 3]);
    expect(syncActualPointsFromFixtureHistory(db)).toBe(3);
    const before = db.prepare('SELECT COUNT(*) AS n FROM actual_points').get() as { n: number };
    syncActualPointsFromFixtureHistory(db);
    const after = db.prepare('SELECT COUNT(*) AS n FROM actual_points').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('ignores history rows belonging to no gameweek', () => {
    // Friendlies and rearranged ties come back with a null event, and scoring them against a
    // gameweek that never happened would invent results.
    db.prepare(
      `INSERT INTO player_fixture_history (player_id, fixture_id, event_id, minutes, total_points,
                                           updated_at, raw_json)
       VALUES (1, 9999, NULL, 90, 6, 0, '{}')`,
    ).run();

    expect(syncActualPointsFromFixtureHistory(db)).toBe(0);
  });
});
