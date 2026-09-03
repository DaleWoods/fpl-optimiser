import { describe, expect, it } from 'vitest';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { scoreDistribution } from '../../src/model/distribution.js';
import { projectPlayer, type PlayerModelInput } from '../../src/model/xpts.js';

const rules = loadRules();
const weights = loadModelWeights();

/** One ordinary fixture against an average opponent. */
const fixture = (overrides: Record<string, unknown> = {}) => ({
  teamAttack: 1100,
  teamDefence: 1100,
  opponentAttack: 1100,
  opponentDefence: 1100,
  isHome: true,
  opponentShort: 'AVL',
  difficulty: 3,
  ...overrides,
});

const input = (overrides: Partial<PlayerModelInput> = {}): PlayerModelInput => ({
  playerId: 1,
  name: 'Test',
  position: 'FWD',
  availability: { state: 'available', probability: 1, excluded: false, reason: 'Available' },
  ownership: 20,
  minutesPlayed: 900,
  matchesAvailable: 10,
  starts: 10,
  xgPer90: 0.5,
  xaPer90: 0.2,
  goalsPer90: 0.5,
  assistsPer90: 0.2,
  savesPer90: null,
  defconPer90: 2,
  bonusPer90: 0.4,
  fixtures: [fixture()],
  ...overrides,
});

const distributionFor = (overrides: Partial<PlayerModelInput> = {}) => {
  const projection = projectPlayer(input(overrides), weights, rules);
  return { projection, distribution: scoreDistribution(projection, weights) };
};

describe('score distribution', () => {
  it('has a mean that reconciles with the points model', () => {
    // If these two disagree, the distribution is describing a different player from the one
    // being recommended, and every number derived from it is decorative. The small gap that
    // remains is the parts held at their expected value rather than enumerated.
    const { projection, distribution } = distributionFor();
    expect(distribution).not.toBeNull();
    expect(distribution!.mean).toBeCloseTo(projection.xPtsRaw, 1);
  });

  it('gives a striker a higher ceiling than a defender at similar expected points', () => {
    // The whole point of the module. A defender's points come mostly from appearing, a clean
    // sheet and defensive contribution - real, but bounded. A striker's come from a rare,
    // high-value event, so the same average hides a very different shape.
    const striker = distributionFor({ position: 'FWD', xgPer90: 0.7, goalsPer90: 0.7 });
    const defender = distributionFor({
      position: 'DEF',
      xgPer90: 0.05,
      goalsPer90: 0.05,
      xaPer90: 0.05,
      assistsPer90: 0.05,
      defconPer90: 12,
    });

    expect(striker.distribution!.ceiling).toBeGreaterThan(defender.distribution!.ceiling);
    expect(striker.distribution!.haulProbability).toBeGreaterThan(
      defender.distribution!.haulProbability,
    );
  });

  it('separates an explosive player from a steady one', () => {
    // Same position, same fixture. One carries his value in a rare event, the other in a
    // reliable one - identical means would still be very different captaincy bets.
    const explosive = distributionFor({ xgPer90: 0.9, goalsPer90: 0.9, bonusPer90: 0 });
    const steady = distributionFor({ xgPer90: 0.1, goalsPer90: 0.1, bonusPer90: 1.5, defconPer90: 12 });

    expect(explosive.distribution!.ceiling).toBeGreaterThan(steady.distribution!.ceiling);
    expect(explosive.distribution!.blankProbability).toBeGreaterThan(
      steady.distribution!.blankProbability,
    );
  });

  it('returns nothing rather than NaN for a blank gameweek', () => {
    // No fixture means no modelled distribution at all. Absent is the honest answer; a zeroed
    // one would read as "we modelled this and it came out at nothing".
    const { distribution } = distributionFor({ fixtures: [] });
    expect(distribution).toBeNull();
  });

  it('handles a double gameweek without running off the end of the enumeration', () => {
    // Two fixtures double the expected counts, which is where a bound set too low would start
    // truncating real probability mass and quietly understate the ceiling.
    const single = distributionFor({ xgPer90: 0.9, goalsPer90: 0.9 });
    const double = distributionFor({
      xgPer90: 0.9,
      goalsPer90: 0.9,
      fixtures: [fixture(), fixture({ isHome: false, opponentShort: 'BUR' })],
    });

    expect(double.distribution!.ceiling).toBeGreaterThan(single.distribution!.ceiling);
    expect(double.distribution!.mean).toBeCloseTo(double.projection.xPtsRaw, 0);
  });

  it('prices in the chance of not playing at all', () => {
    // A doubled pick who does not start is the outcome captaincy most has to avoid, so it has
    // to be in the distribution rather than only in the mean.
    const nailed = distributionFor({ starts: 10, matchesAvailable: 10 });
    const rotated = distributionFor({ starts: 2, matchesAvailable: 10, ownership: 2 });

    expect(rotated.distribution!.blankProbability).toBeGreaterThan(
      nailed.distribution!.blankProbability,
    );
    expect(rotated.distribution!.ceiling).toBeLessThan(nailed.distribution!.ceiling);
  });
});
