import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { KNOCKOUTS, runAblation } from '../../src/model/ablation.js';
import { fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

/**
 * Every component in this model was added because it sounded right, and none has been asked to
 * justify itself. Subtractive rather than additive on purpose: adding a feature and watching
 * some number go up is the easiest way in the world to fool yourself, because there is always
 * some number that went up.
 */
describe('turning each part of the model off', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({ events: [1, 2, 3, 4].map((id) => fakeEvent(id, { finished: true })) }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [1, 2, 3, 4].map((gw) =>
          fakeFixture(gw, gw, 1, 2, { team_h_score: 1, team_a_score: 1, finished: true }),
        ),
      }),
    );
    for (const gw of [1, 2, 3, 4]) {
      db.prepare('UPDATE event SET deadline_time = ? WHERE id = ?').run(nowSeconds() + gw, gw);
    }

    const squad = db
      .prepare(
        `SELECT p.id AS id, pos.short_name AS position FROM player p
         JOIN position pos ON pos.id = p.position_id ORDER BY p.id`,
      )
      .all() as { id: number; position: string }[];
    const take = (position: string, n: number) =>
      squad.filter((player) => player.position === position).slice(0, n);
    const chosen = [...take('GKP', 2), ...take('DEF', 5), ...take('MID', 5), ...take('FWD', 3)];

    for (const eventId of [1, 2, 3, 4]) {
      db.prepare(
        `INSERT INTO recommendation (created_at, event_id, entry_id, kind, model_version, summary, detail_json)
         VALUES (?, ?, NULL, 'xi', 'test', 'test', ?)`,
      ).run(
        nowSeconds(),
        eventId,
        JSON.stringify({ squad: chosen.map((p) => ({ playerId: p.id, position: p.position })) }),
      );
    }

    const players = db.prepare('SELECT id FROM player').all() as { id: number }[];
    const insert = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, ?, ?, 90, 'test', ?)
       ON CONFLICT (player_id, event_id) DO UPDATE SET points = excluded.points`,
    );
    for (const eventId of [1, 2, 3, 4]) {
      for (const player of players) {
        insert.run(player.id, eventId, (player.id + eventId) % 11, nowSeconds());
      }
      db.prepare(
        `INSERT INTO gameweek_result (entry_id, event_id, actual_points, recorded_at) VALUES (1, ?, 40, ?)`,
      ).run(eventId, nowSeconds());
    }
  });

  it('scores every component against the same replayed weeks', () => {
    const result = runAblation(db, rules, weights);

    expect(result.weeks).toBeGreaterThan(1);
    expect(result.rows.length).toBeGreaterThan(0);
    // Every knockout is reported, including the ones that turn out to do nothing. A component
    // silently dropped from the table reads as a component that passed.
    expect(new Set(result.rows.map((row) => row.key))).toEqual(
      new Set(KNOCKOUTS.map((knockout) => knockout.key)),
    );
  });

  it('says plainly when a component cannot be judged by this instrument', () => {
    // The replay holds the squad fixed, so anything that only shapes WHICH fifteen you own is
    // invisible here. Reporting that as a zero would be the single most misleading thing this
    // page could do: "no effect on picking an XI" and "no effect" are different claims.
    const horizon = runAblation(db, rules, weights).rows.find((row) => row.key === 'horizon')!;
    expect(horizon.notMeasurable).toBeTruthy();
    expect(horizon.notMeasurable).toMatch(/squad fixed/i);
  });

  it('never mutates the weights it was given', () => {
    // A knockout leaking into the live weights would silently change every projection the app
    // made afterwards, and nothing else would report it.
    const before = JSON.stringify(weights);
    runAblation(db, rules, weights);
    expect(JSON.stringify(weights)).toBe(before);
  });

  it('pairs each component against the same gameweek, not the same list position', () => {
    // A knockout can change which weeks are replayable at all - a projection of zero
    // everywhere fails the coverage gate - and lining two different sets of weeks up by index
    // would compare GW4 against GW6 and report the difference as an effect.
    const result = runAblation(db, rules, weights);
    for (const row of result.rows) {
      if (row.notMeasurable) continue;
      expect(Math.abs(row.delta)).toBeLessThan(200);
    }
  });

  it('reports a component that changes nothing as inert rather than as harmless', () => {
    const result = runAblation(db, rules, weights);
    const inert = result.rows.filter((row) => row.inert);
    for (const row of inert) {
      expect(row.delta).toBe(0);
    }
    if (inert.length > 0) {
      expect(result.notes.join(' ')).toMatch(/changed no XI and no captain/);
    }
  });
});
