import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestEntry, ingestFixtures } from '../../src/ingest/index.js';
import { ingestEliteOwnership } from '../../src/ingest/elite.js';
import { importPayload } from '../../src/ingest/import.js';
import { buildProjections } from '../../src/model/build.js';
import { checkReadiness, recommend, resolveTargetEvent } from '../../src/report/recommend.js';
import { validateSquad, validateStartingEleven } from '../../src/rules/validate.js';
import {
  defaultTeams,
  fakeBootstrap,
  fakeEntry,
  fakeEvent,
  fakeFixture,
  fakePicks,
  type FakePlayerSpec,
} from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();
const teamId = 2651633;

/**
 * A league big enough to be a real optimisation problem: 20 clubs, 16 players each.
 * Prices and underlying stats vary so the budget constraint genuinely bites.
 */
function bigLeague(): { teams: ReturnType<typeof defaultTeams>; players: FakePlayerSpec[] } {
  const teams = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    name: `Club ${index + 1}`,
    short_name: `C${String(index + 1).padStart(2, '0')}`,
    attack: 900 + index * 25,
    defence: 900 + ((index * 37) % 500),
  }));

  const players: FakePlayerSpec[] = [];
  let id = 1;

  for (const team of teams) {
    const shape: Array<[number, number, number]> = [
      [1, 2, 40],
      [2, 5, 40],
      [3, 6, 45],
      [4, 3, 50],
    ];
    for (const [elementType, count, basePrice] of shape) {
      for (let n = 0; n < count; n += 1) {
        const quality = (team.attack - 900) / 500 + n / count;
        players.push({
          id,
          web_name: `P${id}`,
          team: team.id,
          element_type: elementType,
          now_cost: basePrice + Math.round(quality * 60),
          minutes: 900,
          starts: 10,
          goals_scored: elementType >= 3 ? Math.round(quality * 8) : 1,
          assists: Math.round(quality * 5),
          clean_sheets: 4,
          goals_conceded: 10,
          saves: elementType === 1 ? 40 : 0,
          bonus: Math.round(quality * 10),
          expected_goals: elementType >= 3 ? quality * 7 : 0.5,
          expected_assists: quality * 4,
          defensive_contribution: elementType === 2 ? 90 : 40,
          selected_by_percent: 5 + quality * 20,
        });
        id += 1;
      }
    }
  }

  return { teams, players };
}

/** Ingest a full league plus one round of fixtures. */
async function seedLeague(db: Database, options: { finished?: boolean } = {}): Promise<void> {
  const { teams, players } = bigLeague();
  const events = [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })];

  await ingestBootstrap(
    db,
    new StubFplApi({ bootstrap: fakeBootstrap({ teams, players, events }) }),
    rules,
  );

  const fixtures = [];
  for (let index = 0; index < teams.length; index += 2) {
    fixtures.push(
      fakeFixture(index / 2 + 1, 1, teams[index]!.id, teams[index + 1]!.id, {
        finished: options.finished ?? false,
      }),
    );
  }
  await ingestFixtures(db, new StubFplApi({ fixtures }));
}

describe('projection building', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await seedLeague(db);
  });

  it('projects every ingested player', () => {
    const projections = buildProjections(db, 1, rules, weights);
    expect(projections).toHaveLength(320);
    expect(projections.every((p) => Number.isFinite(p.xPts))).toBe(true);
  });

  it('gives players at stronger clubs higher projections, all else equal', () => {
    const projections = buildProjections(db, 1, rules, weights);
    const strong = projections.filter((p) => p.clubShort === 'C20' && p.position === 'MID');
    const weak = projections.filter((p) => p.clubShort === 'C01' && p.position === 'MID');
    const mean = (list: typeof strong) => list.reduce((s, p) => s + p.xPts, 0) / list.length;
    expect(mean(strong)).toBeGreaterThan(mean(weak));
  });

  it('gives a player with no fixture that gameweek zero', () => {
    const projections = buildProjections(db, 99, rules, weights);
    expect(projections.every((p) => p.xPts === 0)).toBe(true);
  });

  it('records projections for audit, stamped with the model version', async () => {
    await recommend(db, rules, weights, { eventId: 1 });
    const row = db
      .prepare('SELECT COUNT(*) AS n, model_version AS version FROM projection')
      .get() as { n: number; version: string };
    expect(row.n).toBeGreaterThan(0);
    expect(row.version).toBe(weights.modelVersion);
  });
});

describe('league table blend', () => {
  /**
   * Four clubs of identical underlying strength, so any projection difference between their
   * players can only come from the computed table, not the API's own ratings.
   */
  function equalStrengthTeams(): ReturnType<typeof defaultTeams> {
    return [
      { id: 1, name: 'Club A', short_name: 'CLA', attack: 1100, defence: 1100 },
      { id: 2, name: 'Club B', short_name: 'CLB', attack: 1100, defence: 1100 },
      { id: 3, name: 'Club C', short_name: 'CLC', attack: 1100, defence: 1100 },
      { id: 4, name: 'Club D', short_name: 'CLD', attack: 1100, defence: 1100 },
    ];
  }

  function identicalPlayer(id: number, team: number): FakePlayerSpec {
    return {
      id,
      web_name: `P${id}`,
      team,
      element_type: 3,
      now_cost: 70,
      minutes: 900,
      starts: 10,
      goals_scored: 5,
      assists: 4,
      expected_goals: 4,
      expected_assists: 3,
      defensive_contribution: 40,
      bonus: 5,
      selected_by_percent: 10,
    };
  }

  it('nudges a club on a hot streak above an out-of-form club with the same rating', async () => {
    const teams = equalStrengthTeams();
    const players = [identicalPlayer(101, 1), identicalPlayer(102, 2)];
    const events = [
      fakeEvent(1, { is_next: false, finished: true, deadline_time: '2020-08-14T17:30:00Z' }),
      fakeEvent(2, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' }),
    ];

    const db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({ bootstrap: fakeBootstrap({ teams, players, events }) }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          // Gameweek 1, already played: Club A thrashes Club B, Club C draws Club D.
          fakeFixture(1, 1, 1, 2, { team_h_score: 4, team_a_score: 0, finished: true }),
          fakeFixture(2, 1, 3, 4, { team_h_score: 1, team_a_score: 1, finished: true }),
          // Gameweek 2, the target: A and B each face an opponent of identical current form.
          fakeFixture(3, 2, 1, 3),
          fakeFixture(4, 2, 2, 4),
        ],
      }),
    );

    const projections = buildProjections(db, 2, rules, weights);
    const hotClub = projections.find((p) => p.playerId === 101)!;
    const coldClub = projections.find((p) => p.playerId === 102)!;

    expect(hotClub.xPts).toBeGreaterThan(coldClub.xPts);
  });

  it('does nothing before any result exists, since the table is empty', async () => {
    const teams = equalStrengthTeams();
    const players = [identicalPlayer(101, 1), identicalPlayer(102, 2)];
    const events = [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })];

    const db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({ bootstrap: fakeBootstrap({ teams, players, events }) }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        // Both players' clubs at home, against equal-strength opposition - home advantage
        // must not be the thing that tells them apart, only the (currently empty) table.
        fixtures: [fakeFixture(1, 1, 1, 3), fakeFixture(2, 1, 2, 4)],
      }),
    );

    const projections = buildProjections(db, 1, rules, weights);
    const a = projections.find((p) => p.playerId === 101)!;
    const b = projections.find((p) => p.playerId === 102)!;
    expect(a.xPts).toBeCloseTo(b.xPts, 6);
  });
});

describe('elite ownership blend', () => {
  it("moves a player's projection once top managers are shown to own and captain them", async () => {
    const db = openTestDatabase();
    await seedLeague(db);

    const before = buildProjections(db, 1, rules, weights).find((p) => p.playerId === 1)!;

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
        // Player 1 goes first in both squads, so fakePicks marks it captain in both.
        '1001:1': fakePicks(
          Array.from({ length: 15 }, (_, i) => (i === 0 ? 1 : i + 100)),
        ),
        '1002:1': fakePicks(
          Array.from({ length: 15 }, (_, i) => (i === 0 ? 1 : i + 200)),
        ),
      },
    });
    await ingestEliteOwnership(db, api, { eventId: 1, managers: 2 });

    await recommend(db, rules, weights, { eventId: 1, teamId });

    // recommend() saves every projection, elite-ownership bump included, to the projection
    // table - reading it back confirms the bump reached the stored (and therefore displayed)
    // figure, not just some intermediate value.
    const row = db
      .prepare(
        `SELECT xpts_raw AS xptsRaw, breakdown_json AS breakdownJson
         FROM projection WHERE player_id = 1 AND event_id = 1
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { xptsRaw: number; breakdownJson: string };

    expect(row.xptsRaw).toBeGreaterThan(before.xPtsRaw);
    const breakdown = JSON.parse(row.breakdownJson) as Record<string, number>;
    expect(breakdown.eliteOwnership).toBeGreaterThan(0);
  });

  it('leaves projections untouched before any elite sample exists', async () => {
    const db = openTestDatabase();
    await seedLeague(db);

    const before = buildProjections(db, 1, rules, weights).find((p) => p.playerId === 1)!;
    const result = await recommend(db, rules, weights, { eventId: 1, teamId });

    const row = db
      .prepare(
        `SELECT xpts_raw AS xptsRaw FROM projection WHERE player_id = 1 AND event_id = 1
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { xptsRaw: number };

    expect(result.evidence.eliteSampleSize).toBe(0);
    expect(row.xptsRaw).toBeCloseTo(before.xPtsRaw, 6);
  });
});

describe('generation readiness', () => {
  it('is not ready and names every missing requirement on an empty database', () => {
    const empty = openTestDatabase();
    const readiness = checkReadiness(empty);

    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual([
      "This season's player data",
      expect.stringMatching(/^Fixtures for/),
      "Last season's stats",
    ]);
    for (const check of readiness.checks.filter((c) => c.required)) {
      expect(check.ok).toBe(false);
    }
  });

  it('lists exactly what is still missing once some imports are in', async () => {
    const db = openTestDatabase();
    await seedLeague(db);

    const readiness = checkReadiness(db);
    // Player data and fixtures for gameweek 1 exist; last season's history does not.
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual(["Last season's stats"]);

    const playerCheck = readiness.checks.find((c) => c.id === 'this-season')!;
    expect(playerCheck.ok).toBe(true);
    const fixtureCheck = readiness.checks.find((c) => c.id === 'fixtures')!;
    expect(fixtureCheck.ok).toBe(true);
  });

  it('becomes ready once the three required imports are all present', async () => {
    const db = openTestDatabase();
    await seedLeague(db);
    await importPayload(
      db,
      rules,
      JSON.stringify({
        history: [{ element: 1, fixture: 500, minutes: 90 }],
        history_past: [{ season_name: '2025/26', total_points: 180, minutes: 3000 }],
      }),
    );

    const readiness = checkReadiness(db);
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);
  });

  it('treats curated news and elite ownership as soft signals that never block readiness', async () => {
    const db = openTestDatabase();
    await seedLeague(db);
    await importPayload(
      db,
      rules,
      JSON.stringify({
        history: [{ element: 1, fixture: 500, minutes: 90 }],
        history_past: [{ season_name: '2025/26', total_points: 180, minutes: 3000 }],
      }),
    );

    const readiness = checkReadiness(db);
    const news = readiness.checks.find((c) => c.id === 'news')!;
    const elite = readiness.checks.find((c) => c.id === 'elite')!;

    expect(news.required).toBe(false);
    expect(elite.required).toBe(false);
    // Neither has been supplied by seedLeague, yet readiness is unaffected.
    expect(readiness.ready).toBe(true);
  });
});

describe('recommendation with no squad loaded', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await seedLeague(db);
  });

  it('builds a legal squad from scratch within the budget', async () => {
    const result = await recommend(db, rules, weights, { eventId: 1, teamId });

    expect(result.mode).toBe('build-squad');
    expect(result.squad).toHaveLength(15);
    expect(result.totalCost).toBeLessThanOrEqual(rules.squad.budget);
    expect(validateSquad(result.squad, rules)).toEqual([]);
    expect(
      validateStartingEleven(result.eleven.starters, result.eleven.bench, rules, {
        squad: result.squad,
        captainId: result.eleven.captain.playerId,
        viceCaptainId: result.eleven.viceCaptain.playerId,
      }),
    ).toEqual([]);
  });

  it('explains why it built from scratch rather than loading a squad', async () => {
    const result = await recommend(db, rules, weights, { eventId: 1, teamId });
    expect(result.notes.join(' ')).toMatch(/does not expose your picks/i);
  });

  it('names a captain and a different vice-captain, both starting', async () => {
    const result = await recommend(db, rules, weights, { eventId: 1, teamId });
    const starterIds = result.eleven.starters.map((p) => p.playerId);
    expect(starterIds).toContain(result.eleven.captain.playerId);
    expect(starterIds).toContain(result.eleven.viceCaptain.playerId);
    expect(result.eleven.captain.playerId).not.toBe(result.eleven.viceCaptain.playerId);
  });

  it('picks the next upcoming gameweek when none is specified', async () => {
    const event = resolveTargetEvent(db);
    expect(event?.id).toBe(1);
  });

  it('refuses to advise before any data has been ingested', async () => {
    const empty = openTestDatabase();
    await expect(recommend(empty, rules, weights, {})).rejects.toThrow(/fpl ingest/);
  });
});

describe('recommendation with a squad loaded', () => {
  let db: Database;

  async function loadSquad(playerIds: number[], bank = 20): Promise<void> {
    await ingestEntry(
      db,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: 1, last_deadline_bank: bank }) },
        history: { [teamId]: { current: [], chips: [] } },
        picks: {
          [`${teamId}:1`]: fakePicks(playerIds, {
            entry_history: { event: 1, bank, value: 1000, event_transfers: 0, event_transfers_cost: 0 },
          }),
        },
      }),
      teamId,
      rules,
    );
  }

  /** A legal 15 drawn from the seeded league: 2/5/5/3, never more than three per club. */
  function pickLegalFifteen(db: Database): number[] {
    const rows = db
      .prepare(
        `SELECT p.id, pos.short_name AS position, p.team_id AS club
         FROM player p JOIN position pos ON pos.id = p.position_id ORDER BY p.id`,
      )
      .all() as { id: number; position: string; club: number }[];

    const need: Record<string, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
    const perClub = new Map<number, number>();
    const chosen: number[] = [];

    for (const row of rows) {
      if ((need[row.position] ?? 0) <= 0) continue;
      if ((perClub.get(row.club) ?? 0) >= 3) continue;
      chosen.push(row.id);
      need[row.position]! -= 1;
      perClub.set(row.club, (perClub.get(row.club) ?? 0) + 1);
    }
    return chosen;
  }

  beforeEach(async () => {
    db = openTestDatabase();
    await seedLeague(db);
  });

  it('optimises the XI from the squad actually owned', async () => {
    const fifteen = pickLegalFifteen(db);
    await loadSquad(fifteen);

    const result = await recommend(db, rules, weights, { eventId: 1, teamId });

    expect(result.mode).toBe('existing-squad');
    expect(result.squad.map((p) => p.playerId).sort((a, b) => a - b)).toEqual(
      [...fifteen].sort((a, b) => a - b),
    );
    expect(result.eleven.starters).toHaveLength(11);
    expect(
      validateStartingEleven(result.eleven.starters, result.eleven.bench, rules, {
        squad: result.squad,
      }),
    ).toEqual([]);
  });

  it('suggests transfers that improve the projected score', async () => {
    const fifteen = pickLegalFifteen(db);
    await loadSquad(fifteen, 50);

    const result = await recommend(db, rules, weights, { eventId: 1, teamId });

    expect(result.transfers.length).toBeGreaterThan(0);
    for (const transfer of result.transfers) {
      expect(transfer.netGain).toBeGreaterThan(0);
      expect(transfer.in.position).toBe(transfer.out.position);
      expect(transfer.reason).toMatch(/Net gain/);
    }
  });

  it('never suggests bringing in an unavailable player', async () => {
    const fifteen = pickLegalFifteen(db);
    await loadSquad(fifteen, 100);

    // Flag every player not already owned as injured.
    const owned = new Set(fifteen);
    const { teams, players } = bigLeague();
    const flagged = players.map((player) =>
      owned.has(player.id) ? player : { ...player, status: 'i', chance_of_playing_next_round: 0 },
    );
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          teams,
          players: flagged,
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
        }),
      }),
      rules,
    );

    const result = await recommend(db, rules, weights, { eventId: 1, teamId });
    expect(result.transfers).toEqual([]);
  });

  it('never suggests a transfer that would break the three-per-club limit', async () => {
    const fifteen = pickLegalFifteen(db);
    await loadSquad(fifteen, 100);

    const result = await recommend(db, rules, weights, { eventId: 1, teamId });

    for (const transfer of result.transfers) {
      const after = result.squad
        .map((p) => (p.playerId === transfer.out.playerId ? transfer.in : p))
        .filter((p) => p.clubId === transfer.in.clubId);
      expect(after.length).toBeLessThanOrEqual(rules.squad.maxPerClub);
    }
  });

  it('never suggests a transfer that cannot be afforded', async () => {
    const fifteen = pickLegalFifteen(db);
    await loadSquad(fifteen, 0);

    const result = await recommend(db, rules, weights, { eventId: 1, teamId });

    for (const transfer of result.transfers) {
      expect(transfer.in.price).toBeLessThanOrEqual(transfer.out.price);
    }
  });

  it('warns that selling prices are assumed, not known', async () => {
    await loadSquad(pickLegalFifteen(db));
    const result = await recommend(db, rules, weights, { eventId: 1, teamId });
    expect(result.notes.join(' ')).toMatch(/selling prices are not published/i);
  });
});

describe('multi-gameweek horizon', () => {
  /** Same deterministic pick as the "squad loaded" describe above: clubs 1-5 only. */
  function pickLegalFifteen(target: Database): number[] {
    const rows = target
      .prepare(
        `SELECT p.id, pos.short_name AS position, p.team_id AS club
         FROM player p JOIN position pos ON pos.id = p.position_id ORDER BY p.id`,
      )
      .all() as { id: number; position: string; club: number }[];

    const need: Record<string, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
    const perClub = new Map<number, number>();
    const chosen: number[] = [];
    for (const row of rows) {
      if ((need[row.position] ?? 0) <= 0) continue;
      if ((perClub.get(row.club) ?? 0) >= 3) continue;
      chosen.push(row.id);
      need[row.position]! -= 1;
      perClub.set(row.club, (perClub.get(row.club) ?? 0) + 1);
    }
    return chosen;
  }

  async function loadSquad(target: Database, playerIds: number[], bank: number): Promise<void> {
    await ingestEntry(
      target,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: 1, last_deadline_bank: bank }) },
        history: { [teamId]: { current: [], chips: [] } },
        picks: {
          [`${teamId}:1`]: fakePicks(playerIds, {
            entry_history: { event: 1, bank, value: 1000, event_transfers: 0, event_transfers_cost: 0 },
          }),
        },
      }),
      teamId,
      rules,
    );
  }

  /**
   * Extends the seeded league to three gameweeks, with a deliberate fixture swing: club 4 (one
   * of the squad's clubs) gets no fixture at all in gameweeks 2 and 3 - a true blank, which
   * depresses its future value to zero without inventing an oddly strong opponent that would
   * muddy the comparison. Club 6 (unowned, a source of transfer candidates) keeps playing
   * normally. Gameweek 1 is untouched, so this only ever shows up as a horizon effect, never as
   * a change to this week's own numbers.
   */
  async function addFutureFixtureSwing(target: Database): Promise<void> {
    const { teams, players } = bigLeague();
    await ingestBootstrap(
      target,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          teams,
          players,
          events: [
            fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' }),
            fakeEvent(2, { deadline_time: '2099-08-28T17:30:00Z' }),
            fakeEvent(3, { deadline_time: '2099-09-04T17:30:00Z' }),
          ],
        }),
      }),
      rules,
    );
    await ingestFixtures(
      target,
      new StubFplApi({
        // Club 4 has no fixture in either gameweek - a true blank. Club 6 plays a normal
        // fixture against club 7 in both.
        fixtures: [fakeFixture(103, 2, 6, 7), fakeFixture(104, 3, 6, 7)],
      }),
    );
  }

  it('reports how many gameweeks transfers and captaincy were actually judged over', async () => {
    const db = openTestDatabase();
    await seedLeague(db);
    await loadSquad(db, pickLegalFifteen(db), 100);

    const single = await recommend(db, rules, weights, { eventId: 1, teamId });
    expect(single.evidence.horizonGameweeks).toBe(1);
    expect(single.notes.join(' ')).toMatch(/gameweek\(s\) ahead have fixtures imported/);

    await addFutureFixtureSwing(db);
    const multi = await recommend(db, rules, weights, { eventId: 1, teamId });
    expect(multi.evidence.horizonGameweeks).toBe(3);
  });

  describe('an isolated swap decided purely by future fixtures', () => {
    /**
     * Six equal-strength clubs, so nothing about quality or price separates the squad's weakest
     * midfielder from the one unowned alternative - only the fixtures each of their clubs gets
     * after gameweek 1 can tell them apart. bigLeague's 20 clubs vary too much in underlying
     * strength for that isolation: a stronger club elsewhere in the pool would always be a
     * better transfer target regardless of fixtures, drowning out the horizon effect.
     */
    function equalSquad(): { teams: ReturnType<typeof defaultTeams>; players: FakePlayerSpec[] } {
      const teams = Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        name: `Club ${index + 1}`,
        short_name: `C${index + 1}`,
        attack: 1100,
        defence: 1100,
      }));
      const stats = {
        now_cost: 60,
        minutes: 900,
        starts: 10,
        goals_scored: 5,
        assists: 4,
        expected_goals: 4,
        expected_assists: 3,
        defensive_contribution: 40,
        bonus: 5,
        selected_by_percent: 15,
      };
      const players: FakePlayerSpec[] = [
        { id: 1, web_name: 'GK1', team: 1, element_type: 1, ...stats },
        { id: 2, web_name: 'D1', team: 1, element_type: 2, ...stats },
        { id: 3, web_name: 'D2', team: 1, element_type: 2, ...stats },
        { id: 4, web_name: 'GK2', team: 2, element_type: 1, ...stats },
        { id: 5, web_name: 'D3', team: 2, element_type: 2, ...stats },
        { id: 6, web_name: 'D4', team: 2, element_type: 2, ...stats },
        { id: 7, web_name: 'D5', team: 3, element_type: 2, ...stats },
        { id: 8, web_name: 'M1', team: 3, element_type: 3, ...stats },
        { id: 9, web_name: 'M2', team: 3, element_type: 3, ...stats },
        { id: 10, web_name: 'M3', team: 4, element_type: 3, ...stats },
        { id: 11, web_name: 'M4', team: 4, element_type: 3, ...stats },
        { id: 12, web_name: 'M5', team: 4, element_type: 3, ...stats }, // the "out" candidate
        { id: 13, web_name: 'F1', team: 5, element_type: 4, ...stats },
        { id: 14, web_name: 'F2', team: 5, element_type: 4, ...stats },
        { id: 15, web_name: 'F3', team: 5, element_type: 4, ...stats },
        { id: 16, web_name: 'M6', team: 6, element_type: 3, ...stats }, // unowned, the "in" candidate
      ];
      return { teams, players };
    }

    const squadIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    async function seed(target: Database, withFutureSwing: boolean): Promise<void> {
      const { teams, players } = equalSquad();
      const events = withFutureSwing
        ? [
            fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' }),
            fakeEvent(2, { deadline_time: '2099-08-28T17:30:00Z' }),
            fakeEvent(3, { deadline_time: '2099-09-04T17:30:00Z' }),
          ]
        : [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })];
      await ingestBootstrap(
        target,
        new StubFplApi({ bootstrap: fakeBootstrap({ teams, players, events }) }),
        rules,
      );

      const fixtures = [fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 3, 4), fakeFixture(3, 1, 5, 6)];
      if (withFutureSwing) {
        // Club 4 (home of the "out" midfielder) has no fixture at all in gameweeks 2 or 3 - a
        // true blank. Club 6 (home of the "in" candidate) keeps a normal run against club 5.
        fixtures.push(fakeFixture(4, 2, 5, 6), fakeFixture(5, 3, 5, 6));
      }
      await ingestFixtures(target, new StubFplApi({ fixtures }));

      await ingestEntry(
        target,
        new StubFplApi({
          entry: { [teamId]: fakeEntry(teamId, { current_event: 1, last_deadline_bank: 100 }) },
          history: { [teamId]: { current: [], chips: [] } },
          picks: {
            [`${teamId}:1`]: fakePicks(squadIds, {
              entry_history: {
                event: 1, bank: 100, value: 1000, event_transfers: 0, event_transfers_cost: 0,
              },
            }),
          },
        }),
        teamId,
        rules,
      );
    }

    it('does not suggest the swap on gameweek 1 alone, when both players are identical', async () => {
      const db = openTestDatabase();
      await seed(db, false);
      const result = await recommend(db, rules, weights, { eventId: 1, teamId });
      // Nothing separates them this week, so there is nothing to gain from swapping - and
      // certainly nothing that would survive a free-transfer-only comparison.
      expect(result.transfers.find((t) => t.out.playerId === 12 && t.in.playerId === 16)).toBeUndefined();
    });

    it('suggests it once the future fixtures make the difference clear', async () => {
      const db = openTestDatabase();
      await seed(db, true);
      const result = await recommend(db, rules, weights, { eventId: 1, teamId });

      const swap = result.transfers.find((t) => t.out.playerId === 12 && t.in.playerId === 16);
      expect(swap).toBeDefined();
      expect(swap!.horizonGain).toBeGreaterThan(0);
      // This week's own swing is ~zero - the identical players guarantee that - so the horizon
      // is doing essentially all of the work.
      expect(Math.abs(swap!.gainBeforeHit)).toBeLessThan(0.5);
      expect(swap!.reason).toMatch(/run of fixtures after this gameweek adds/);
    });
  });
});
