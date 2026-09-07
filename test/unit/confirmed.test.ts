import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestEntry, ingestFixtures } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import {
  applyConfirmedTransfers,
  confirmTransfer,
  loadConfirmedTransfers,
  unconfirmTransfer,
} from '../../src/model/confirmedTransfers.js';
import { recommend } from '../../src/report/recommend.js';
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

/** 20 clubs, 16 players each - enough for a legal 15 and real transfer candidates. */
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
    for (const [type, count, base] of [[1, 2, 40], [2, 5, 45], [3, 5, 55], [4, 4, 60]] as const) {
      for (let n = 0; n < count; n += 1) {
        players.push({
          id,
          web_name: `T${team.id}P${id}`,
          team: team.id,
          element_type: type,
          now_cost: base + n * 5,
          minutes: 900,
          starts: 10,
          total_points: 40 + n * 6,
          goals_scored: type >= 3 ? 5 : 1,
          assists: 3,
          expected_goals: type >= 3 ? 4.5 : 0.7,
          expected_assists: 2.5,
          bonus: 7,
        });
        id += 1;
      }
    }
  }
  return { teams, players };
}

describe('transfers you confirm having made', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    const { teams, players } = bigLeague();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          teams,
          players,
          events: [
            fakeEvent(1, { finished: true, deadline_time: '2099-08-21T17:30:00Z' }),
            fakeEvent(2, { is_next: true, deadline_time: '2099-08-28T17:30:00Z' }),
          ],
        }),
      }),
      rules,
    );
    const fixtures = [];
    for (const gw of [1, 2]) {
      for (let i = 0; i < teams.length; i += 2) {
        fixtures.push(fakeFixture(gw * 100 + i, gw, teams[i]!.id, teams[i + 1]!.id));
      }
    }
    await ingestFixtures(db, new StubFplApi({ fixtures }));
  });

  /** A legal 15: 2/5/5/3, never more than three per club. */
  function pickLegalFifteen(): number[] {
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

  /** Load the squad as the API would: picks only exist for a gameweek that has STARTED. */
  async function loadSquadForEvent(playerIds: number[], event: number): Promise<void> {
    await ingestEntry(
      db,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: event, last_deadline_bank: 30 }) },
        history: { [teamId]: { current: [], chips: [] } },
        picks: { [`${teamId}:${event}`]: fakePicks(playerIds) },
      }),
      teamId,
      rules,
    );
  }

  it('applies a ticked transfer to the squad the advice is built on', async () => {
    // The whole point. FPL publishes picks only for a gameweek that has already started, so
    // between gameweek 1 finishing and gameweek 2 starting the app can only see the gameweek 1
    // team - and every piece of advice assumes you still own players you may have sold days ago.
    const fifteen = pickLegalFifteen();
    await loadSquadForEvent(fifteen, 1);

    const before = await recommend(db, rules, weights, { eventId: 2, teamId });
    const sold = before.squad[7]!;
    const replacement = buildProjections(db, 2, rules, weights).find(
      (p) => p.position === sold.position && !fifteen.includes(p.playerId),
    )!;

    confirmTransfer(db, teamId, 2, sold.playerId, replacement.playerId);

    const after = await recommend(db, rules, weights, { eventId: 2, teamId });
    expect(after.squad.map((p) => p.playerId)).not.toContain(sold.playerId);
    expect(after.squad.map((p) => p.playerId)).toContain(replacement.playerId);
    expect(after.confirmedTransfers).toHaveLength(1);
    expect(after.notes.join(' ')).toMatch(/ticked as done have been applied/);
  });

  it('un-ticking puts the player back', async () => {
    const fifteen = pickLegalFifteen();
    await loadSquadForEvent(fifteen, 1);

    const before = await recommend(db, rules, weights, { eventId: 2, teamId });
    const sold = before.squad[7]!;
    const replacement = buildProjections(db, 2, rules, weights).find(
      (p) => p.position === sold.position && !fifteen.includes(p.playerId),
    )!;

    confirmTransfer(db, teamId, 2, sold.playerId, replacement.playerId);
    unconfirmTransfer(db, teamId, 2, sold.playerId);

    const after = await recommend(db, rules, weights, { eventId: 2, teamId });
    expect(after.squad.map((p) => p.playerId)).toContain(sold.playerId);
    expect(after.confirmedTransfers).toHaveLength(0);
  });

  it('is a no-op once the real picks catch up, rather than applying twice', async () => {
    // The rows stay after the API starts reporting that gameweek. A swap is applied only when
    // the outgoing player is still there and the incoming one is not, so once reality agrees
    // the overlay simply stops matching. Without that guard, a confirmed transfer would be
    // applied a second time on top of a squad that already reflected it.
    const fifteen = pickLegalFifteen();
    await loadSquadForEvent(fifteen, 1);

    const before = await recommend(db, rules, weights, { eventId: 2, teamId });
    const sold = before.squad[7]!;
    const replacement = buildProjections(db, 2, rules, weights).find(
      (p) => p.position === sold.position && !fifteen.includes(p.playerId),
    )!;
    confirmTransfer(db, teamId, 2, sold.playerId, replacement.playerId);

    // Gameweek 2 starts: the API now returns the real squad, already containing the new player.
    const real = fifteen.map((id) => (id === sold.playerId ? replacement.playerId : id));
    await loadSquadForEvent(real, 2);

    const after = await recommend(db, rules, weights, { eventId: 2, teamId });
    expect(after.squad).toHaveLength(15);
    expect(new Set(after.squad.map((p) => p.playerId)).size).toBe(15);
    expect(after.squad.map((p) => p.playerId)).toContain(replacement.playerId);
    // Nothing left to apply, so nothing is claimed.
    expect(after.confirmedTransfers).toHaveLength(0);
  });

  it('keeps confirmations for one gameweek out of another', () => {
    confirmTransfer(db, teamId, 2, 11, 22);
    expect(loadConfirmedTransfers(db, teamId, 2)).toHaveLength(1);
    expect(loadConfirmedTransfers(db, teamId, 3)).toHaveLength(0);
    expect(loadConfirmedTransfers(db, 999999, 2)).toHaveLength(0);
  });

  it('reports a confirmation it could not apply rather than silently ignoring it', () => {
    // A transfer that quietly did nothing would leave every number built on it wrong, with no
    // sign on the page that anything had gone astray.
    const squad = [{ playerId: 1 }, { playerId: 2 }] as never;
    const result = applyConfirmedTransfers(
      squad,
      [{ eventId: 2, outPlayerId: 1, inPlayerId: 999 }],
      new Map(),
    );
    expect(result.applied).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.squad.map((p) => p.playerId)).toContain(1);
  });
});
