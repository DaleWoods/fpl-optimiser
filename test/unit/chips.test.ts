import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { adviseChips, halfOf, readHorizon } from '../../src/optimise/chips.js';
import { GlpkSolver } from '../../src/optimise/glpkSolver.js';
import { buildProjections } from '../../src/model/build.js';
import { defaultTeams, fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();
const solver = new GlpkSolver();

/** 8 clubs, 16 players each: enough to build a legal 15 and run real fixtures. */
function league() {
  const teams = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    name: `Club ${i + 1}`,
    short_name: `C${String(i + 1).padStart(2, '0')}`,
    attack: 1000 + i * 40,
    defence: 1000 + i * 30,
  }));

  const players = [];
  let id = 1;
  for (const team of teams) {
    for (const [type, count, base] of [[1, 2, 40], [2, 5, 45], [3, 6, 55], [4, 3, 60]] as const) {
      for (let n = 0; n < count; n += 1) {
        players.push({
          id,
          web_name: `T${team.id}P${id}`,
          team: team.id,
          element_type: type,
          now_cost: base + n * 5,
          minutes: 900,
          starts: 10,
          goals_scored: type >= 3 ? 6 : 1,
          assists: 4,
          expected_goals: type >= 3 ? 5 : 0.8,
          expected_assists: 3,
          bonus: 8,
          saves: type === 1 ? 40 : 0,
          defensive_contribution: type === 2 ? 90 : 40,
        });
        id += 1;
      }
    }
  }
  return { teams, players };
}

/**
 * Seed a season where GW3 is a double for two clubs and GW4 is a blank for four.
 * Exactly the shape that should drive Bench Boost one way and Free Hit the other.
 */
async function seed(db: Database): Promise<void> {
  const { teams, players } = league();
  // A full season of gameweeks, so advice can be requested from any point - including after
  // the GW19 chip deadline. Fixtures only exist for the first five.
  const seasonStart = Date.parse('2099-08-21T17:30:00Z');
  const events = Array.from({ length: 25 }, (_, i) =>
    fakeEvent(i + 1, {
      is_next: i === 0,
      deadline_time: new Date(seasonStart + i * 7 * 24 * 3600 * 1000).toISOString(),
    }),
  );
  await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap({ teams, players, events }) }), rules);

  const fixtures = [];
  let fid = 1;
  // GW1 and GW2: everybody plays once.
  for (const gw of [1, 2]) {
    for (let i = 0; i < 8; i += 2) fixtures.push(fakeFixture(fid++, gw, i + 1, i + 2));
  }
  // GW3: clubs 1 and 2 play twice.
  for (let i = 0; i < 8; i += 2) fixtures.push(fakeFixture(fid++, 3, i + 1, i + 2));
  fixtures.push(fakeFixture(fid++, 3, 2, 1));
  // GW4: only clubs 5-8 have a fixture, so 1-4 blank.
  fixtures.push(fakeFixture(fid++, 4, 5, 6));
  fixtures.push(fakeFixture(fid++, 4, 7, 8));
  // GW5: normal.
  for (let i = 0; i < 8; i += 2) fixtures.push(fakeFixture(fid++, 5, i + 1, i + 2));

  await ingestFixtures(db, new StubFplApi({ fixtures }));
}

/** A legal 15 drawn mostly from clubs 1-4, so the GW4 blank genuinely bites. */
function squadFrom(db: Database) {
  const projections = buildProjections(db, 1, rules, weights);
  const need: Record<string, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
  const perClub = new Map<number, number>();
  const squad = [];

  for (const player of projections.filter((p) => p.clubId <= 4)) {
    if ((need[player.position] ?? 0) <= 0) continue;
    if ((perClub.get(player.clubId) ?? 0) >= 3) continue;
    squad.push(player);
    need[player.position]! -= 1;
    perClub.set(player.clubId, (perClub.get(player.clubId) ?? 0) + 1);
  }
  // Top up from anywhere if the club limit left gaps.
  for (const player of projections) {
    if (squad.some((p) => p.playerId === player.playerId)) continue;
    if ((need[player.position] ?? 0) <= 0) continue;
    if ((perClub.get(player.clubId) ?? 0) >= 3) continue;
    squad.push(player);
    need[player.position]! -= 1;
    perClub.set(player.clubId, (perClub.get(player.clubId) ?? 0) + 1);
  }
  return squad;
}

describe('season halves', () => {
  it('splits at the configured chip expiry', () => {
    expect(halfOf(1, rules)).toBe(1);
    expect(halfOf(19, rules)).toBe(1);
    expect(halfOf(20, rules)).toBe(2);
  });
});

describe('reading the fixture horizon', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await seed(db);
  });

  it('spots a double gameweek', () => {
    const horizon = readHorizon(db, 1, 5);
    const gw3 = horizon.find((h) => h.eventId === 3)!;
    expect(gw3.doubleClubs.sort()).toEqual(['C01', 'C02']);
  });

  it('spots a blank gameweek', () => {
    const gw4 = readHorizon(db, 1, 5).find((h) => h.eventId === 4)!;
    expect(gw4.blankClubs).toHaveLength(4);
    expect(gw4.fixtureCount).toBe(2);
  });

  it('reports a normal gameweek as neither', () => {
    const gw1 = readHorizon(db, 1, 5).find((h) => h.eventId === 1)!;
    expect(gw1.doubleClubs).toHaveLength(0);
    expect(gw1.blankClubs).toHaveLength(0);
  });

  it('counts how much of the manager\'s own squad is affected', () => {
    const squad = squadFrom(db);
    const horizon = readHorizon(db, 1, 5, squad);
    const gw4 = horizon.find((h) => h.eventId === 4)!;
    expect(gw4.squadBlanks).toBeGreaterThan(0);
  });
});

describe('chip recommendations', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await seed(db);
  });

  it('looks 16 gameweeks ahead by default, so a chip is not judged against too short a window', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 1, { squad, solver });
    expect(advice.horizon).toHaveLength(16);
  });

  it('sends Bench Boost to the double gameweek', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 1, { squad, horizon: 5, solver });

    const bench = advice.recommendations.find((r) => r.chip === 'bboost')!;
    expect(bench.recommendedEvent).toBe(3);
    expect(bench.expectedGain).toBeGreaterThan(0);
    expect(bench.reason).toMatch(/play twice/);
  });

  it('sends Triple Captain to the double gameweek and names the captain', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 1, { squad, horizon: 5, solver });

    const tc = advice.recommendations.find((r) => r.chip === '3xc')!;
    expect(tc.recommendedEvent).toBe(3);
    expect(tc.reason).toMatch(/Captaining /);
  });

  it('values Triple Captain as one extra captain score, from the rules not a guess', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 1, { squad, horizon: 5, solver });
    const tc = advice.recommendations.find((r) => r.chip === '3xc')!;

    // tripleCaptainMultiplier (3) minus the normal multiplier (2) = one more captain score.
    expect(rules.captain.tripleCaptainMultiplier - rules.captain.multiplier).toBe(1);
    expect(tc.expectedGain).toBeGreaterThan(0);
  });

  it('sends Free Hit toward the blank gameweek when rebuilds are evaluated', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 1, {
      squad,
      horizon: 5,
      evaluateRebuilds: true,
      solver,
    });

    const freeHit = advice.recommendations.find((r) => r.chip === 'freehit')!;
    expect(freeHit.recommendedEvent).toBe(4);
    expect(freeHit.expectedGain).toBeGreaterThan(0);
  });

  it('says Free Hit needs the deeper run rather than guessing', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 1, { squad, horizon: 5, solver });
    const freeHit = advice.recommendations.find((r) => r.chip === 'freehit')!;
    expect(freeHit.recommendedEvent).toBeNull();
    expect(freeHit.reason).toMatch(/--deep/);
  });

  it('does not recommend a chip already used this half', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 1, {
      squad,
      horizon: 5,
      chipsUsed: [{ name: 'bboost', event: 2 }],
      solver,
    });
    expect(advice.recommendations.find((r) => r.chip === 'bboost')).toBeUndefined();
  });

  it('offers a chip again in the second half, because there are two sets', async () => {
    const squad = squadFrom(db);
    // Used in the first half; advising from GW20 is the second half, so it is available again.
    const advice = await adviseChips(db, rules, weights, 20, {
      squad,
      horizon: 5,
      chipsUsed: [{ name: 'bboost', event: 2 }],
      solver,
    });
    expect(advice.recommendations.find((r) => r.chip === 'bboost')).toBeDefined();
  });

  it('warns when two chips point at the same gameweek', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 1, { squad, horizon: 5, solver });
    // Bench Boost and Triple Captain both want the double.
    expect(advice.notes.join(' ')).toMatch(/only one chip may be played per gameweek/i);
  });

  it('warns about the first-set deadline as it approaches', async () => {
    const squad = squadFrom(db);
    const advice = await adviseChips(db, rules, weights, 16, { squad, horizon: 5, solver });
    const warnings = advice.recommendations.map((r) => r.warning).filter(Boolean).join(' ');
    expect(warnings).toMatch(/GW19/);
  });

  it('lists the doubles and blanks it found', async () => {
    const advice = await adviseChips(db, rules, weights, 1, { horizon: 5, solver });
    expect(advice.notes.join(' ')).toMatch(/Double gameweeks ahead: GW3/);
    expect(advice.notes.join(' ')).toMatch(/Blank gameweeks ahead: GW4/);
  });

  it('still advises on fixture shape when no squad is loaded, and says so', async () => {
    const advice = await adviseChips(db, rules, weights, 1, { horizon: 5, solver });

    const bench = advice.recommendations.find((r) => r.chip === 'bboost')!;
    expect(bench.recommendedEvent).toBe(3);
    expect(bench.reason).toMatch(/fixture shape only/);
    expect(bench.confident).toBe(false);
    expect(advice.notes.join(' ')).toMatch(/until a squad is loaded/);
  });

  it('says to hold when nothing stands out', async () => {
    const quiet = openTestDatabase();
    const { teams, players } = league();
    await ingestBootstrap(
      quiet,
      new StubFplApi({
        bootstrap: fakeBootstrap({ teams, players, events: [fakeEvent(1), fakeEvent(2)] }),
      }),
      rules,
    );
    // Every club plays exactly once each week: no doubles, no blanks.
    const fixtures = [];
    let fid = 1;
    for (const gw of [1, 2]) {
      for (let i = 0; i < 8; i += 2) fixtures.push(fakeFixture(fid++, gw, i + 1, i + 2));
    }
    await ingestFixtures(quiet, new StubFplApi({ fixtures }));

    const advice = await adviseChips(quiet, rules, weights, 1, { horizon: 2, solver });
    expect(advice.notes.join(' ')).toMatch(/No doubles or blanks/);
    expect(advice.notes.join(' ')).toMatch(/fixture rearrangement/);
  });

  it('reports plainly when there are no fixtures at all', async () => {
    const empty = openTestDatabase();
    const advice = await adviseChips(empty, rules, weights, 1, { horizon: 5, solver });
    expect(advice.recommendations).toHaveLength(0);
    expect(advice.notes.join(' ')).toMatch(/Import fixtures/);
  });
});
