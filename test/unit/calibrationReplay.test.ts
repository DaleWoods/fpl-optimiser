import type { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import { saveCalibration } from '../../src/model/calibration.js';
import { computeReplayCalibration, replayProgress } from '../../src/model/calibrationReplay.js';
import { fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
// Every projection counts here: the test league's players are ordinary by design, and whether
// the pickable-players filter does its job is tested on its own in calibration.test.ts.
const base = loadModelWeights();
const weights = { ...base, calibration: { ...base.calibration, minProjected: 0, priorWeightPlayers: 1 } };

/**
 * The correction used to be learned only from projections stored at the time, under the exact
 * model version that made them - so every change to the scoring threw the learning away and
 * the model ran uncorrected for three gameweeks. That turned every fix into a trade against the
 * correction, and real faults were left in place or shipped switched off to avoid paying it.
 *
 * It is now learned by replaying past gameweeks under the current model, from only what was
 * knowable before each deadline.
 */
describe('learning the correction by replaying the season', () => {
  let db: Database;

  /** Everyone scores `points` in each of the given gameweeks. */
  function seedResults(eventIds: number[], points: number): void {
    const players = db.prepare('SELECT id FROM player').all() as { id: number }[];
    const insert = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, ?, ?, 90, 'test', ?)
       ON CONFLICT (player_id, event_id) DO UPDATE SET points = excluded.points`,
    );
    for (const eventId of eventIds) {
      for (const player of players) insert.run(player.id, eventId, points, nowSeconds());
    }
  }

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [1, 2, 3, 4, 5].map((id) => fakeEvent(id, { finished: id < 5, is_next: id === 5 })),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [1, 2, 3, 4, 5].map((gw) =>
          fakeFixture(gw, gw, 1, 2, gw < 5 ? { team_h_score: 1, team_a_score: 1, finished: true } : {}),
        ),
      }),
    );
    // Deadlines after the snapshot the ingest wrote, so it counts as "before the deadline".
    for (const gw of [1, 2, 3, 4, 5]) {
      db.prepare('UPDATE event SET deadline_time = ? WHERE id = ?').run(nowSeconds() + gw, gw);
    }
  });

  it('learns a correction with no projection ever having been stored', () => {
    // The whole point. Nothing was generated before any of these deadlines, so the old route
    // had nothing to learn from and would have waited three more gameweeks.
    seedResults([1, 2, 3, 4], 20);
    expect((db.prepare('SELECT COUNT(*) AS n FROM projection').get() as { n: number }).n).toBe(0);

    const factors = computeReplayCalibration(db, rules, weights);

    expect(factors.length).toBeGreaterThan(0);
    // Everyone scored far more than projected, so every position is corrected upward.
    for (const factor of factors) expect(factor.factor).toBeGreaterThan(1);
    expect(factors[0]!.gameweeks).toBe(4);
  });

  it('keeps what it has learned when the model version changes', () => {
    // A version bump used to reset the clock to zero. The replay does not care what the model
    // is called - it asks the model as it is now what it would have said then.
    seedResults([1, 2, 3, 4], 20);
    const renamed = { ...weights, modelVersion: 'heuristic-99.0.0' };

    expect(computeReplayCalibration(db, rules, renamed)).toEqual(
      computeReplayCalibration(db, rules, weights),
    );
  });

  it('uses nothing from a gameweek on or after the one being replayed', () => {
    // A replay of gameweek 3 may only be corrected by what gameweeks 1 and 2 taught. Change
    // what happened in gameweeks 3 and 4 as wildly as you like: the correction as it stood
    // before gameweek 3 must not move.
    const loose = { ...weights, calibration: { ...weights.calibration, minGameweeks: 2 } };
    seedResults([1, 2, 3, 4], 20);
    const before = computeReplayCalibration(db, rules, loose, 3);

    seedResults([3, 4], 0);
    const after = computeReplayCalibration(db, rules, loose, 3);

    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
    // And the live correction, which may use everything, does move.
    expect(computeReplayCalibration(db, rules, loose)).not.toEqual(before);
  });

  it('measures the raw model, not the model with its own correction applied', () => {
    // Measured against its own corrected output a working correction looks unnecessary and
    // removes itself. A stored correction, however large, must not change what is measured.
    //
    // The clamp is opened right up for this one. At its usual width a correction this size
    // pins to the maximum whether or not it was measured against itself, and the test would
    // pass with the fault in place.
    const open = { ...weights, calibration: { ...weights.calibration, maxFactor: 1000 } };
    seedResults([1, 2, 3, 4], 20);
    const clean = computeReplayCalibration(db, rules, open);

    saveCalibration(db, open.modelVersion, clean);
    const again = computeReplayCalibration(db, rules, {
      ...open,
      // Any change to the scoring forces a real replay rather than a remembered one.
      bonus: { ...open.bonus, maxExpectedBonus: open.bonus.maxExpectedBonus + 1e-9 },
    });

    expect(clean[0]!.factor).toBeGreaterThan(1.5);
    expect(again.map((f) => f.factor)).toEqual(clean.map((f) => f.factor));
  });

  it('says how many gameweeks it can learn from', () => {
    seedResults([1, 2], 5);
    expect(replayProgress(db, weights)).toEqual({ replayable: 2, needed: weights.calibration.minGameweeks });
  });

  it('applies no correction at all when a replay asks for none', () => {
    seedResults([1, 2, 3, 4], 20);
    saveCalibration(db, weights.modelVersion, computeReplayCalibration(db, rules, weights));

    const corrected = buildProjections(db, 5, rules, weights);
    const raw = buildProjections(db, 5, rules, weights, { calibrationFactors: null });

    expect(corrected.some((p) => p.calibrationFactor !== undefined)).toBe(true);
    expect(raw.every((p) => p.calibrationFactor === undefined)).toBe(true);
  });

  it('hands the backtest the correction as it stood before each deadline', () => {
    // Wiring, guarded apart from behaviour: the as-of correction can be perfectly right while
    // the backtest goes on applying the stored one, and every other test would stay green
    // while the replay quietly scored a model that had already seen the answers.
    const source = readFileSync(new URL('../../src/model/backtest.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/calibrationFactors:\s*replayCalibrationFactors\(db, rules, weights, eventId\)/);
  });
});
