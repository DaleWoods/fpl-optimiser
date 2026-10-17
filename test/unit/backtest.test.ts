import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { runBacktest } from '../../src/model/backtest.js';
import { fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

/**
 * A backtest that can only flatter the thing it measures is worse than none, so most of these
 * set the model up to lose and require that the loss is reported.
 */
describe('replaying the season in points', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [1, 2, 3].map((id) => fakeEvent(id, { finished: true })),
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [1, 2, 3].map((gw) =>
          fakeFixture(gw, gw, 1, 2, { team_h_score: 1, team_a_score: 1, finished: true }),
        ),
      }),
    );
    // Deadlines must sit AFTER the snapshot ingest wrote, or no snapshot qualifies as
    // "before the deadline" and every gameweek is skipped as unreplayable.
    for (const gw of [1, 2, 3]) {
      db.prepare('UPDATE event SET deadline_time = ? WHERE id = ?').run(nowSeconds() + gw, gw);
    }
  });

  /** A legal 15 drawn from the seeded league, with a recorded squad for each gameweek. */
  function seedSquad(eventIds: number[]): number[] {
    const squad = (
      db
        .prepare(
          `SELECT p.id AS id, pos.short_name AS position FROM player p
           JOIN position pos ON pos.id = p.position_id ORDER BY p.id`,
        )
        .all() as { id: number; position: string }[]
    );
    const take = (position: string, n: number) =>
      squad.filter((p) => p.position === position).slice(0, n);
    const chosen = [...take('GKP', 2), ...take('DEF', 5), ...take('MID', 5), ...take('FWD', 3)];

    for (const eventId of eventIds) {
      db.prepare(
        `INSERT INTO recommendation (created_at, event_id, entry_id, kind, model_version, summary, detail_json)
         VALUES (?, ?, NULL, 'xi', 'test', 'test', ?)`,
      ).run(
        nowSeconds(),
        eventId,
        JSON.stringify({ squad: chosen.map((p) => ({ playerId: p.id, position: p.position })) }),
      );
    }
    return chosen.map((p) => p.id);
  }

  /** Give everyone a result, and optionally make one player a weekly hero. */
  function seedResults(eventIds: number[], hero?: { playerId: number; points: number }): void {
    const players = db.prepare('SELECT id FROM player').all() as { id: number }[];
    const insert = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, ?, ?, 90, 'test', ?)
       ON CONFLICT (player_id, event_id) DO UPDATE SET points = excluded.points`,
    );
    for (const eventId of eventIds) {
      for (const p of players) {
        insert.run(p.id, eventId, hero && p.id === hero.playerId ? hero.points : 2, nowSeconds());
      }
    }
  }

  function seedYourScore(eventId: number, points: number): void {
    db.prepare(
      `INSERT INTO gameweek_result (entry_id, event_id, actual_points, recorded_at)
       VALUES (1, ?, ?, ?)`,
    ).run(eventId, points, nowSeconds());
  }

  it('replays a gameweek that has no snapshot behind it', () => {
    // What used to cap the sample. A snapshot only exists for a week somebody was running this
    // app, so the season before installation was unreplayable however complete the results
    // were - and with five weeks the smallest detectable edge is bigger than any edge worth
    // arguing about. The season-to-date is now summed back out of match rows instead.
    seedSquad([1, 2, 3]);
    seedResults([1, 2, 3]);
    for (const gw of [1, 2, 3]) seedYourScore(gw, 40);

    // No snapshot predates gameweek 1's deadline any more.
    db.prepare('UPDATE event SET deadline_time = 1 WHERE id = 1').run();

    const result = runBacktest(db, rules, weights);

    expect(result.weeks.map((week) => week.eventId)).toEqual([1, 2, 3]);
    const first = result.weeks.find((week) => week.eventId === 1)!;
    expect(first.basis).toBe('history');
    expect(result.weeks.find((week) => week.eventId === 2)!.basis).toBe('snapshot');

    // And the page is told what that week could not see, rather than it passing silently.
    expect(result.notes.join(' ')).toMatch(/rebuilt from match history/i);
  });

  it("scores FPL's own number only over the weeks it actually exists for", () => {
    // ep_next is the API's own forecast and cannot be reconstructed. Giving a rebuilt week a
    // zero, a substitute, or the model's own figure would all make the benchmark easier to
    // beat on weeks where it was never asked the question. It covers fewer weeks and says so.
    seedSquad([1, 2, 3]);
    seedResults([1, 2, 3]);
    for (const gw of [1, 2, 3]) seedYourScore(gw, 40);
    db.prepare('UPDATE event SET deadline_time = 1 WHERE id = 1').run();

    const result = runBacktest(db, rules, weights);
    const fpl = result.policies.find((p) => p.key === 'fpl')!;
    const model = result.policies.find((p) => p.key === 'model')!;

    expect(model.weeksScored).toBe(3);
    expect(fpl.weeksScored).toBe(2);
    expect(fpl.weekly).toHaveLength(2);
  });

  it('scores every policy over the gameweeks it can replay', () => {
    seedSquad([1, 2, 3]);
    seedResults([1, 2, 3]);
    for (const gw of [1, 2, 3]) seedYourScore(gw, 40);

    const result = runBacktest(db, rules, weights);

    expect(result.weeks).toHaveLength(3);
    const model = result.policies.find((p) => p.key === 'model')!;
    expect(model.weekly).toHaveLength(3);
    expect(model.total).toBeGreaterThan(0);
    // All four policies are scored, so none can win by not being measured.
    expect(result.policies.map((p) => p.key).sort()).toEqual(['fpl', 'hold', 'model', 'you']);
  });

  it('reports the model LOSING when it does worse than what you played', () => {
    // The finding this exists to be capable of producing, and the one the live data has been
    // suggesting for weeks.
    seedSquad([1, 2, 3]);
    seedResults([1, 2, 3]);
    for (const gw of [1, 2, 3]) seedYourScore(gw, 500);

    const result = runBacktest(db, rules, weights);
    const versus = result.versusYou.find((v) => v.key === 'model')!;

    expect(versus.meanDifference).toBeLessThan(0);
    expect(versus.high).toBeLessThan(0);
    expect(versus.significant).toBe(true);
  });

  it('refuses to call a difference real when the interval spans zero', () => {
    // Four gameweeks of noise is not evidence, and saying so is the whole point of the
    // interval. A point estimate with no uncertainty beside it invites acting on nothing.
    seedSquad([1, 2, 3]);
    seedResults([1, 2, 3]);
    seedYourScore(1, 10);
    seedYourScore(2, 90);
    seedYourScore(3, 50);

    const versus = runBacktest(db, rules, weights).versusYou.find((v) => v.key === 'model')!;
    expect(versus.low).toBeLessThan(versus.high);
    if (versus.low < 0 && versus.high > 0) expect(versus.significant).toBe(false);
  });

  it('states the smallest edge this many gameweeks could detect', () => {
    seedSquad([1, 2, 3]);
    seedResults([1, 2, 3]);
    seedYourScore(1, 30);
    seedYourScore(2, 55);
    seedYourScore(3, 42);

    const result = runBacktest(db, rules, weights);
    // Usually larger than the effect being argued about, which is the useful part.
    expect(result.detectableEdge).not.toBeNull();
    expect(result.detectableEdge!).toBeGreaterThan(0);
  });

  it('says which gameweeks it could not replay instead of quietly dropping them', () => {
    // A squad is only on record from gameweek 2 here.
    seedSquad([2, 3]);
    seedResults([1, 2, 3]);
    for (const gw of [1, 2, 3]) seedYourScore(gw, 40);

    const result = runBacktest(db, rules, weights);

    expect(result.weeks.map((w) => w.eventId)).toEqual([2, 3]);
    expect(result.notes.join(' ')).toMatch(/Gameweek 1: no squad on record/);
  });

  it('gives the same interval twice for the same data', () => {
    // An interval that moves between page loads is not evidence of anything.
    seedSquad([1, 2, 3]);
    seedResults([1, 2, 3]);
    seedYourScore(1, 20);
    seedYourScore(2, 70);
    seedYourScore(3, 45);

    const first = runBacktest(db, rules, weights).versusYou.find((v) => v.key === 'model')!;
    const second = runBacktest(db, rules, weights).versusYou.find((v) => v.key === 'model')!;
    expect(second.low).toBe(first.low);
    expect(second.high).toBe(first.high);
  });

  it('names the captain each policy would have chosen', () => {
    // The armband is where the measured cost is, so a replay that hid its own captain pick
    // would be useless for diagnosing it.
    const squad = seedSquad([1, 2, 3]);
    seedResults([1, 2, 3], { playerId: squad[12]!, points: 20 });
    for (const gw of [1, 2, 3]) seedYourScore(gw, 40);

    const week = runBacktest(db, rules, weights).weeks[0]!;
    expect(week.captainByPolicy.model).not.toBeNull();
    expect(week.captainByPolicy.fpl).not.toBeNull();
  });
});

describe('the replay must not be able to see the future', () => {
  /**
   * The single property everything else depends on. buildProjections' own cutoff is tested
   * behaviourally in asof.test.ts; what is unguarded is the wiring - the replay simply forgetting
   * to pass it. Removing that one argument leaves every other backtest test passing while the
   * numbers silently become fiction, so the call site is asserted directly.
   */
  it('passes both cutoffs when it re-derives a projection', async () => {
    const text = (await import('node:fs')).readFileSync('src/model/backtest.ts', 'utf8');
    const call = text.slice(text.indexOf('buildProjections('));

    expect(call).toMatch(/asOfSnapshotId/);
    // The snapshot alone is not enough: match history and results are not tied to one.
    expect(call.slice(0, 300)).toMatch(/asOfEventId:\s*eventId/);
  });

  it('only ever reads a snapshot from before the deadline', async () => {
    const text = (await import('node:fs')).readFileSync('src/model/backtest.ts', 'utf8');
    const picker = text.slice(text.indexOf('function snapshotBefore'));

    expect(picker.slice(0, 500)).toMatch(/taken_at <= e\.deadline_time/);
    // Newest-first, so it is the LAST thing known before the deadline rather than the first.
    expect(picker.slice(0, 500)).toMatch(/ORDER BY s\.taken_at DESC/);
  });
});

describe('not mistaking missing data for a bad model', () => {
  /**
   * The flaw the first live run exposed. A player with no recorded result scores zero in every
   * replay - but "what you played" was being taken from the real FPL total, which suffers none
   * of that. So every gap in the results import landed entirely on the replayed side of the
   * comparison and made the model look worse than it is.
   *
   * Two corrections: your own XI is now scored from exactly the same results map, and a week
   * with large gaps is left out and named rather than scored against them.
   */
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({ events: [1, 2].map((id) => fakeEvent(id, { finished: true })) }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [1, 2].map((gw) =>
          fakeFixture(gw, gw, 1, 2, { team_h_score: 1, team_a_score: 1, finished: true }),
        ),
      }),
    );
    for (const gw of [1, 2]) {
      db.prepare('UPDATE event SET deadline_time = ? WHERE id = ?').run(nowSeconds() + gw, gw);
    }
  });

  function squadOf15(): { id: number; position: string }[] {
    const all = db
      .prepare(
        `SELECT p.id AS id, pos.short_name AS position FROM player p
         JOIN position pos ON pos.id = p.position_id ORDER BY p.id`,
      )
      .all() as { id: number; position: string }[];
    const take = (position: string, n: number) =>
      all.filter((p) => p.position === position).slice(0, n);
    return [...take('GKP', 2), ...take('DEF', 5), ...take('MID', 5), ...take('FWD', 3)];
  }

  function storeSquad(eventIds: number[], squad: { id: number; position: string }[]): void {
    for (const eventId of eventIds) {
      db.prepare(
        `INSERT INTO recommendation (created_at, event_id, entry_id, kind, model_version, summary, detail_json)
         VALUES (?, ?, NULL, 'xi', 'test', 'test', ?)`,
      ).run(
        nowSeconds(),
        eventId,
        JSON.stringify({ squad: squad.map((p) => ({ playerId: p.id, position: p.position })) }),
      );
    }
  }

  function seedResults(eventId: number, playerIds: number[]): void {
    const insert = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, ?, 4, 90, 'test', ?)
       ON CONFLICT (player_id, event_id) DO NOTHING`,
    );
    for (const id of playerIds) insert.run(id, eventId, nowSeconds());
  }

  it('leaves out a gameweek whose results are mostly missing, and says so', () => {
    const squad = squadOf15();
    storeSquad([1, 2], squad);
    seedResults(1, squad.map((p) => p.id));           // complete
    seedResults(2, squad.slice(0, 5).map((p) => p.id)); // only a third have results

    const result = runBacktest(db, rules, weights);

    expect(result.weeks.map((w) => w.eventId)).toEqual([1]);
    expect(result.notes.join(' ')).toMatch(/Gameweek 2: only 5 of 15 squad players/);
  });

  it('reports how complete each replayed week was', () => {
    const squad = squadOf15();
    storeSquad([1], squad);
    seedResults(1, squad.map((p) => p.id));

    const week = runBacktest(db, rules, weights).weeks[0]!;
    expect(week.coverage).toBe(1);
  });

  it('scores your XI from the same results map, not from an external total', () => {
    // The bias being removed. Your real FPL total knows about players this database has no
    // result for; a replay does not. Pairing one against the other puts every gap on one side.
    const squad = squadOf15();
    storeSquad([1], squad);
    seedResults(1, squad.map((p) => p.id));

    const state = Number(
      db
        .prepare(
          `INSERT INTO manager_state (entry_id, captured_at, event_id) VALUES (1, ?, 1)`,
        )
        .run(nowSeconds()).lastInsertRowid,
    );
    const insertPick = db.prepare(
      `INSERT INTO squad_pick (manager_state_id, player_id, slot, multiplier, is_captain, is_vice_captain)
       VALUES (?, ?, ?, ?, ?, 0)`,
    );
    squad.forEach((p, index) =>
      insertPick.run(state, p.id, index + 1, index < 11 ? 1 : 0, index === 0 ? 1 : 0),
    );

    // A wildly wrong real total, which must NOT be what the comparison uses.
    db.prepare(
      `INSERT INTO gameweek_result (entry_id, event_id, actual_points, recorded_at)
       VALUES (1, 1, 9999, ?)`,
    ).run(nowSeconds());

    const result = runBacktest(db, rules, weights);
    const you = result.policies.find((p) => p.key === 'you')!;

    expect(you.total).toBeLessThan(500);
    expect(you.label).toMatch(/XI you played/);
  });
});
