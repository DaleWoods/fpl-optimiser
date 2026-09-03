import { describe, expect, it } from 'vitest';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import type { ProjectedPlayer } from '../../src/domain/types.js';
import { GlpkSolver } from '../../src/optimise/glpkSolver.js';
import { InfeasibleError } from '../../src/optimise/solver.js';
import {
  orderBench,
  selectBestEleven,
  selectBestSquad,
  selectBestTransferPlan,
  selectionValue,
  type SquadSelection,
} from '../../src/optimise/squad.js';
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

describe('selection value (confidence discount)', () => {
  it('leaves a high-confidence projection undiscounted', () => {
    const p = player({ xPts: 6, confidence: 'high' });
    expect(selectionValue(p, weights)).toBeCloseTo(6, 6);
  });

  it('discounts medium and low confidence, low more than medium', () => {
    const base = { xPts: 6 };
    const medium = selectionValue(player({ ...base, confidence: 'medium' }), weights);
    const low = selectionValue(player({ ...base, confidence: 'low' }), weights);
    expect(medium).toBeLessThan(6);
    expect(low).toBeLessThan(medium);
  });

  it('never touches the underlying xPts field itself', () => {
    const p = player({ xPts: 6, confidence: 'low' });
    selectionValue(p, weights);
    expect(p.xPts).toBe(6);
  });

  it('discounts a player who may not be on the pitch, beyond the expected value already in xPts', () => {
    // A defender with zero minutes all season, whose club had already played twice, kept being
    // started: his expected value looked survivable next to a weak squad's other options and he
    // returned 0. Expected value is the wrong basis for an XI slot - a 30%-to-start player is
    // not "a third of a player", he is overwhelmingly likely to return nothing at all.
    const nailedOn = player({ xPts: 2.5, confidence: 'medium', expectedMinutes: 80 });
    const barelyPlays = player({ xPts: 2.5, confidence: 'medium', expectedMinutes: 24 });

    // Same projected points, but the one who might not play is worth far less for a slot.
    expect(selectionValue(barelyPlays, weights)).toBeLessThan(selectionValue(nailedOn, weights) / 2);
    // The displayed projection is still untouched, as with the confidence discount.
    expect(barelyPlays.xPts).toBe(2.5);
  });
});

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

  it('prefers a proven starter over a speculative punt scoring marginally higher', async () => {
    // Player 8's raw projection edges out player 7's, but it is low confidence - discounted by
    // 20%, it no longer beats a solid, high-confidence starter. This is the risk adjustment
    // that keeps a noisy punt from crowding out an established pick on paper-thin margins.
    const squad = legalSquad((index) => ({
      xPts: index === 6 ? 10 : index === 7 ? 10.5 : 3,
      confidence: index === 7 ? 'low' : 'high',
    }));
    const eleven = await selectBestEleven(squad, rules, weights, solver);
    expect(eleven.captain.playerId).toBe(7);
  });

  it('still prefers the punt once its edge is too big for the discount to close', async () => {
    const squad = legalSquad((index) => ({
      xPts: index === 6 ? 10 : index === 7 ? 20 : 3,
      confidence: index === 7 ? 'low' : 'high',
    }));
    const eleven = await selectBestEleven(squad, rules, weights, solver);
    expect(eleven.captain.playerId).toBe(8);
  });

  it('lets a captain-consistency bonus break a near-tie toward the horizon-backed player', async () => {
    // Players 7 and 8 project almost identically this week; only a bonus for player 8 (standing
    // in for "strong across the whole horizon, not just this week") should decide it.
    const squad = legalSquad((index) => ({ xPts: index === 6 ? 10 : index === 7 ? 10.05 : 3 }));
    const withoutBonus = await selectBestEleven(squad, rules, weights, solver);
    expect(withoutBonus.captain.playerId).toBe(8);

    const bonus = new Map([[7, 5]]);
    const withBonus = await selectBestEleven(squad, rules, weights, solver, {
      captainConsistencyBonus: bonus,
    });
    expect(withBonus.captain.playerId).toBe(7);
  });

  it('never lets the captain-consistency bonus change what is reported as expectedPoints', async () => {
    const squad = legalSquad((index) => ({ xPts: index === 6 ? 10 : index === 7 ? 10.05 : 3 }));
    const bonus = new Map([[7, 5]]);
    const withBonus = await selectBestEleven(squad, rules, weights, solver, {
      captainConsistencyBonus: bonus,
    });

    const expected =
      withBonus.starters.reduce((sum, p) => sum + p.xPts, 0) +
      withBonus.captain.xPts * (rules.captain.multiplier - 1);
    expect(withBonus.expectedPoints).toBeCloseTo(Math.round(expected * 100) / 100, 2);
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
    const ordered = orderBench(bench, rules, weights);
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

  it('is not swayed by a marginal edge once the low-confidence discount is applied', async () => {
    const basePool = playerPool({ clubs: 12, perPosition: 3 });
    const target = basePool.find((p) => p.position === 'FWD')!;
    // A small raw bump (0.5 xPts) marked low confidence: discounted by 20%, it no longer beats
    // what the player would otherwise have scored, so the squad should be unchanged.
    const bumped = basePool.map((p) =>
      p.playerId === target.playerId
        ? { ...p, xPts: target.xPts + 0.5, confidence: 'low' as const }
        : p,
    );

    const baseline = await selectBestSquad(basePool, rules, weights, solver);
    const withMarginalPunt = await selectBestSquad(bumped, rules, weights, solver);

    expect(withMarginalPunt.squad.map((p) => p.playerId).sort()).toEqual(
      baseline.squad.map((p) => p.playerId).sort(),
    );
  });

  it('still lets a big enough raw edge overcome the confidence discount', async () => {
    const basePool = playerPool({ clubs: 12, perPosition: 3 });
    const target = basePool.find((p) => p.position === 'FWD')!;
    const bumped = basePool.map((p) =>
      p.playerId === target.playerId ? { ...p, xPts: 100, confidence: 'low' as const } : p,
    );

    const result = await selectBestSquad(bumped, rules, weights, solver);
    expect(result.squad.some((p) => p.playerId === target.playerId)).toBe(true);
  });

  it('lets a future-value bonus pull in a player who is tied on this week alone', async () => {
    // Two identical FWDs on this week's numbers; only a future-value bonus for one separates
    // them - standing in for "this club's fixtures improve after this gameweek".
    const basePool = playerPool({ clubs: 12, perPosition: 3 });
    const fwds = basePool.filter((p) => p.position === 'FWD');
    const target = { ...fwds[0]!, xPts: 6 };
    const rival = { ...fwds[1]!, xPts: 6 };
    const pool = basePool.map((p) =>
      p.playerId === target.playerId ? target : p.playerId === rival.playerId ? rival : p,
    );

    const withBonus = await selectBestSquad(pool, rules, weights, solver, {
      futureValueBonus: new Map([[rival.playerId, 5]]),
    });
    expect(withBonus.squad.some((p) => p.playerId === rival.playerId)).toBe(true);
  });

  it('never lets the future-value bonus change what is reported as expectedPoints', async () => {
    const pool = playerPool({ clubs: 12, perPosition: 3 });
    const target = pool.find((p) => p.position === 'FWD')!;

    const result = await selectBestSquad(pool, rules, weights, solver, {
      futureValueBonus: new Map([[target.playerId, 50]]),
    });

    const expected =
      result.eleven.starters.reduce((sum, p) => sum + p.xPts, 0) +
      result.eleven.captain.xPts * (rules.captain.multiplier - 1);
    expect(result.eleven.expectedPoints).toBeCloseTo(Math.round(expected * 100) / 100, 2);
  });

  it('spends more on bench quality when a bench-boost pull is applied', async () => {
    // Tight enough that bench-vs-starter spend is a genuine tradeoff, not free either way.
    const pool = playerPool({ clubs: 12, perPosition: 3 });
    const budget = 700;

    const without = await selectBestSquad(pool, rules, weights, solver, { budget });
    const withPull = await selectBestSquad(pool, rules, weights, solver, { budget, benchBoostPull: 1 });

    const benchXPts = (result: SquadSelection) =>
      result.eleven.bench.reduce((sum, p) => sum + p.xPts, 0);
    expect(benchXPts(withPull)).toBeGreaterThan(benchXPts(without));
  });

  it('never lets the bench-boost pull change what is reported as expectedPoints', async () => {
    const pool = playerPool({ clubs: 12, perPosition: 3 });
    const result = await selectBestSquad(pool, rules, weights, solver, {
      budget: 700,
      benchBoostPull: 1,
    });

    const expected =
      result.eleven.starters.reduce((sum, p) => sum + p.xPts, 0) +
      result.eleven.captain.xPts * (rules.captain.multiplier - 1);
    expect(result.eleven.expectedPoints).toBeCloseTo(Math.round(expected * 100) / 100, 2);
  });

  it('reports expectedPoints using the true xPts, never the risk-adjusted selection value', async () => {
    const squad = legalSquad((index) => ({
      xPts: index === 7 ? 12 : 3,
      confidence: index === 7 ? 'low' : 'high',
    }));
    const eleven = await selectBestEleven(squad, rules, weights, solver);

    const expected =
      eleven.starters.reduce((sum, p) => sum + p.xPts, 0) +
      eleven.captain.xPts * (rules.captain.multiplier - 1);
    expect(eleven.expectedPoints).toBeCloseTo(Math.round(expected * 100) / 100, 2);
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

describe('best transfer plan (whole-squad rebuild within budget)', () => {
  it('finds a two-player swap that only pays off together, when no single swap could afford it', async () => {
    const squad = legalSquad(); // 15 players, £4.5m each, xPts 4 each, clubs 1-5 (3 each)
    const totalBudget = squad.reduce((sum, p) => sum + p.price, 0); // 675, no bank

    // A standout midfielder at £7.5m - a single swap could only free bank(0) + one £4.5m
    // player's price = £4.5m, nowhere near enough on its own. Affordable only by also
    // downgrading a second player to free the rest of the budget.
    const star = player({ playerId: 101, name: 'Star', position: 'MID', clubId: 9, price: 75, xPts: 12 });
    const cheapDef = player({ playerId: 102, name: 'CheapDef', position: 'DEF', clubId: 9, price: 10, xPts: 2 });
    const pool = [...squad, star, cheapDef];

    const plan = await selectBestTransferPlan(pool, squad, rules, weights, solver, {
      totalBudget,
      freeTransfers: 1,
      hitCost: rules.transfers.hitCost,
    });

    expect(plan.transfersIn.map((p) => p.playerId)).toContain(101);
    expect(plan.transfersOut).toHaveLength(plan.transfersIn.length);
    expect(plan.hitsTaken).toBe(plan.transfersOut.length - 1);
    expect(plan.totalCost).toBeLessThanOrEqual(totalBudget);
  });

  it('makes no changes when nothing in the pool beats the reference squad', async () => {
    const squad = legalSquad();
    const totalBudget = squad.reduce((sum, p) => sum + p.price, 0);
    // Same price, strictly worse - never worth taking even for free.
    const worseAlternative = player({ playerId: 101, position: 'MID', clubId: 9, price: 45, xPts: 3 });

    const plan = await selectBestTransferPlan([...squad, worseAlternative], squad, rules, weights, solver, {
      totalBudget,
      freeTransfers: 1,
      hitCost: rules.transfers.hitCost,
    });

    expect(plan.transfersOut).toEqual([]);
    expect(plan.transfersIn).toEqual([]);
    expect(plan.hitsTaken).toBe(0);
  });

  it('never returns a squad over budget or over the three-per-club limit', async () => {
    const squad = legalSquad();
    const totalBudget = squad.reduce((sum, p) => sum + p.price, 0);
    // Offset ids well clear of legalSquad()'s 1-15 - playerPool() numbers its own players from 1.
    const pool = playerPool({ clubs: 12, perPosition: 3 }).map((p) => ({ ...p, playerId: p.playerId + 1000 }));

    const plan = await selectBestTransferPlan([...squad, ...pool], squad, rules, weights, solver, {
      totalBudget,
      freeTransfers: 1,
      hitCost: rules.transfers.hitCost,
    });

    expect(validateSquad(plan.squad, rules)).toEqual([]);
    expect(plan.totalCost).toBeLessThanOrEqual(totalBudget);
  });

  it('takes a hit only when the plan is worth more than it costs', async () => {
    const squad = legalSquad();
    const totalBudget = squad.reduce((sum, p) => sum + p.price, 0);
    // A tiny upgrade, not worth a -4 hit even though it is a genuine improvement.
    const marginallyBetter = player({ playerId: 101, position: 'MID', clubId: 9, price: 45, xPts: 4.2 });

    const plan = await selectBestTransferPlan([...squad, marginallyBetter], squad, rules, weights, solver, {
      totalBudget,
      freeTransfers: 0,
      hitCost: rules.transfers.hitCost,
    });

    // With no free transfers at all, a swap worth only +0.2 xPts must not be taken for a -4 hit.
    expect(plan.transfersOut).toEqual([]);
  });
});

describe('captaincy on the shape of the score, not just its mean', () => {
  /**
   * Two candidates the expected-points term rates as near-equal, one carrying far more upside
   * beyond his own mean. Everyone else is well below both so the only live question is which of
   * the two gets the armband.
   */
  const twoCandidates = (steadyXPts: number, explosiveXPts: number): ProjectedPlayer[] =>
    legalSquad((index) => {
      if (index === 10) return { xPts: steadyXPts, ceiling: steadyXPts + 0.5, name: 'Steady' };
      if (index === 11) return { xPts: explosiveXPts, ceiling: explosiveXPts + 9, name: 'Explosive' };
      return { xPts: 3 };
    });

  it('prefers the higher-ceiling captain between two near-equal candidates', () => {
    // The captain doubles, so the shape matters and not just the average. Note this is decided
    // inside the ILP objective, not by the vice-captain sort in buildEleven - a change made in
    // the wrong place here looks like it did nothing.
    return selectBestEleven(twoCandidates(8.0, 7.9), rules, weights, solver).then((eleven) => {
      expect(eleven.captain.name).toBe('Explosive');
    });
  });

  it('does not let ceiling overturn a clear difference in expected points', () => {
    // maxCeilingBonus exists for exactly this. A ceiling breaks a tie between similar bets; it
    // never justifies captaining a materially worse player.
    return selectBestEleven(twoCandidates(10.0, 7.9), rules, weights, solver).then((eleven) => {
      expect(eleven.captain.name).toBe('Steady');
    });
  });

  it('separates two near-equal vice-captains by ceiling', () => {
    // The buildEleven path. This comparison used to sit behind a `||` that short-circuits only
    // on exactly zero, so it never ran and captain.ceilingWeight was dead config.
    const squad = legalSquad((index) => {
      if (index === 9) return { xPts: 20, name: 'Captain' };
      if (index === 10) return { xPts: 8.0, ceiling: 8.2, name: 'Steady' };
      if (index === 11) return { xPts: 7.95, ceiling: 18, name: 'Explosive' };
      return { xPts: 3 };
    });

    return selectBestEleven(squad, rules, weights, solver).then((eleven) => {
      expect(eleven.captain.name).toBe('Captain');
      expect(eleven.viceCaptain.name).toBe('Explosive');
    });
  });

  it('ignores ceiling entirely when its weight is zero', () => {
    // The switch has to be real: a knob that cannot be turned off cannot be checked. Before this
    // change ceilingWeight was already inert, which is precisely the bug.
    const off = { ...weights, captain: { ...weights.captain, ceilingWeight: 0, maxCeilingBonus: 0 } };
    return selectBestEleven(twoCandidates(8.0, 7.9), rules, off, solver).then((eleven) => {
      expect(eleven.captain.name).toBe('Steady');
    });
  });
});
