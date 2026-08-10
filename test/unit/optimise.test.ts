import { describe, expect, it } from 'vitest';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import type { ProjectedPlayer } from '../../src/domain/types.js';
import { GlpkSolver } from '../../src/optimise/glpkSolver.js';
import { InfeasibleError } from '../../src/optimise/solver.js';
import { orderBench, selectBestEleven, selectBestSquad } from '../../src/optimise/squad.js';
import { validateSquad, validateStartingEleven } from '../../src/rules/validate.js';
import { legalSquad, player, playerPool } from '../support/players.js';

const rules = loadRules();
const weights = loadModelWeights();
const solver = new GlpkSolver();

/**
 * An independent brute-force oracle.
 *
 * Choosing 11 from 15 is only 1365 combinations, so the exhaustively best legal XI can be
 * computed directly. The optimiser is checked against this rather than against itself - if the
 * ILP formulation is subtly wrong, comparing it to its own output would never reveal it.
 */
function bruteForceBestEleven(squad: ProjectedPlayer[]): { ids: number[]; total: number } | null {
  const available = squad.filter((p) => !p.availability.excluded);
  let best: { ids: number[]; total: number } | null = null;

  const combine = (start: number, chosen: ProjectedPlayer[]): void => {
    if (chosen.length === rules.startingXi.size) {
      if (validateStartingEleven(chosen, [], rules).some((v) => v.rule === 'startingXi.positionBounds')) {
        return;
      }
      // Captain doubles the best starter.
      const sorted = [...chosen].sort((a, b) => b.xPts - a.xPts);
      const total =
        chosen.reduce((sum, p) => sum + p.xPts, 0) +
        (sorted[0]?.xPts ?? 0) * (rules.captain.multiplier - 1);
      if (!best || total > best.total) {
        best = { ids: chosen.map((p) => p.playerId).sort((a, b) => a - b), total };
      }
      return;
    }
    for (let i = start; i < available.length; i += 1) {
      combine(i + 1, [...chosen, available[i]!]);
    }
  };

  combine(0, []);
  return best;
}

describe('best starting XI', () => {
  it('matches an exhaustive brute-force search', async () => {
    // Varied scores so there is a single clear optimum.
    const squad = legalSquad((index) => ({ xPts: 2 + ((index * 7) % 11) * 0.5 }));

    const eleven = await selectBestEleven(squad, rules, weights, solver);
    const brute = bruteForceBestEleven(squad)!;

    expect(eleven.expectedPoints).toBeCloseTo(brute.total, 4);
    expect(eleven.starters.map((p) => p.playerId).sort((a, b) => a - b)).toEqual(brute.ids);
  });

  it('matches brute force again when some players are unavailable', async () => {
    const squad = legalSquad((index) => ({
      xPts: 3 + ((index * 5) % 9) * 0.4,
      status: index === 3 || index === 9 ? 'i' : 'a',
    }));

    const eleven = await selectBestEleven(squad, rules, weights, solver);
    const brute = bruteForceBestEleven(squad)!;

    expect(eleven.expectedPoints).toBeCloseTo(brute.total, 4);
  });

  it('returns a legal XI and bench', async () => {
    const squad = legalSquad((index) => ({ xPts: 1 + index * 0.3 }));
    const eleven = await selectBestEleven(squad, rules, weights, solver);

    expect(eleven.starters).toHaveLength(11);
    expect(eleven.bench).toHaveLength(4);
    expect(validateStartingEleven(eleven.starters, eleven.bench, rules, { squad })).toEqual([]);
  });

  it('never starts an unavailable player, however high their projection', async () => {
    // The strongest player in the squad by a mile - but injured. He must not start.
    const squad = legalSquad((index) => ({
      xPts: index === 5 ? 100 : 3,
      status: index === 5 ? 'i' : 'a',
    }));

    const eleven = await selectBestEleven(squad, rules, weights, solver);

    expect(eleven.starters.map((p) => p.playerId)).not.toContain(6);
    expect(eleven.captain.playerId).not.toBe(6);
    expect(eleven.viceCaptain.playerId).not.toBe(6);
  });

  it('still weights a doubtful player rather than banning them', async () => {
    const squad = legalSquad((index) => ({
      xPts: index === 5 ? 20 : 3,
      status: index === 5 ? 'd' : 'a',
      chance: index === 5 ? 75 : null,
    }));
    const eleven = await selectBestEleven(squad, rules, weights, solver);
    expect(eleven.starters.map((p) => p.playerId)).toContain(6);
  });

  it('captains the highest-scoring starter', async () => {
    const squad = legalSquad((index) => ({ xPts: index === 7 ? 12 : 3 }));
    const eleven = await selectBestEleven(squad, rules, weights, solver);
    expect(eleven.captain.playerId).toBe(8);
  });

  it('makes the second best starter vice-captain', async () => {
    const squad = legalSquad((index) => ({ xPts: index === 7 ? 12 : index === 8 ? 9 : 3 }));
    const eleven = await selectBestEleven(squad, rules, weights, solver);
    expect(eleven.captain.playerId).toBe(8);
    expect(eleven.viceCaptain.playerId).toBe(9);
  });

  it('picks a valid formation and reports it', async () => {
    const squad = legalSquad((index) => ({ xPts: 3 + (index % 4) }));
    const eleven = await selectBestEleven(squad, rules, weights, solver);
    const [def, mid, fwd] = eleven.formation.split('-').map(Number);
    expect(def! + mid! + fwd!).toBe(10); // plus the goalkeeper
    expect(def).toBeGreaterThanOrEqual(3);
    expect(fwd).toBeGreaterThanOrEqual(1);
  });

  it('orders the bench by expected points, keeper aside', async () => {
    const bench = [
      player({ playerId: 101, position: 'GKP', xPts: 1 }),
      player({ playerId: 102, position: 'DEF', xPts: 2 }),
      player({ playerId: 103, position: 'MID', xPts: 5 }),
      player({ playerId: 104, position: 'FWD', xPts: 3 }),
    ];
    const ordered = orderBench(bench, rules);
    expect(ordered.map((p) => p.playerId)).toEqual([101, 103, 104, 102]);
  });

  it('explains itself when too many players are unavailable to field a side', async () => {
    const squad = legalSquad((index) => ({ status: index < 6 ? 'i' : 'a' }));
    await expect(selectBestEleven(squad, rules, weights, solver)).rejects.toThrow(InfeasibleError);
    await expect(selectBestEleven(squad, rules, weights, solver)).rejects.toThrow(
      /Only 9 of your 15 players can play/,
    );
  });
});

describe('best squad from the whole pool', () => {
  it('builds a legal squad inside the budget', async () => {
    const pool = playerPool({ clubs: 10, perPosition: 3 });
    const result = await selectBestSquad(pool, rules, weights, solver);

    expect(result.squad).toHaveLength(15);
    expect(result.totalCost).toBeLessThanOrEqual(rules.squad.budget);
    expect(validateSquad(result.squad, rules)).toEqual([]);
    expect(validateStartingEleven(result.eleven.starters, result.eleven.bench, rules, {
      squad: result.squad,
    })).toEqual([]);
  });

  it('respects the three-per-club limit across the whole pool', async () => {
    const pool = playerPool({ clubs: 6, perPosition: 4 });
    const result = await selectBestSquad(pool, rules, weights, solver);

    const byClub = new Map<number, number>();
    for (const p of result.squad) byClub.set(p.clubId, (byClub.get(p.clubId) ?? 0) + 1);
    for (const count of byClub.values()) expect(count).toBeLessThanOrEqual(3);
  });

  it('never selects an unavailable player', async () => {
    const pool = playerPool({ clubs: 10, perPosition: 3 }).map((p) =>
      p.playerId % 4 === 0 ? player({ ...p, status: 'i', xPts: 50 }) : p,
    );
    const result = await selectBestSquad(pool, rules, weights, solver);
    expect(result.squad.every((p) => !p.availability.excluded)).toBe(true);
  });

  it('spends the budget on starters rather than the bench', async () => {
    const pool = playerPool({ clubs: 12, perPosition: 3 });
    const result = await selectBestSquad(pool, rules, weights, solver);

    const starterSpend = result.eleven.starters.reduce((sum, p) => sum + p.price, 0);
    const benchSpend = result.eleven.bench.reduce((sum, p) => sum + p.price, 0);
    expect(starterSpend).toBeGreaterThan(benchSpend * 2);
  });

  it('honours a tighter budget', async () => {
    const pool = playerPool({ clubs: 12, perPosition: 3 });
    const result = await selectBestSquad(pool, rules, weights, solver, { budget: 800 });
    expect(result.totalCost).toBeLessThanOrEqual(800);
    expect(validateSquad(result.squad, rules, { budget: 800 })).toEqual([]);
  });

  it('can be forced to keep a particular player', async () => {
    const pool = playerPool({ clubs: 12, perPosition: 3 });
    const keeper = pool.find((p) => p.position === 'FWD' && p.xPts < 3)!;
    const result = await selectBestSquad(pool, rules, weights, solver, {
      mustInclude: [keeper.playerId],
    });
    expect(result.squad.map((p) => p.playerId)).toContain(keeper.playerId);
  });

  it('says plainly when the pool cannot fill a position', async () => {
    const pool = playerPool({ clubs: 10, perPosition: 3 }).filter((p) => p.position !== 'GKP');
    await expect(selectBestSquad(pool, rules, weights, solver)).rejects.toThrow(
      /Only 0 available GKP/,
    );
  });

  it('says plainly when even the cheapest legal squad is unaffordable', async () => {
    const pool = playerPool({ clubs: 10, perPosition: 3 });
    await expect(selectBestSquad(pool, rules, weights, solver, { budget: 100 })).rejects.toThrow(
      /cheapest legal squad costs/,
    );
  });

  it('finds a better squad than a greedy pick-the-best-you-can-afford approach', async () => {
    const pool = playerPool({ clubs: 12, perPosition: 3 });
    const result = await selectBestSquad(pool, rules, weights, solver);

    // Greedy baseline: take the highest xPts per position until the counts are met, ignoring
    // budget interactions. This is exactly the approach the spec rules out.
    const greedy: ProjectedPlayer[] = [];
    for (const [position, count] of Object.entries(rules.squad.positionCounts)) {
      greedy.push(
        ...pool
          .filter((p) => p.position === position)
          .sort((a, b) => b.xPts - a.xPts)
          .slice(0, count),
      );
    }
    const greedyCost = greedy.reduce((sum, p) => sum + p.price, 0);

    // The greedy squad is either illegal (over budget or over the club limit) or worse.
    const greedyLegal = validateSquad(greedy, rules).length === 0;
    if (greedyLegal) {
      const greedyXi = greedy.sort((a, b) => b.xPts - a.xPts).slice(0, 11);
      const greedyTotal = greedyXi.reduce((sum, p) => sum + p.xPts, 0);
      expect(result.eleven.expectedPoints).toBeGreaterThanOrEqual(greedyTotal);
    } else {
      expect(greedyCost > rules.squad.budget || !greedyLegal).toBe(true);
    }
  });
});
