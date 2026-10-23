import { describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import { fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

/**
 * Who takes the penalties has been in every bootstrap payload this app has ever fetched, and
 * was read by nothing.
 *
 * It is deliberately not folded into xPts. A player's expected goals already contain the
 * penalties he has taken, so an uplift on top would count the same thing twice for every
 * settled taker - which is nearly all of them. What the history cannot describe is the taker
 * appointed last week, whose own record understates him and will go on understating him for
 * exactly as long as it takes to decide a transfer. Separating that case from the rest needs a
 * measurement this app does not have yet, so for now the duty is shown and not scored.
 */
describe('set-piece duty', () => {
  async function seed(spec: Record<string, unknown>) {
    const db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          players: [
            {
              id: 1, web_name: 'Taker', team: 1, element_type: 3, now_cost: 70,
              minutes: 900, starts: 10, goals_scored: 5, assists: 4,
              expected_goals: 4, expected_assists: 3, bonus: 5, selected_by_percent: 10,
              ...spec,
            },
            {
              id: 2, web_name: 'Nobody', team: 2, element_type: 3, now_cost: 70,
              minutes: 900, starts: 10, goals_scored: 5, assists: 4,
              expected_goals: 4, expected_assists: 3, bonus: 5, selected_by_percent: 10,
            },
          ] as never,
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-14T17:30:00Z' })],
        }),
      }),
      rules,
    );
    await ingestFixtures(db, new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2)] }));
    return db;
  }

  it('reads the order the API publishes and carries it onto the projection', async () => {
    const db = await seed({
      penalties_order: 1,
      direct_freekicks_order: 2,
      corners_and_indirect_freekicks_order: 1,
    });
    const projections = buildProjections(db, 1, rules, weights);

    expect(projections.find((p) => p.playerId === 1)!.setPieces).toEqual({
      penalties: 1,
      freekicks: 2,
      corners: 1,
    });
    // Absent, not zeroed: "not on the list" and "first choice" must not collapse together.
    expect(projections.find((p) => p.playerId === 2)!.setPieces).toBeUndefined();
  });

  it('does not change the projection, because the penalties are already in the expected goals', async () => {
    const withDuty = buildProjections(await seed({ penalties_order: 1 }), 1, rules, weights);
    const without = buildProjections(await seed({}), 1, rules, weights);

    expect(withDuty.find((p) => p.playerId === 1)!.xPts).toBeCloseTo(
      without.find((p) => p.playerId === 1)!.xPts,
      10,
    );
  });

  it('credits a newly appointed taker, and only him, once switched on', async () => {
    // The one case the history cannot describe. Both players are first-choice takers now; only
    // one of them was not a taker when the oldest snapshot was written, so only his own record
    // is missing the penalties he is about to take.
    const db = await seed({ penalties_order: 1 });
    db.prepare('UPDATE player_snapshot SET penalties_order = 1 WHERE player_id = 2').run();

    // A second, later snapshot in which player 1 has taken the job over and player 2 has not.
    const first = (db.prepare('SELECT id FROM snapshot ORDER BY id ASC LIMIT 1').get() as { id: number }).id;
    db.prepare('UPDATE player_snapshot SET penalties_order = NULL WHERE snapshot_id = ? AND player_id = 1').run(first);
    const later = Number(
      db.prepare('INSERT INTO snapshot (taken_at) VALUES (4000000000)').run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO player_snapshot (snapshot_id, player_id, taken_at, now_cost, status, raw_json,
                                    minutes, starts, goals_scored, assists, expected_goals,
                                    expected_assists, bonus, selected_by_percent, penalties_order)
       SELECT ?, player_id, 4000000000, now_cost, status, '', minutes, starts, goals_scored,
              assists, expected_goals, expected_assists, bonus, selected_by_percent, 1
       FROM player_snapshot WHERE snapshot_id = ?`,
    ).run(later, first);

    const on = { ...weights, setPieces: { ...weights.setPieces, newPenaltyTakerGoalsPerMatch: 0.1 } };
    const off = buildProjections(db, 1, rules, weights);
    const lifted = buildProjections(db, 1, rules, on);

    const find = (list: typeof off, id: number) => list.find((p) => p.playerId === id)!;
    // Player 1 took the job over: he gains.
    expect(find(lifted, 1).xPts).toBeGreaterThan(find(off, 1).xPts);
    // Player 2 has had it all along, so his expected goals already contain the penalties and
    // crediting them again would count the same thing twice.
    expect(find(lifted, 2).xPts).toBeCloseTo(find(off, 2).xPts, 10);
  });

  it('survives a payload that does not mention set pieces at all', async () => {
    // Older saved payloads, and hand-made import files, simply will not have these fields.
    // An absent field has to read as "not known", never as "not a taker" and never as a crash.
    const db = await seed({});
    const projections = buildProjections(db, 1, rules, weights);
    expect(projections.find((p) => p.playerId === 1)!.setPieces).toBeUndefined();
  });
});
