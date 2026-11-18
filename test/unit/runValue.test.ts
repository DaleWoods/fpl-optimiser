import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import type { ProjectedPlayer, StartingEleven } from '../../src/domain/types.js';
import { runValue } from '../../src/report/recommend.js';

const rules = loadRules();
const weights = loadModelWeights();

const player = (playerId: number, position: string): ProjectedPlayer =>
  ({ playerId, position, name: `P${playerId}`, xPts: 4 }) as ProjectedPlayer;

/**
 * The gain from a transfer used to be "his run of fixtures minus the other man's", whether or
 * not either of them would ever get on the pitch. Swapping one substitute for a better one was
 * credited with the whole difference and could out-rank a real upgrade to the eleven for the
 * one free transfer of the week.
 */
describe('what a run of fixtures is worth, given who actually plays', () => {
  const eleven = (starters: ProjectedPlayer[], bench: ProjectedPlayer[]): StartingEleven =>
    ({ starters, bench, captain: starters[0]!, viceCaptain: starters[1]!, formation: '', expectedPoints: 0 }) as StartingEleven;

  it('counts a starter in full and a substitute at the bench weighting', () => {
    const starter = player(1, 'MID');
    const substitute = player(2, 'MID');
    const future = (): number => 10;

    expect(runValue(eleven([starter], []), future, rules, weights)).toBeCloseTo(10, 6);
    expect(runValue(eleven([], [substitute]), future, rules, weights)).toBeCloseTo(
      10 * weights.optimiser.benchWeight,
      6,
    );
  });

  it('counts a reserve goalkeeper for almost nothing, because he almost never plays', () => {
    const value = runValue(eleven([], [player(3, 'GKP')]), () => 10, rules, weights);
    expect(value).toBeCloseTo(10 * weights.optimiser.benchGoalkeeperWeight, 6);
  });

  it('credits a bench-for-bench swap with a fraction of the difference, not all of it', () => {
    // Out: a substitute worth 4 over the run. In: a substitute worth 12. The old sum called
    // that +8. Nobody in the eleven has changed, so it is worth what eight points on the bench
    // are worth.
    const starters = [player(1, 'MID')];
    const before = runValue(eleven(starters, [player(2, 'DEF')]), (id) => (id === 2 ? 4 : 20), rules, weights);
    const after = runValue(eleven(starters, [player(9, 'DEF')]), (id) => (id === 9 ? 12 : 20), rules, weights);

    expect(after - before).toBeCloseTo(8 * weights.optimiser.benchWeight, 6);
    expect(after - before).toBeLessThan(2);
  });

  it('is what every transfer figure on the page is built from', () => {
    // Wiring, guarded apart from behaviour: the single-transfer cards, the priority-fix plan
    // and the Wildcard gain each compute a horizon gain, and any one of them quietly going
    // back to a plain sum would leave the others - and every test above - looking fine.
    const source = readFileSync(new URL('../../src/report/recommend.ts', import.meta.url), 'utf8');
    expect(source.match(/runValue\(/g)!.length).toBeGreaterThanOrEqual(7); // definition + 3 pairs
    expect(source).not.toMatch(/future\(incoming\.playerId\) - future\(out\.playerId\)/);
  });
});
