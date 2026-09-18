import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadRules } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap } from '../../src/ingest/index.js';
import { benchmarkGameweek, benchmarkSeason } from '../../src/model/benchmark.js';
import { fakeBootstrap, fakeEvent } from '../support/fakeApi.js';

const rules = loadRules();

/**
 * The point of a benchmark is that it can say the model LOST. A comparison that only ever
 * flatters the thing it measures is worse than none, so most of these set the model up to lose
 * and check that it is reported as losing.
 */
describe('is the model better than not having one', () => {
  let db: Database;
  const players = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [fakeEvent(1, { finished: true, deadline_time: '2020-08-14T17:30:00Z' })],
        }),
      }),
      rules,
    );
    db.prepare('UPDATE event SET deadline_time = ? WHERE id = 1').run(2_000_000_000);
    // Ingest writes a snapshot of its own, taken now and so before the deadline. Clearing it
    // lets each test control exactly which snapshot the query is allowed to find.
    db.prepare('DELETE FROM player_snapshot').run();
  });

  /**
   * Seed one gameweek: what the model said, what FPL said, what form said, what happened.
   * `snapshotAt` defaults to before the deadline - the only data a fair comparison may use.
   */
  function seed(opts: {
    model: (id: number) => number;
    fpl: (id: number) => number;
    form: (id: number) => number;
    actual: (id: number) => number;
    snapshotAt?: number;
  }): void {
    const snapshot = db
      .prepare('INSERT INTO snapshot (taken_at) VALUES (?)')
      .run(opts.snapshotAt ?? 1_999_999_000).lastInsertRowid as number;

    const insertSnapshot = db.prepare(
      `INSERT INTO player_snapshot (snapshot_id, player_id, taken_at, now_cost, status,
                                    ep_next, points_per_game, raw_json)
       VALUES (?, ?, ?, 50, 'a', ?, ?, '{}')`,
    );
    const insertProjection = db.prepare(
      `INSERT INTO projection (player_id, event_id, model_version, created_at, xpts, xpts_raw,
                               availability_probability, expected_minutes, fixture_count,
                               confidence, breakdown_json)
       VALUES (?, 1, 'test', ?, ?, ?, 1, 80, 1, 'high', '{}')`,
    );
    const insertActual = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, 1, ?, 90, 'test', ?)`,
    );

    for (const id of players) {
      insertSnapshot.run(
        snapshot,
        id,
        opts.snapshotAt ?? 1_999_999_000,
        opts.fpl(id),
        opts.form(id),
      );
      insertProjection.run(id, nowSeconds(), opts.model(id), opts.model(id));
      insertActual.run(id, opts.actual(id), nowSeconds());
    }
  }

  const line = (result: ReturnType<typeof benchmarkGameweek>, key: string) =>
    result!.lines.find((l) => l.key === key)!;

  it('says the model won when it really is closer than both baselines', () => {
    seed({
      actual: (id) => id,
      model: (id) => id + 0.1,   // almost exactly right
      fpl: (id) => id + 2,       // two points out every time
      form: (id) => id + 3,
    });

    const result = benchmarkGameweek(db, 1)!;
    expect(result.verdict).toBe('model-best');
    expect(result.beatenBy).toEqual([]);
    expect(line(result, 'model').meanAbsoluteError).toBeCloseTo(0.1, 5);
    expect(line(result, 'fpl').meanAbsoluteError).toBeCloseTo(2, 5);
    // Stated as a share of the baseline's own error, so "20% better" means something.
    expect(line(result, 'fpl').improvementOverModel).toBeCloseTo(0.95, 2);
  });

  it('says the model LOST when FPL\'s own free number is closer', () => {
    // The finding this whole module exists to be capable of producing. If the app cannot beat
    // the number the API publishes for nothing, the app is making things worse and should say
    // so rather than reporting its own error in isolation and leaving it sounding fine.
    seed({
      actual: (id) => id,
      model: (id) => id + 3,
      fpl: (id) => id + 0.5,
      form: (id) => id + 4,
    });

    const result = benchmarkGameweek(db, 1)!;
    expect(result.verdict).toBe('model-beaten');
    expect(result.beatenBy).toContain("FPL's own number");
    expect(line(result, 'fpl').improvementOverModel).toBeLessThan(0);
  });

  it('calls a hair\'s difference a tie rather than a win', () => {
    seed({
      actual: (id) => id,
      model: (id) => id + 2.0,
      fpl: (id) => id + 2.01,
      form: (id) => id + 2.0,
    });
    expect(benchmarkGameweek(db, 1)!.verdict).toBe('model-tied');
  });

  it('ignores anything the API said after the deadline', () => {
    // A baseline fed with what was known afterwards is not a baseline, it is hindsight, and it
    // would make the model look bad for the wrong reason.
    seed({
      actual: (id) => id,
      model: (id) => id + 1,
      fpl: (id) => id + 1,
      form: (id) => id + 1,
      snapshotAt: 2_000_000_500, // after the deadline
    });
    expect(benchmarkGameweek(db, 1)).toBeNull();
  });

  it('scores nobody the baselines cannot answer for', () => {
    seed({ actual: (id) => id, model: (id) => id, fpl: (id) => id, form: (id) => id });
    db.prepare('UPDATE player_snapshot SET ep_next = NULL WHERE player_id <= 4').run();

    // Six left, not ten - and crucially not ten with four scored as zero, which would hand the
    // model a win by punishing the baseline for declining to answer.
    expect(benchmarkGameweek(db, 1)!.players).toBe(6);
  });

  it('pools gameweeks by how many players each actually scored', () => {
    seed({ actual: (id) => id, model: (id) => id + 1, fpl: (id) => id + 2, form: (id) => id + 3 });
    const one = benchmarkGameweek(db, 1)!;
    const pooled = benchmarkSeason(db, [1])!;

    expect(pooled.players).toBe(one.players);
    expect(pooled.lines.find((l) => l.key === 'model')!.meanAbsoluteError).toBeCloseTo(
      line(one, 'model').meanAbsoluteError,
      5,
    );
  });

  it('says nothing at all rather than guessing when there is nothing to compare', () => {
    expect(benchmarkGameweek(db, 1)).toBeNull();
    expect(benchmarkSeason(db, [1])).toBeNull();
  });
});
