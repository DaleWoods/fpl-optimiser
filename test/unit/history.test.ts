import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures, ingestPlayerSummaries } from '../../src/ingest/index.js';
import { ingestEliteOwnership, latestEliteOwnership } from '../../src/ingest/elite.js';
import { buildProjections } from '../../src/model/build.js';
import {
  defaultPlayers,
  fakeBootstrap,
  fakeElementSummary,
  fakeEvent,
  fakeFixture,
  fakePicks,
} from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

function pastSeason(overrides: Record<string, unknown> = {}) {
  return {
    season_name: '2025/26',
    element_code: 200001,
    start_cost: 50,
    end_cost: 55,
    total_points: 180,
    minutes: 3000,
    starts: 33,
    goals_scored: 15,
    assists: 10,
    clean_sheets: 8,
    goals_conceded: 30,
    saves: 0,
    bonus: 20,
    bps: 700,
    yellow_cards: 4,
    red_cards: 0,
    expected_goals: '13.5',
    expected_assists: '9.2',
    expected_goal_involvements: '22.7',
    expected_goals_conceded: '31.0',
    defensive_contribution: '120',
    ...overrides,
  };
}

describe('previous-season history', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
          // Nobody has played yet this season: exactly the state before gameweek 1.
          players: defaultPlayers().map((p) => ({ ...p, minutes: 0, starts: 0, total_points: 0 })),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 3, 4)] }),
    );
  });

  it('stores last season totals from element-summary', async () => {
    const api = new StubFplApi({
      elementSummary: {
        11: { ...fakeElementSummary(11, []), history_past: [pastSeason()] },
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11] });

    const row = db
      .prepare(
        `SELECT season_name AS season, total_points AS points, expected_goals AS xg
         FROM player_season_history WHERE player_id = 11`,
      )
      .get() as { season: string; points: number; xg: number };

    expect(row.season).toBe('2025/26');
    expect(row.points).toBe(180);
    expect(row.xg).toBeCloseTo(13.5);
  });

  it('is idempotent across re-ingestion', async () => {
    const api = new StubFplApi({
      elementSummary: { 11: { ...fakeElementSummary(11, []), history_past: [pastSeason()] } },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11] });
    await ingestPlayerSummaries(db, api, { playerIds: [11] });

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM player_season_history WHERE player_id = 11')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('uses last season to separate players when this season has no minutes', async () => {
    // Two identical midfielders at the same club and price. Only last season tells them apart.
    const api = new StubFplApi({
      elementSummary: {
        11: {
          ...fakeElementSummary(11, []),
          history_past: [pastSeason({ expected_goals: '18.0', expected_assists: '12.0', total_points: 240 })],
        },
        12: {
          ...fakeElementSummary(12, []),
          history_past: [pastSeason({ expected_goals: '1.0', expected_assists: '1.0', total_points: 40 })],
        },
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11, 12] });

    const projections = buildProjections(db, 1, rules, weights);
    const good = projections.find((p) => p.playerId === 11)!;
    const poor = projections.find((p) => p.playerId === 12)!;

    expect(good.xPts).toBeGreaterThan(poor.xPts);
  });

  it('says in plain English that it is using last season', async () => {
    const api = new StubFplApi({
      elementSummary: {
        11: { ...fakeElementSummary(11, []), history_past: [pastSeason({ total_points: 240 })] },
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11] });

    const projection = buildProjections(db, 1, rules, weights).find((p) => p.playerId === 11)!;
    expect(projection.reasons.join(' ')).toMatch(/Rates are from 2025\/26 \(240 points\)/);
    expect(projection.reasons.join(' ')).toMatch(/roles change over a summer/);
  });

  it('never treats last season as high confidence', async () => {
    const api = new StubFplApi({
      elementSummary: { 11: { ...fakeElementSummary(11, []), history_past: [pastSeason()] } },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11] });

    const projection = buildProjections(db, 1, rules, weights).find((p) => p.playerId === 11)!;
    expect(projection.confidence).not.toBe('high');
  });

  it('prefers this season once real minutes exist', async () => {
    // Re-ingest with this season's minutes on the books.
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
          players: defaultPlayers().map((p) =>
            p.id === 11 ? { ...p, minutes: 900, starts: 10, expected_goals: 9 } : p,
          ),
        }),
      }),
      rules,
    );
    const api = new StubFplApi({
      elementSummary: {
        11: { ...fakeElementSummary(11, []), history_past: [pastSeason({ expected_goals: '0.1' })] },
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11] });

    const projection = buildProjections(db, 1, rules, weights).find((p) => p.playerId === 11)!;
    expect(projection.reasons.join(' ')).not.toMatch(/Rates are from/);
  });
});

describe('elite manager ownership', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
  });

  it('samples what top managers own and starts', async () => {
    const api = new StubFplApi({
      leagues: {
        '314:1': {
          standings: {
            results: [
              { entry: 1001, entry_name: 'Top', player_name: 'A', rank: 1, total: 100 },
              { entry: 1002, entry_name: 'Second', player_name: 'B', rank: 2, total: 99 },
            ],
          },
        },
      },
      picks: {
        '1001:1': fakePicks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
        '1002:1': fakePicks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19]),
      },
    });

    const result = await ingestEliteOwnership(db, api, { eventId: 1, managers: 2 });
    expect(result.managersSampled).toBe(2);

    const ownership = latestEliteOwnership(db);
    // Player 1 is in both squads and captained by both.
    expect(ownership.get(1)?.ownership).toBe(1);
    expect(ownership.get(1)?.captainedBy).toBe(2);
    // Player 16 is in one squad only.
    expect(ownership.get(16)?.ownership).toBe(0.5);
  });

  it('reports rather than fails when the season has not started', async () => {
    // No standings and no picks: exactly the pre-season state.
    const api = new StubFplApi({ leagues: {} });
    const result = await ingestEliteOwnership(db, api, { eventId: 1 });

    expect(result.managersSampled).toBe(0);
    expect(result.sampleId).toBeNull();
    expect(result.notes.join(' ')).toMatch(/no standings yet|not started/i);
  });

  it('keeps going when one manager cannot be read', async () => {
    const api = new StubFplApi({
      leagues: {
        '314:1': {
          standings: {
            results: [
              { entry: 1001, entry_name: 'Top', player_name: 'A', rank: 1, total: 100 },
              { entry: 9999, entry_name: 'Broken', player_name: 'B', rank: 2, total: 99 },
            ],
          },
        },
      },
      picks: { '1001:1': fakePicks([1, 2, 3]) },
    });

    const result = await ingestEliteOwnership(db, api, { eventId: 1, managers: 2 });
    expect(result.managersSampled).toBe(1);
    expect(result.notes.join(' ')).toMatch(/could not be read/);
  });
});
