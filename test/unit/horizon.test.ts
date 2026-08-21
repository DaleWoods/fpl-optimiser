import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import { computeHorizon, horizonFor } from '../../src/model/horizon.js';
import { defaultTeams, fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

describe('horizon', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [
            fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' }),
            fakeEvent(2, { deadline_time: '2099-08-28T17:30:00Z' }),
            fakeEvent(3, { deadline_time: '2099-09-04T17:30:00Z' }),
          ],
        }),
      }),
      rules,
    );
  });

  it('enumerates gameweeks from the target forward, capped at the requested length', async () => {
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [fakeFixture(1, 1, 1, 2), fakeFixture(2, 2, 1, 2), fakeFixture(3, 3, 1, 2)],
      }),
    );

    const horizon = computeHorizon(db, rules, weights, 1, 2);
    expect(horizon.gameweeks.map((gw) => gw.eventId)).toEqual([1, 2]);
  });

  it('stops early when fewer gameweeks exist than requested', async () => {
    await ingestFixtures(db, new StubFplApi({ fixtures: [fakeFixture(1, 3, 1, 2)] }));

    // Only gameweek 3 has a fixture, but the event table has events 1-3 - starting from 3
    // leaves just one gameweek to look ahead over, however large the request.
    const horizon = computeHorizon(db, rules, weights, 3, 10);
    expect(horizon.gameweeks).toHaveLength(1);
  });

  it('decays weight geometrically, full weight on the target week', async () => {
    await ingestFixtures(
      db,
      new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2), fakeFixture(2, 2, 1, 2)] }),
    );

    const horizon = computeHorizon(db, rules, weights, 1, 2);
    expect(horizon.gameweeks[0]!.weight).toBe(1);
    expect(horizon.gameweeks[1]!.weight).toBeCloseTo(weights.horizon.decay, 6);
  });

  it('reports which horizon gameweeks actually have fixtures imported', async () => {
    // Only gameweek 1 has fixtures; 2 and 3 are still blank in the database.
    await ingestFixtures(db, new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2)] }));

    const horizon = computeHorizon(db, rules, weights, 1, 3);
    expect(horizon.gameweeks.map((gw) => gw.fixtureCount)).toEqual([1, 0, 0]);
  });

  it('leaves futureXPts at zero when later gameweeks have no fixtures imported', async () => {
    await ingestFixtures(db, new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2)] }));

    const horizon = computeHorizon(db, rules, weights, 1, 5);
    const projections = buildProjections(db, 1, rules, weights);
    const player = projections.find((p) => p.xPts > 0)!;
    const h = horizonFor(horizon, player.playerId);

    expect(h.currentXPts).toBeCloseTo(player.xPts, 6);
    // Blank gameweeks contribute nothing, so the horizon collapses to just this week's number.
    expect(h.horizonXPts).toBeCloseTo(player.xPts, 6);
    expect(h.futureXPts).toBeCloseTo(0, 6);
  });

  it('matches a target week with easier fixtures against a harder run after it', async () => {
    // Club 1 gets a soft touch in gameweek 1, then faces the same tough opponent twice more.
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [fakeFixture(1, 1, 1, 3), fakeFixture(2, 2, 1, 2), fakeFixture(3, 3, 1, 2)],
      }),
    );

    const horizon = computeHorizon(db, rules, weights, 1, 3);
    const gw1 = buildProjections(db, 1, rules, weights);
    const gw2 = buildProjections(db, 2, rules, weights);
    const gw3 = buildProjections(db, 3, rules, weights);

    const playerId = gw1.find((p) => p.clubShort === defaultTeams()[0]!.short_name)!.playerId;
    const p1 = gw1.find((p) => p.playerId === playerId)!.xPts;
    const p2 = gw2.find((p) => p.playerId === playerId)!.xPts;
    const p3 = gw3.find((p) => p.playerId === playerId)!.xPts;

    const h = horizonFor(horizon, playerId);
    const decay = weights.horizon.decay;
    const expectedHorizon = p1 * 1 + p2 * decay + p3 * decay ** 2;

    expect(h.currentXPts).toBeCloseTo(p1, 6);
    expect(h.horizonXPts).toBeCloseTo(expectedHorizon, 2);
    expect(h.futureXPts).toBeCloseTo(expectedHorizon - p1, 2);
  });

  it('gives zeros for a player nowhere in the horizon', () => {
    const horizon = computeHorizon(db, rules, weights, 1, 3);
    expect(horizonFor(horizon, 999999)).toEqual({
      playerId: 999999,
      currentXPts: 0,
      horizonXPts: 0,
      futureXPts: 0,
    });
  });
});
