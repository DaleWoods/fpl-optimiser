import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import {
  computeCalibration,
  loadCalibration,
  saveCalibration,
} from '../../src/model/calibration.js';
import type { ModelWeights } from '../../src/config/schema.js';
import { fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

describe('calibration from the model\'s own error', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [1, 2, 3, 4].map((id) => fakeEvent(id, { finished: true })),
        }),
      }),
      rules,
    );
  });

  /** Player ids by position, from the seeded league: 1-2 GKP, 3-7 DEF, 8-12 MID, 13-15 FWD. */
  const forwards = [13, 14, 15];
  const midfielders = [8, 9, 10, 11, 12];

  /**
   * Write graded projections: one projection and one actual per player per gameweek. `ratio` is
   * what actually happened relative to what was projected, which is exactly the thing the
   * correction is meant to recover.
   */
  function grade(
    playerIds: number[],
    events: number[],
    predicted: number,
    ratio: number,
    options: { modelVersion?: string; calibratedBy?: number } = {},
  ): void {
    const version = options.modelVersion ?? weights.modelVersion;
    const factor = options.calibratedBy ?? 1;
    const insertProjection = db.prepare(
      `INSERT INTO projection (player_id, event_id, model_version, created_at, xpts, xpts_raw,
                               xpts_uncalibrated, availability_probability, expected_minutes,
                               fixture_count, confidence, breakdown_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 80, 1, 'high', '{}')`,
    );
    const insertActual = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, ?, ?, 90, 'test', ?)
       ON CONFLICT (player_id, event_id) DO UPDATE SET points = excluded.points`,
    );
    for (const event of events) {
      for (const id of playerIds) {
        // What the page showed is the calibrated figure; what a correction is measured against
        // is the uncalibrated one beside it. Held apart deliberately - see test 6.
        insertProjection.run(id, event, version, nowSeconds(), predicted * factor, predicted, predicted);
        insertActual.run(id, event, Math.round(predicted * ratio), nowSeconds());
      }
    }
  }

  const withWeights = (overrides: Partial<ModelWeights['calibration']>): ModelWeights => ({
    ...weights,
    calibration: { ...weights.calibration, ...overrides },
  });

  it('returns nothing until enough gameweeks have been graded', () => {
    // One or two gameweeks of "lean" is one or two gameweeks of football being football.
    grade(forwards, [1, 2], 5, 2.0);
    expect(computeCalibration(db, withWeights({ minGameweeks: 3 }))).toEqual([]);
  });

  it('corrects upward when the model has been projecting low', () => {
    grade(forwards, [1, 2, 3], 5, 2.0);
    const factors = computeCalibration(db, withWeights({ priorWeightPlayers: 1 }));
    const fwd = factors.find((f) => f.position === 'FWD')!;

    expect(fwd.factor).toBeGreaterThan(1);
    expect(fwd.factor).toBeLessThanOrEqual(weights.calibration.maxFactor);
    // Bias is predicted minus actual, matching accuracy.ts: projecting low reads negative.
    expect(fwd.observedBias).toBeLessThan(0);
  });

  it('corrects downward when the model has been projecting high', () => {
    grade(forwards, [1, 2, 3], 8, 0.25);
    const factors = computeCalibration(db, withWeights({ priorWeightPlayers: 1 }));
    const fwd = factors.find((f) => f.position === 'FWD')!;

    expect(fwd.factor).toBeLessThan(1);
    expect(fwd.factor).toBeGreaterThanOrEqual(weights.calibration.minFactor);
    expect(fwd.observedBias).toBeGreaterThan(0);
  });

  it('shrinks a thin sample toward no correction at all', () => {
    // The same measured ratio, believed far less when there is barely any evidence for it. This
    // is the same caution every other rate in the model gets, applied to the correction itself.
    grade(forwards, [1, 2, 3], 5, 2.0);
    const thin = computeCalibration(db, withWeights({ priorWeightPlayers: 5000 }))
      .find((f) => f.position === 'FWD')!;
    const trusted = computeCalibration(db, withWeights({ priorWeightPlayers: 1 }))
      .find((f) => f.position === 'FWD')!;

    expect(Math.abs(thin.factor - 1)).toBeLessThan(Math.abs(trusted.factor - 1));
  });

  it('clamps a correction too large to be a lean rather than a bug', () => {
    grade(forwards, [1, 2, 3], 2, 5.0);
    const fwd = computeCalibration(db, withWeights({ priorWeightPlayers: 1 }))
      .find((f) => f.position === 'FWD')!;

    expect(fwd.factor).toBe(weights.calibration.maxFactor);
  });

  it('keeps a working correction instead of reverting once it starts working', () => {
    // The failure this design exists to prevent, and it is not runaway growth - it is reversion.
    // Learn a factor, apply it, and the projections become accurate. Measure that corrected
    // output and the ratio comes back at 1.0, so the correction that was working gets thrown
    // away, the error returns next week, and the model flips between corrected and uncorrected
    // forever with no way to tell which state any week's advice was in.
    grade(forwards, [1, 2, 3], 5, 1.2);
    const first = computeCalibration(db, withWeights({ priorWeightPlayers: 1 }))
      .find((f) => f.position === 'FWD')!;
    expect(first.factor).toBeGreaterThan(1.1);

    // Gameweek 4, projected with that correction applied: xpts carries it, xpts_uncalibrated
    // does not, and the actual now matches the corrected figure exactly - the correction worked.
    grade(forwards, [4], 5, 1.2, { calibratedBy: first.factor });
    const second = computeCalibration(db, withWeights({ priorWeightPlayers: 1 }))
      .find((f) => f.position === 'FWD')!;

    expect(second.factor).toBeCloseTo(first.factor, 2);
    expect(second.factor).toBeGreaterThan(1.1);
  });

  it('never applies a factor learned under a different model version', () => {
    // A correction describes the mistakes of the model that made them. Carrying it across a
    // scoring change would be correcting something that no longer exists, so a version bump
    // resets the learning - intended, not a gap.
    saveCalibration(db, 'heuristic-0.99.0', [
      { position: 'FWD', factor: 1.2, observedBias: -1, samplePlayers: 900, gameweeks: 5 },
    ]);

    expect(loadCalibration(db, weights.modelVersion).size).toBe(0);
    expect(loadCalibration(db, 'heuristic-0.99.0').size).toBe(1);
  });

  it('measures each position separately, and says nothing about one it has not seen', () => {
    grade(forwards, [1, 2, 3], 5, 2.0);
    grade(midfielders, [1, 2, 3], 5, 1.0);
    const factors = computeCalibration(db, withWeights({ priorWeightPlayers: 1 }));

    expect(factors.find((f) => f.position === 'FWD')!.factor).toBeGreaterThan(1);
    expect(factors.find((f) => f.position === 'MID')!.factor).toBeCloseTo(1, 2);
    // No defender was ever graded. That is "not measured", which is a different claim from
    // "measured and fine", so there must be no row for it at all rather than a neutral one.
    expect(factors.find((f) => f.position === 'DEF')).toBeUndefined();
  });

  it('projects exactly as it would with no correction at all when disabled', async () => {
    // The switch has to be a real switch. A correction you cannot turn off is a correction you
    // cannot check, and the whole reason this is allowed to touch xPts is that it is inspectable
    // and reversible.
    await ingestFixtures(
      db,
      new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 3, 4)] }),
    );
    saveCalibration(db, weights.modelVersion, [
      { position: 'FWD', factor: 1.25, observedBias: -2, samplePlayers: 900, gameweeks: 5 },
      { position: 'MID', factor: 0.8, observedBias: 2, samplePlayers: 900, gameweeks: 5 },
    ]);

    const off = buildProjections(db, 1, rules, withWeights({ enabled: false }));
    const on = buildProjections(db, 1, rules, withWeights({ enabled: true }));

    expect(off.length).toBeGreaterThan(0);
    for (const player of off) {
      expect(player.calibrationFactor).toBeUndefined();
    }
    // And with it on, the same players really are different - otherwise the assertion above
    // would pass for the trivial reason that nothing was ever applied either way.
    const corrected = on.filter((p) => p.calibrationFactor !== undefined);
    expect(corrected.length).toBeGreaterThan(0);
    for (const player of corrected) {
      const before = off.find((p) => p.playerId === player.playerId)!;
      expect(player.xPtsUncalibrated).toBeCloseTo(before.xPts, 6);
      expect(player.xPts).not.toBeCloseTo(before.xPts, 6);
      // The breakdown describes the model that produced it and is deliberately not rescaled.
      expect(player.breakdown).toEqual(before.breakdown);
    }
  });

  it('round-trips through storage unchanged', () => {
    grade(forwards, [1, 2, 3], 5, 2.0);
    const computed = computeCalibration(db, withWeights({ priorWeightPlayers: 1 }));
    saveCalibration(db, weights.modelVersion, computed);
    saveCalibration(db, weights.modelVersion, computed); // upsert, not a duplicate row

    const loaded = loadCalibration(db, weights.modelVersion);
    expect(loaded.size).toBe(computed.length);
    expect(loaded.get('FWD')!.factor).toBe(computed.find((f) => f.position === 'FWD')!.factor);
  });
});
