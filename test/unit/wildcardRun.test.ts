import { describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestEntry, ingestFixtures } from '../../src/ingest/index.js';
import { recommend } from '../../src/report/recommend.js';
import { fakeBootstrap, fakeEntry, fakeEvent, fakeFixture, fakePicks } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();
const teamId = 99;

/**
 * "It looks like all you're doing is creating a team with the best points this week."
 *
 * It was a fair read of the page and a wrong read of the solve, and the gap between those two
 * things is the bug. A player's in-squad value has always been his whole discounted run, because
 * owning him is a commitment that lasts until the next transfer - but every figure the page
 * printed was this gameweek's, so a squad chosen over five gameweeks read as one chosen over
 * one, and there was no way to tell the difference by looking.
 *
 * These pin both halves: that the squad really does follow the run, and that the page says so.
 */
describe('the Wildcard squad follows the run of fixtures', () => {
  /**
   * Ten clubs. The first five are strong and have the kind week now and a brutal run after it;
   * the second five are ordinary and have the reverse. A squad picked on this gameweek alone
   * keeps the first five. A squad picked on the run does not.
   */
  async function seedSwingingFixtures() {
    const db = openTestDatabase();
    const teams = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `Club ${i + 1}`,
      short_name: `C${String(i + 1).padStart(2, '0')}`,
      attack: i < 5 ? 1300 : 1000,
      defence: i < 5 ? 1300 : 1000,
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
            selected_by_percent: 10,
          });
          id += 1;
        }
      }
    }

    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          teams,
          players,
          events: [1, 2, 3, 4, 5].map((n) =>
            fakeEvent(n, { is_next: n === 1, deadline_time: `209${n}-08-14T17:30:00Z` }),
          ),
        }),
      }),
      rules,
    );

    // Gameweek 1: club 1 hosts the weakest side in the league. Gameweeks 2-5: club 1 plays the
    // other four strong clubs, while club 6 plays the four weak ones.
    const fixtures = [
      fakeFixture(1, 1, 1, 10),
      fakeFixture(2, 1, 2, 3),
      fakeFixture(3, 1, 4, 5),
      fakeFixture(4, 1, 6, 7),
      fakeFixture(5, 1, 8, 9),
    ];
    let fixtureId = 10;
    for (const gw of [2, 3, 4, 5]) {
      fixtures.push(fakeFixture(fixtureId++, gw, 1, gw));
      fixtures.push(fakeFixture(fixtureId++, gw, 6, gw + 5));
      fixtures.push(fakeFixture(fixtureId++, gw, 10 - gw, 11 - gw));
    }
    await ingestFixtures(db, new StubFplApi({ fixtures }));

    // A squad built entirely from the clubs with the kind week and the hard run.
    const rows = db
      .prepare(
        `SELECT p.id AS id, pos.short_name AS position, p.team_id AS club FROM player p
         JOIN position pos ON pos.id = p.position_id
         ORDER BY (CASE WHEN p.team_id <= 5 THEN 0 ELSE 1 END), p.id`,
      )
      .all() as { id: number; position: string; club: number }[];
    const need: Record<string, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
    const perClub = new Map<number, number>();
    const fifteen: number[] = [];
    for (const row of rows) {
      if ((need[row.position] ?? 0) <= 0) continue;
      if ((perClub.get(row.club) ?? 0) >= 3) continue;
      fifteen.push(row.id);
      need[row.position]! -= 1;
      perClub.set(row.club, (perClub.get(row.club) ?? 0) + 1);
    }

    await ingestEntry(
      db,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: 1, last_deadline_bank: 200 }) },
        history: { [teamId]: { current: [], chips: [] } },
        picks: {
          [`${teamId}:1`]: fakePicks(fifteen, {
            entry_history: { event: 1, bank: 200, value: 1000, event_transfers: 0, event_transfers_cost: 0 },
          }),
        },
      }),
      teamId,
      rules,
    );

    const clubOf = new Map(players.map((player) => [player.id, player.team]));
    return { db, fifteen, clubOf };
  }

  it('sells a kind week to buy a kind run', async () => {
    const { db, fifteen, clubOf } = await seedSwingingFixtures();
    const result = await recommend(db, rules, weights, { eventId: 1, teamId });
    const wildcard = result.wildcard!;

    const fromSwinging = (ids: number[]) => ids.filter((id) => (clubOf.get(id) ?? 0) <= 5).length;

    expect(fromSwinging(fifteen)).toBe(15);
    // Most of them go, despite every one of them having the better fixture this week.
    expect(fromSwinging(wildcard.squad.map((player) => player.playerId))).toBeLessThan(6);

    // And the trade it made is the right shape: a little given up now for a lot over the run.
    // A squad picked on this gameweek alone could not produce this - it would keep what it had.
    expect(wildcard.gainOverHorizon).toBeGreaterThan(wildcard.gainThisWeek * 5);
  });

  it('shows the run it was picked on, not only this gameweek', async () => {
    // The half of this that was actually broken. The solve was right and the page described it
    // backwards, which is indistinguishable from the solve being wrong if you are the one
    // reading it.
    const { db } = await seedSwingingFixtures();
    const result = await recommend(db, rules, weights, { eventId: 1, teamId });
    const wildcard = result.wildcard!;

    expect(wildcard.runGameweeks).toBe(weights.horizon.length);
    expect(wildcard.run).toHaveLength(rules.squad.size);

    for (const player of wildcard.squad) {
      const entry = wildcard.run.find((row) => row.playerId === player.playerId);
      expect(entry).toBeDefined();
      // One opponent per gameweek after this one, so a reader can see the run themselves
      // rather than take the total on trust.
      expect(entry!.opponents).toHaveLength(weights.horizon.length - 1);
      // The run includes this gameweek, so it cannot be smaller than it.
      expect(entry!.runXPts).toBeGreaterThanOrEqual(player.xPts - 1e-6);
    }
  });
});
