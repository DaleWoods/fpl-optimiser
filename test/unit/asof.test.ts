import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import { recentFixturesByPlayer } from '../../src/model/recentForm.js';
import { computeTeamForm } from '../../src/model/table.js';
import { fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

/**
 * Everything the backtest claims rests on this one property: when replaying gameweek N, the
 * model must not be able to see gameweek N or anything after it.
 *
 * Pinning the snapshot is not enough. The model also reads per-player match history and finished
 * results, and neither is tied to a snapshot - so without an explicit cutoff a replay of
 * gameweek 3 reads gameweeks 4, 5 and 6, scores itself on knowledge it could not have had, and
 * reports a model far better than the one that exists. A backtest that leaks is worse than no
 * backtest, because it is confidently wrong.
 */
describe('no lookahead when replaying a past gameweek', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [1, 2, 3, 4, 5].map((id) => fakeEvent(id, { finished: id < 5 })),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          fakeFixture(1, 1, 1, 2, { team_h_score: 1, team_a_score: 1, finished: true }),
          fakeFixture(2, 2, 1, 3, { team_h_score: 2, team_a_score: 0, finished: true }),
          fakeFixture(3, 3, 1, 4, { team_h_score: 5, team_a_score: 0, finished: true }),
          fakeFixture(4, 4, 1, 2, { team_h_score: 6, team_a_score: 0, finished: true }),
          fakeFixture(5, 5, 1, 3),
        ],
      }),
    );

    // One player with a match in every gameweek, each distinguishable by its score.
    const insert = db.prepare(
      `INSERT INTO player_fixture_history (player_id, fixture_id, event_id, minutes, total_points,
                                           goals_scored, expected_goals, expected_goals_conceded,
                                           updated_at, raw_json)
       VALUES (1, ?, ?, 90, ?, ?, ?, 0.5, 0, '{}')`,
    );
    for (const gw of [1, 2, 3, 4]) insert.run(gw, gw, gw * 2, gw, gw * 0.5);
  });

  it('hides a player\'s later matches from his recent form', () => {
    const all = recentFixturesByPlayer(db, 10).get(1) ?? [];
    expect(all.map((row) => row.eventId)).toEqual([4, 3, 2, 1]);

    // Replaying gameweek 3: gameweeks 3 and 4 have not happened yet.
    const asOf3 = recentFixturesByPlayer(db, 10, 3).get(1) ?? [];
    expect(asOf3.map((row) => row.eventId)).toEqual([2, 1]);
  });

  it('hides later results from club form, on both the xG and the goals route', () => {
    const all = computeTeamForm(db);
    const asOf2 = computeTeamForm(db, 2);

    // Club 1 scored 1, 2, 5 then 6. Seen from before gameweek 2, only the first counts.
    expect(all.get(1)!.matches).toBeGreaterThan(asOf2.get(1)!.matches);
    expect(asOf2.get(1)!.matches).toBe(1);
  });

  it('produces a different projection when the future is hidden, and the same one when it is not', () => {
    const withEverything = buildProjections(db, 5, rules, weights);
    const asOfGw3 = buildProjections(db, 5, rules, weights, { asOfEventId: 3 });
    const alsoEverything = buildProjections(db, 5, rules, weights, { asOfEventId: 99 });

    const find = (list: typeof withEverything) => list.find((p) => p.playerId === 1)!;
    expect(find(withEverything).xPts).not.toBeCloseTo(find(asOfGw3).xPts, 4);
    // A cutoff beyond every gameweek hides nothing, so it must match the unrestricted run
    // exactly - otherwise the cutoff is changing something it has no business changing.
    expect(find(alsoEverything).xPts).toBeCloseTo(find(withEverything).xPts, 10);
  });

  it('gives the same answer as a world where the later gameweeks never happened', async () => {
    // The property the whole backtest rests on, stated the only way worth stating it: hiding
    // gameweeks 3 and 4 must produce exactly what a database that has never seen gameweeks 3
    // and 4 produces. Anything the cutoff forgets to filter shows up here as a difference.
    //
    // It caught one. The start-rate denominator - how many matches a club has played - was
    // counting every finished fixture in the database. Replaying gameweek 3 read a snapshot in
    // which a nailed-on starter had 2 starts and divided it by the club's 4 finished matches,
    // so his start rate collapsed from 2/2 to 2/4. Every replayed week was scored on a model
    // that believed its own starters were rotation risks, dragging the backtest's verdict down
    // by an amount that had nothing to do with the model under test.
    db.prepare('UPDATE player_snapshot SET minutes = 180, starts = 2 WHERE player_id = 1').run();

    const unaware = openTestDatabase();
    await ingestBootstrap(
      unaware,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [1, 2, 3, 4, 5].map((id) => fakeEvent(id, { finished: id < 3 })),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      unaware,
      new StubFplApi({
        fixtures: [
          fakeFixture(1, 1, 1, 2, { team_h_score: 1, team_a_score: 1, finished: true }),
          fakeFixture(2, 2, 1, 3, { team_h_score: 2, team_a_score: 0, finished: true }),
          // Gameweeks 3 and 4 are still to come in this world, so they carry no result.
          fakeFixture(3, 3, 1, 4),
          fakeFixture(4, 4, 1, 2),
          fakeFixture(5, 5, 1, 3),
        ],
      }),
    );
    const insert = unaware.prepare(
      `INSERT INTO player_fixture_history (player_id, fixture_id, event_id, minutes, total_points,
                                           goals_scored, expected_goals, expected_goals_conceded,
                                           updated_at, raw_json)
       VALUES (1, ?, ?, 90, ?, ?, ?, 0.5, 0, '{}')`,
    );
    for (const gw of [1, 2]) insert.run(gw, gw, gw * 2, gw, gw * 0.5);
    unaware.prepare('UPDATE player_snapshot SET minutes = 180, starts = 2 WHERE player_id = 1').run();

    const replayed = buildProjections(db, 5, rules, weights, { asOfEventId: 3 });
    const genuine = buildProjections(unaware, 5, rules, weights);

    const a = replayed.find((p) => p.playerId === 1)!;
    const b = genuine.find((p) => p.playerId === 1)!;
    expect(a.expectedMinutes).toBeCloseTo(b.expectedMinutes, 6);
    expect(a.xPts).toBeCloseTo(b.xPts, 6);
  });

  it('replays from a chosen snapshot rather than the newest one', () => {
    // Prices move; a replay has to use the price that was showing before that deadline.
    const first = (db.prepare('SELECT id FROM snapshot ORDER BY id ASC LIMIT 1').get() as { id: number }).id;
    const later = Number(db.prepare('INSERT INTO snapshot (taken_at) VALUES (4000000000)').run().lastInsertRowid);
    db.prepare(
      `INSERT INTO player_snapshot (snapshot_id, player_id, taken_at, now_cost, status, raw_json)
       SELECT ?, player_id, 4000000000, 999, status, '' FROM player_snapshot WHERE snapshot_id = ?`,
    ).run(later, first);

    const newest = buildProjections(db, 5, rules, weights);
    const pinned = buildProjections(db, 5, rules, weights, { asOfSnapshotId: first });

    expect(newest.find((p) => p.playerId === 1)!.price).toBe(999);
    expect(pinned.find((p) => p.playerId === 1)!.price).not.toBe(999);
  });
});
