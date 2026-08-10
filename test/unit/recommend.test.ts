import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestEntry, ingestFixtures } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import { recommend, resolveTargetEvent } from '../../src/report/recommend.js';
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
