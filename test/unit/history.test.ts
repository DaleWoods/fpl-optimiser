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

  it('shrinks a lucky cameo below a genuine full-season rate, even at the same per-90', async () => {
    // Scale every counting stat's total to the same per-90 rate for both players, so the only
    // thing that differs is the sample size behind it: 90 minutes of a hot streak versus a full
    // season backing it up. The cameo must not outrank the real starter.
    const perNinety = (minutes: number) => (rate: number) => (rate * minutes) / 90;
    const scaledSeason = (minutes: number) => {
      const scale = perNinety(minutes);
      return pastSeason({
        minutes,
        expected_goals: String(scale(1.0)),
        expected_assists: String(scale(0.5)),
        goals_scored: Math.round(scale(1)),
        assists: Math.round(scale(0.5)),
        bonus: Math.round(scale(0.5)),
        defensive_contribution: String(scale(4)),
      });
    };

    const api = new StubFplApi({
      elementSummary: {
        11: { ...fakeElementSummary(11, []), history_past: [scaledSeason(90)] },
        12: { ...fakeElementSummary(12, []), history_past: [scaledSeason(3000)] },
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11, 12] });

    const projections = buildProjections(db, 1, rules, weights);
    const cameo = projections.find((p) => p.playerId === 11)!;
    const fullSeason = projections.find((p) => p.playerId === 12)!;

    expect(cameo.xPts).toBeLessThan(fullSeason.xPts);
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

  it('stops trusting a strong last season once his club has played and he still has zero minutes', async () => {
    // A player with a big 2025/26 behind him (33 starts, 240 points) but zero minutes so far
    // this season - exactly the shape of a nailed-on bench player, or a summer signing who lost
    // the shirt. Before a ball is kicked, last season is the only real evidence there is. Once
    // his own club has played and he still has nothing, that zero is itself the evidence, and
    // must not keep getting overridden by a prior that no longer applies.
    const api = new StubFplApi({
      elementSummary: {
        11: { ...fakeElementSummary(11, []), history_past: [pastSeason({ total_points: 240 })] },
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11] });
    const beforeKickoff = buildProjections(db, 1, rules, weights).find((p) => p.playerId === 11)!;

    // Team 1's fixture is now finished. Player 11's own minutes are still 0 - he did not feature.
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [fakeFixture(1, 1, 1, 2, { finished: true }), fakeFixture(2, 1, 3, 4)],
      }),
    );
    const afterAnUnusedMatch = buildProjections(db, 1, rules, weights).find(
      (p) => p.playerId === 11,
    )!;

    expect(beforeKickoff.reasons.join(' ')).toMatch(/Rates are from/);
    expect(afterAnUnusedMatch.reasons.join(' ')).not.toMatch(/Rates are from/);
    expect(afterAnUnusedMatch.xPts).toBeLessThan(beforeKickoff.xPts);
  });
});

describe('recency-weighted form', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  /** Both players: identical season-long baseline, differing only in expected_goals shape. */
  function baseline(id: number, totalXg: number) {
    return {
      id,
      minutes: 900,
      starts: 10,
      expected_goals: totalXg,
      goals_scored: 0,
      expected_assists: 0,
      assists: 0,
      saves: 0,
      bonus: 0,
      defensive_contribution: 0,
    };
  }

  it('pulls a rate toward a recent hot streak, away from a flat season average', async () => {
    // 10 games each, 90 minutes, identical season-total xG (3.4) - player 11's is concentrated
    // in the last 6 games (the recentMatches window), player 12's is spread evenly across all 10.
    const hotHistory = [0.1, 0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]; // sums to 3.4
    const flatHistory = Array(10).fill(0.34); // sums to 3.4

    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
          players: defaultPlayers().map((p) => {
            const override = p.id === 11 ? baseline(11, 3.4) : p.id === 12 ? baseline(12, 3.4) : undefined;
            return override ? { ...p, ...override } : p;
          }),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 3, 4)] }),
    );

    const matches = (history: number[]) =>
      history.map((xg) => ({ minutes: 90, starts: 1, expected_goals: xg, goals_scored: 0 }));
    const api = new StubFplApi({
      elementSummary: {
        11: fakeElementSummary(11, matches(hotHistory)),
        12: fakeElementSummary(12, matches(flatHistory)),
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11, 12] });

    const projections = buildProjections(db, 1, rules, weights);
    const hot = projections.find((p) => p.playerId === 11)!;
    const flat = projections.find((p) => p.playerId === 12)!;

    // Same season-long total, same everything else - the only possible reason for a difference
    // is the recent-form blend picking up the concentration in the last 6 games.
    expect(hot.xPts).toBeGreaterThan(flat.xPts);
  });

  it('does not let a single recent cameo swing a rate as hard as a genuine recent run at the same rate would', async () => {
    // Identical season-long baseline for both (1.8 xG over 900 minutes). Both also show exactly
    // the same PER-90 rate (0.9) in their most recent form - the only difference is how much of
    // it is backed by real minutes: one 90-minute cameo versus six full 90-minute games at that
    // same rate. Isolates the confidence scaling from the rate itself.
    const filler = () => ({ minutes: 90, starts: 1, expected_goals: 0.18, goals_scored: 0 });
    const oneCameoHistory = [
      ...Array.from({ length: 4 }, filler),
      { minutes: 0, starts: 0, expected_goals: 0, goals_scored: 0 },
      { minutes: 0, starts: 0, expected_goals: 0, goals_scored: 0 },
      { minutes: 0, starts: 0, expected_goals: 0, goals_scored: 0 },
      { minutes: 0, starts: 0, expected_goals: 0, goals_scored: 0 },
      { minutes: 0, starts: 0, expected_goals: 0, goals_scored: 0 },
      { minutes: 90, starts: 1, expected_goals: 0.9, goals_scored: 0 }, // the one hot cameo
    ];
    const genuineRunHistory = [
      ...Array.from({ length: 4 }, filler),
      ...Array.from({ length: 6 }, () => ({ minutes: 90, starts: 1, expected_goals: 0.9, goals_scored: 0 })),
    ];

    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
          players: defaultPlayers().map((p) => {
            const override = p.id === 11 ? baseline(11, 1.8) : p.id === 12 ? baseline(12, 1.8) : undefined;
            return override ? { ...p, ...override } : p;
          }),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 3, 4)] }),
    );

    const api = new StubFplApi({
      elementSummary: {
        11: fakeElementSummary(11, oneCameoHistory),
        12: fakeElementSummary(12, genuineRunHistory),
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11, 12] });

    const projections = buildProjections(db, 1, rules, weights);
    const oneCameo = projections.find((p) => p.playerId === 11)!;
    const genuineRun = projections.find((p) => p.playerId === 12)!;

    expect(oneCameo.xPts).toBeLessThan(genuineRun.xPts);
  });

  it('raises the effective start rate for a player who has nailed down a place recently', async () => {
    // 10 gameweeks: benched/cameo for the first 6, a nailed-on starter for the last 4.
    const recentStarter = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
    // Same season-long total starts (4 out of 10), but spread evenly rather than recently.
    const evenStarter = [1, 0, 1, 0, 1, 0, 1, 0, 0, 0];

    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
          players: defaultPlayers().map((p) => {
            const override =
              p.id === 11
                ? { ...baseline(11, 2), starts: 4, minutes: 400 }
                : p.id === 12
                  ? { ...baseline(12, 2), starts: 4, minutes: 400 }
                  : undefined;
            return override ? { ...p, ...override } : p;
          }),
        }),
      }),
      rules,
    );
    // playedByTeam (the season-matches denominator) counts every finished fixture regardless of
    // event, so 9 finished fixtures (events 2-10, already played) plus event 1's own upcoming
    // fixture gives seasonMatches = 9 without inflating event 1 itself into a false double
    // gameweek - enough games for the recent-6 window to genuinely differ from an even spread.
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          fakeFixture(1, 1, 1, 2),
          ...Array.from({ length: 9 }, (_, i) => fakeFixture(i + 2, i + 2, 1, 2, { finished: true })),
        ],
      }),
    );

    const matches = (starts: number[]) =>
      starts.map((s) => ({ minutes: s ? 90 : 10, starts: s, expected_goals: 0.2, goals_scored: 0 }));
    const api = new StubFplApi({
      elementSummary: {
        11: fakeElementSummary(11, matches(recentStarter)),
        12: fakeElementSummary(12, matches(evenStarter)),
      },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [11, 12] });

    const projections = buildProjections(db, 1, rules, weights);
    const nailedOnNow = projections.find((p) => p.playerId === 11)!;
    const rotationRisk = projections.find((p) => p.playerId === 12)!;

    expect(nailedOnNow.expectedMinutes).toBeGreaterThan(rotationRisk.expectedMinutes);
  });
});

describe("this season's own rate is shrunk by sample size too, not just last season's", () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('does not trust one huge early-season defensive haul at full face value', async () => {
    // Player 3 (team 1's first DEF) has an outlier gameweek 1: 20 CBIT actions in 90 minutes -
    // a raw per-90 rate of 20, twice the DEF DefCon threshold of 10. Taken at face value that
    // reads as an almost certain 2 points every week; shrunk by the same one-match sample-size
    // caution already applied to a previous-season rate (a quarter of face value, per
    // shrinkRate's own comment), it drops to 5 - *below* the threshold, a coin-flip at best.
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [
            fakeEvent(1, { finished: true, deadline_time: '2099-08-21T17:30:00Z' }),
            fakeEvent(2, { is_next: true, deadline_time: '2099-08-28T17:30:00Z' }),
          ],
          players: defaultPlayers().map((p) =>
            p.id === 3 ? { ...p, minutes: 90, starts: 1, defensive_contribution: 20 } : p,
          ),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          fakeFixture(1, 1, 1, 2, { finished: true }),
          fakeFixture(2, 2, 1, 2),
        ],
      }),
    );

    const projections = buildProjections(db, 2, rules, weights);
    const player = projections.find((p) => p.playerId === 3)!;

    // Nowhere near the ~1 point (2 points at near-certain probability) an unshrunk reading of
    // this outlier game would produce - the whole point of the shrinkage.
    expect(player.breakdown.defensiveContribution).toBeGreaterThan(0);
    expect(player.breakdown.defensiveContribution).toBeLessThan(0.3);
  });
});

describe('price trend', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  // A small topN/floor, independent of the real config, so the test is not tied to how many
  // players defaultPlayers() happens to seed.
  const tunedWeights = { ...weights, priceTrend: { topN: 1, netTransfersFloor: 1000 } };

  it('flags a player heavily transferred in as trending up, and one heavily transferred out as trending down', async () => {
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
          players: defaultPlayers().map((p) => {
            if (p.id === 1) return { ...p, transfers_in_event: 50000, transfers_out_event: 200 };
            if (p.id === 2) return { ...p, transfers_in_event: 100, transfers_out_event: 40000 };
            return p;
          }),
        }),
      }),
      rules,
    );

    const projections = buildProjections(db, 1, rules, tunedWeights);
    const risingPlayer = projections.find((p) => p.playerId === 1)!;
    const fallingPlayer = projections.find((p) => p.playerId === 2)!;
    const untouchedPlayer = projections.find((p) => p.playerId === 3)!;

    expect(risingPlayer.reasons.join(' ')).toMatch(/transferred in.*price may be close to a rise/i);
    expect(fallingPlayer.reasons.join(' ')).toMatch(/transferred out.*price may be close to a fall/i);
    expect(untouchedPlayer.reasons.join(' ')).not.toMatch(/transferred (in|out)/i);
  });

  it('does not flag anyone when net transfers everywhere sit below the floor', async () => {
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
          players: defaultPlayers().map((p) =>
            p.id === 1 ? { ...p, transfers_in_event: 500, transfers_out_event: 100 } : p,
          ),
        }),
      }),
      rules,
    );

    const projections = buildProjections(db, 1, rules, tunedWeights);
    for (const player of projections) {
      expect(player.reasons.join(' ')).not.toMatch(/transferred (in|out)/i);
    }
  });
});

describe('rotation risk from a short turnaround between fixtures', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('discounts minutes for a club whose gameweek 2 fixture follows gameweek 1 by only a few days - most often a European tie squeezed in between', async () => {
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [
            fakeEvent(1, { finished: true, deadline_time: '2026-08-21T17:30:00Z' }),
            fakeEvent(2, { is_next: true, deadline_time: '2026-08-28T17:30:00Z' }),
          ],
          players: defaultPlayers(),
        }),
      }),
      rules,
    );

    const gw1Kickoff = Date.parse('2026-08-21T17:30:00Z');
    const shortRestKickoff = new Date(gw1Kickoff + 3 * 24 * 3600 * 1000).toISOString(); // 3 days later
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          // Gameweek 1: every club plays, establishing each one's "previous" kickoff.
          fakeFixture(1, 1, 1, 2, { finished: true }),
          fakeFixture(2, 1, 3, 4, { finished: true }),
          // Gameweek 2: teams 1 & 2 are back after only 3 days (short rest); teams 3 & 4 get
          // the normal 7-day gap (fakeFixture's own default kickoff for gameweek 2).
          fakeFixture(3, 2, 1, 2, { kickoff_time: shortRestKickoff }),
          fakeFixture(4, 2, 3, 4),
        ],
      }),
    );

    const projections = buildProjections(db, 2, rules, weights);
    // Player 8 (team 1, first MID) and player 38 (team 3, first MID) share identical underlying
    // stats in defaultPlayers() - the only difference is which club has the short turnaround.
    const shortRestPlayer = projections.find((p) => p.playerId === 8)!;
    const normalRestPlayer = projections.find((p) => p.playerId === 38)!;

    expect(shortRestPlayer.expectedMinutes).toBeLessThan(normalRestPlayer.expectedMinutes);
    expect(shortRestPlayer.reasons.join(' ')).toMatch(/fewer than 4 days.*rotation risk/i);
    expect(normalRestPlayer.reasons.join(' ')).not.toMatch(/rotation risk/i);
  });

  it('does not discount a normal 7-day gap between gameweeks', async () => {
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [
            fakeEvent(1, { finished: true, deadline_time: '2026-08-21T17:30:00Z' }),
            fakeEvent(2, { is_next: true, deadline_time: '2026-08-28T17:30:00Z' }),
          ],
          players: defaultPlayers(),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          fakeFixture(1, 1, 1, 2, { finished: true }),
          fakeFixture(2, 1, 3, 4, { finished: true }),
          fakeFixture(3, 2, 1, 2), // default kickoff: 7 days after gameweek 1
          fakeFixture(4, 2, 3, 4),
        ],
      }),
    );

    const projections = buildProjections(db, 2, rules, weights);
    for (const player of projections) {
      expect(player.reasons.join(' ')).not.toMatch(/rotation risk/i);
    }
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
