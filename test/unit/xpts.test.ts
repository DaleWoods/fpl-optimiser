import { describe, expect, it } from 'vitest';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { classifyAvailability } from '../../src/domain/availability.js';
import {
  cleanSheetProbability,
  defconProbability,
  expectedConcedingPenalty,
  expectedTeamGoals,
  poissonPmf,
  projectMinutes,
  projectPlayer,
  type FixtureContext,
  type PlayerModelInput,
} from '../../src/model/xpts.js';

const rules = loadRules();
const weights = loadModelWeights();

const available = classifyAvailability({ status: 'a', chanceOfPlayingNextRound: null }, weights);

function fixture(overrides: Partial<FixtureContext> = {}): FixtureContext {
  return {
    teamAttack: 1100,
    teamDefence: 1100,
    opponentAttack: 1100,
    opponentDefence: 1100,
    isHome: true,
    opponentShort: 'OPP',
    difficulty: 3,
    ...overrides,
  };
}

function input(overrides: Partial<PlayerModelInput> = {}): PlayerModelInput {
  return {
    playerId: 1,
    name: 'Test Player',
    position: 'MID',
    availability: available,
    ownership: 10,
    minutesPlayed: 900,
    matchesAvailable: 10,
    starts: 10,
    xgPer90: 0.3,
    xaPer90: 0.2,
    goalsPer90: 0.3,
    assistsPer90: 0.2,
    savesPer90: null,
    defconPer90: 4,
    bonusPer90: 0.3,
    fixtures: [fixture()],
    ...overrides,
  };
}

describe('poisson helpers', () => {
  it('gives a sane distribution', () => {
    expect(poissonPmf(0, 1)).toBeCloseTo(Math.exp(-1), 6);
    expect(poissonPmf(1, 1)).toBeCloseTo(Math.exp(-1), 6);
    let total = 0;
    for (let k = 0; k <= 30; k += 1) total += poissonPmf(k, 2.5);
    expect(total).toBeCloseTo(1, 4);
  });

  it('handles a zero mean', () => {
    expect(poissonPmf(0, 0)).toBe(1);
    expect(poissonPmf(1, 0)).toBe(0);
  });
});

describe('expected team goals', () => {
  it('gives a stronger attack more goals against the same defence', () => {
    const strong = expectedTeamGoals(1400, 1000, true, weights);
    const weak = expectedTeamGoals(900, 1000, true, weights);
    expect(strong).toBeGreaterThan(weak);
  });

  it('gives fewer goals against a stronger defence', () => {
    expect(expectedTeamGoals(1100, 1400, true, weights)).toBeLessThan(
      expectedTeamGoals(1100, 900, true, weights),
    );
  });

  it('rewards playing at home', () => {
    expect(expectedTeamGoals(1100, 1100, true, weights)).toBeGreaterThan(
      expectedTeamGoals(1100, 1100, false, weights),
    );
  });

  it('stays inside the configured bounds even for absurd inputs', () => {
    const huge = expectedTeamGoals(100000, 1, true, weights);
    const tiny = expectedTeamGoals(1, 100000, false, weights);
    expect(huge).toBeLessThanOrEqual(weights.teamStrength.maxExpectedGoals);
    expect(tiny).toBeGreaterThanOrEqual(weights.teamStrength.minExpectedGoals);
  });

  it('falls back to a default strength rather than dividing by zero', () => {
    expect(Number.isFinite(expectedTeamGoals(0, 0, true, weights))).toBe(true);
  });
});

describe('clean sheets and conceding', () => {
  it('makes a clean sheet less likely the more goals are expected against', () => {
    expect(cleanSheetProbability(0.5, weights)).toBeGreaterThan(cleanSheetProbability(2.5, weights));
  });

  it('clamps the probability to the configured range', () => {
    expect(cleanSheetProbability(0, weights)).toBeLessThanOrEqual(weights.cleanSheet.maxProbability);
    expect(cleanSheetProbability(99, weights)).toBeGreaterThanOrEqual(weights.cleanSheet.minProbability);
  });

  it('deducts points in bands of two goals, not by halving', () => {
    // With 1 expected goal against, a -1 is unlikely; a naive xGC/2 would say -0.5.
    const penalty = expectedConcedingPenalty(1, rules);
    expect(penalty).toBeLessThan(0);
    expect(penalty).toBeGreaterThan(-0.5);
  });

  it('deducts more as expected goals against rise', () => {
    expect(expectedConcedingPenalty(3, rules)).toBeLessThan(expectedConcedingPenalty(1, rules));
  });
});

describe('minutes', () => {
  it('shrinks a tiny sample toward the prior', () => {
    const oneStart = projectMinutes(input({ starts: 1, matchesAvailable: 1 }), weights);
    const manyStarts = projectMinutes(input({ starts: 20, matchesAvailable: 20 }), weights);
    expect(oneStart.startProbability).toBeLessThan(manyStarts.startProbability);
    expect(manyStarts.startProbability).toBeGreaterThan(0.8);
  });

  it('gives a regular starter more expected minutes than a squad player', () => {
    const starter = projectMinutes(input({ starts: 10, matchesAvailable: 10 }), weights);
    const fringe = projectMinutes(input({ starts: 1, matchesAvailable: 10 }), weights);
    expect(starter.expectedMinutes).toBeGreaterThan(fringe.expectedMinutes);
  });

  it('keeps probabilities in range for a player with no history', () => {
    const fresh = projectMinutes(input({ starts: 0, matchesAvailable: 0 }), weights);
    expect(fresh.startProbability).toBeGreaterThanOrEqual(0);
    expect(fresh.startProbability).toBeLessThanOrEqual(1);
  });
});

describe('defensive contribution', () => {
  it('is more likely for a player who racks up defensive actions', () => {
    expect(defconProbability(14, 10, weights)).toBeGreaterThan(defconProbability(4, 10, weights));
  });

  it('is a coin flip for a player averaging exactly the threshold', () => {
    expect(defconProbability(10, 10, weights)).toBeCloseTo(0.5, 6);
  });

  it('is zero where the position cannot earn it', () => {
    expect(defconProbability(20, null, weights)).toBe(0);
  });

  it('falls back rather than scoring zero when the stat is missing', () => {
    expect(defconProbability(null, 10, weights)).toBe(
      weights.defensiveContribution.fallbackProbability,
    );
  });
});

describe('player projection', () => {
  it('scores a good attacker higher than a poor one', () => {
    const good = projectPlayer(input({ xgPer90: 0.8, xaPer90: 0.4 }), weights, rules);
    const poor = projectPlayer(input({ xgPer90: 0.05, xaPer90: 0.05 }), weights, rules);
    expect(good.xPts).toBeGreaterThan(poor.xPts);
  });

  it('halves the projection of a 50% doubtful player', () => {
    const doubtful = classifyAvailability({ status: 'd', chanceOfPlayingNextRound: 50 }, weights);
    const fit = projectPlayer(input(), weights, rules);
    const flagged = projectPlayer(input({ availability: doubtful }), weights, rules);
    expect(flagged.xPts).toBeCloseTo(fit.xPts * 0.5, 5);
  });

  it('zeroes an unavailable player', () => {
    const injured = classifyAvailability({ status: 'i', chanceOfPlayingNextRound: null }, weights);
    expect(projectPlayer(input({ availability: injured }), weights, rules).xPts).toBe(0);
  });

  it('returns zero for a blank gameweek', () => {
    const blank = projectPlayer(input({ fixtures: [] }), weights, rules);
    expect(blank.xPts).toBe(0);
    expect(blank.reasons.join(' ')).toMatch(/blank/i);
  });

  it('scores a double gameweek higher than a single', () => {
    const single = projectPlayer(input({ fixtures: [fixture()] }), weights, rules);
    const double = projectPlayer(input({ fixtures: [fixture(), fixture()] }), weights, rules);
    expect(double.xPts).toBeGreaterThan(single.xPts);
  });

  it('rates an easy fixture above a hard one', () => {
    const easy = projectPlayer(input({ fixtures: [fixture({ opponentDefence: 900 })] }), weights, rules);
    const hard = projectPlayer(input({ fixtures: [fixture({ opponentDefence: 1400 })] }), weights, rules);
    expect(easy.xPts).toBeGreaterThan(hard.xPts);
  });

  it('gives defenders clean sheet value that midfielders get less of', () => {
    const base = { xgPer90: 0.05, xaPer90: 0.05, defconPer90: 0 };
    const defender = projectPlayer(input({ ...base, position: 'DEF' }), weights, rules);
    const midfielder = projectPlayer(input({ ...base, position: 'MID' }), weights, rules);
    expect(defender.breakdown.cleanSheet!).toBeGreaterThan(midfielder.breakdown.cleanSheet!);
  });

  it('gives goalkeepers save points', () => {
    const keeper = projectPlayer(
      input({ position: 'GKP', savesPer90: 3.5, xgPer90: 0, xaPer90: 0 }),
      weights,
      rules,
    );
    expect(keeper.breakdown.saves!).toBeGreaterThan(0);
  });

  it('rewards a defender who racks up defensive contributions', () => {
    const grafter = projectPlayer(input({ position: 'DEF', defconPer90: 14 }), weights, rules);
    const passenger = projectPlayer(input({ position: 'DEF', defconPer90: 2 }), weights, rules);
    expect(grafter.breakdown.defensiveContribution!).toBeGreaterThan(
      passenger.breakdown.defensiveContribution!,
    );
  });

  it('breaks the projection down so it can be explained', () => {
    const projection = projectPlayer(input(), weights, rules);
    for (const component of ['appearance', 'goals', 'assists', 'cleanSheet', 'bonus']) {
      expect(projection.breakdown).toHaveProperty(component);
    }
    const sum = Object.values(projection.breakdown).reduce((total, value) => total + value, 0);
    expect(sum).toBeCloseTo(projection.xPtsRaw, 2);
  });

  it('ignores the differential knob when it is switched off', () => {
    const popular = projectPlayer(input({ ownership: 60 }), weights, rules);
    const obscure = projectPlayer(input({ ownership: 0.5 }), weights, rules);
    expect(weights.differential.weight).toBe(0);
    expect(obscure.xPts).toBeCloseTo(popular.xPts, 6);
  });

  it('favours a differential once the knob is turned up', () => {
    const tuned = { ...weights, differential: { ...weights.differential, weight: 1 } };
    const popular = projectPlayer(input({ ownership: 60 }), tuned, rules);
    const obscure = projectPlayer(input({ ownership: 0.5 }), tuned, rules);
    expect(obscure.xPts).toBeGreaterThan(popular.xPts);
  });

  it('never returns a negative projection', () => {
    const awful = projectPlayer(
      input({ position: 'GKP', xgPer90: 0, xaPer90: 0, bonusPer90: 0, savesPer90: 0,
        fixtures: [fixture({ teamDefence: 500, opponentAttack: 1500 })] }),
      weights,
      rules,
    );
    expect(awful.xPts).toBeGreaterThanOrEqual(0);
  });

  it('marks a player with no history as low confidence', () => {
    const rookie = projectPlayer(
      input({ minutesPlayed: 0, matchesAvailable: 0, starts: 0, xgPer90: null }),
      weights,
      rules,
    );
    expect(rookie.confidence).toBe('low');
  });

  it('is deterministic', () => {
    const first = projectPlayer(input(), weights, rules);
    const second = projectPlayer(input(), weights, rules);
    expect(first).toEqual(second);
  });
});
