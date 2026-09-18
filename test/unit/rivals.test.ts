import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadRules } from '../../src/config/load.js';
import { ingestBootstrap } from '../../src/ingest/index.js';
import { compareRival, compareRivals } from '../../src/model/rivals.js';
import { fakeBootstrap, fakeEvent } from '../support/fakeApi.js';
import { player } from '../support/players.js';

const rules = loadRules();

/**
 * The whole value of this is the split it makes. A list of a winning manager's players copied
 * wholesale is cargo-culting; ignored entirely it wastes the one signal you have about someone
 * beating you. What matters is separating "the model agrees and you simply missed him" from
 * "the model disagrees, so this is his judgement or his luck" - and those must not blur.
 */
describe('where a rival and this model disagree', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({ bootstrap: fakeBootstrap({ events: [fakeEvent(1, { is_next: true })] }) }),
      rules,
    );
    db.prepare(
      `INSERT INTO rival_entry (entry_id, label, total_points, updated_at) VALUES (7, 'Rival R', 300, ?)`,
    ).run(nowSeconds());
  });

  const projections = [
    { ...player({ playerId: 1, name: 'Star', xPts: 8 }), clubShort: 'AAA' },
    { ...player({ playerId: 2, name: 'Solid', xPts: 6 }), clubShort: 'BBB' },
    { ...player({ playerId: 3, name: 'Fringe', xPts: 5.5 }), clubShort: 'CCC' },
    { ...player({ playerId: 4, name: 'Punt', xPts: 1.2 }), clubShort: 'DDD' },
    { ...player({ playerId: 5, name: 'Mine', xPts: 7 }), clubShort: 'EEE' },
  ];

  function seedRivalSquad(picks: { playerId: number; multiplier: number }[]): void {
    const insert = db.prepare(
      `INSERT INTO rival_pick (entry_id, event_id, player_id, slot, multiplier, captured_at)
       VALUES (7, 1, ?, ?, ?, ?)`,
    );
    picks.forEach((pick, index) => insert.run(pick.playerId, index + 1, pick.multiplier, nowSeconds()));
  }

  it('separates a player you simply missed from a punt the model does not rate', () => {
    // He owns Star (8.0, model agrees) and Punt (1.2, model does not). Both are players you do
    // not own, and treating them the same is exactly the mistake this exists to prevent.
    seedRivalSquad([
      { playerId: 1, multiplier: 2 },
      { playerId: 4, multiplier: 1 },
      { playerId: 5, multiplier: 1 },
    ]);

    const result = compareRival(db, 7, 1, projections, new Set([5]))!;

    expect(result.missed.map((p) => p.name)).toEqual(['Star']);
    expect(result.hisCall.map((p) => p.name)).toEqual(['Punt']);
    // A player you both own is neither - it is not a disagreement at all.
    expect([...result.missed, ...result.hisCall].map((p) => p.name)).not.toContain('Mine');
  });

  it('names who he captained, since that is the decision that moves a week', () => {
    seedRivalSquad([
      { playerId: 1, multiplier: 2 },
      { playerId: 2, multiplier: 1 },
    ]);
    expect(compareRival(db, 7, 1, projections, new Set())!.captain!.name).toBe('Star');
  });

  it('treats a triple captain as the armband too', () => {
    seedRivalSquad([{ playerId: 2, multiplier: 3 }]);
    expect(compareRival(db, 7, 1, projections, new Set())!.captain!.name).toBe('Solid');
  });

  it('runs the comparison both ways rather than only flattering him', () => {
    seedRivalSquad([{ playerId: 1, multiplier: 1 }]);
    const result = compareRival(db, 7, 1, projections, new Set([5]))!;
    expect(result.yoursOnly.map((p) => p.name)).toEqual(['Mine']);
  });

  it('carries who he is, so the page is not comparing you to an entry id', () => {
    seedRivalSquad([{ playerId: 1, multiplier: 1 }]);
    const result = compareRival(db, 7, 1, projections, new Set())!;
    expect(result.label).toBe('Rival R');
    expect(result.totalPoints).toBe(300);
  });

  it('says nothing at all when his squad is not public yet', () => {
    // Picks stay private until a gameweek kicks off. Inventing a comparison from an empty squad
    // would read as "he owns nothing you are missing", which is a claim, not an absence.
    expect(compareRival(db, 7, 1, projections, new Set())).toBeNull();
    expect(compareRivals(db, 1, projections, new Set())).toEqual([]);
  });

  it('ignores a gameweek other than the one asked for', () => {
    seedRivalSquad([{ playerId: 1, multiplier: 1 }]);
    expect(compareRival(db, 7, 2, projections, new Set())).toBeNull();
  });
});
