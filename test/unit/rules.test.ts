import { describe, expect, it } from 'vitest';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { availabilityLabel, classifyAvailability, hasWorsened } from '../../src/domain/availability.js';
import {
  assertLegalSquad,
  describeFormation,
  IllegalSelectionError,
  validateSquad,
  validateStartingEleven,
} from '../../src/rules/validate.js';
import { legalSquad, player } from '../support/players.js';

const rules = loadRules();
const weights = loadModelWeights();

describe('availability classification', () => {
  it('treats an available player as fully weighted', () => {
    const result = classifyAvailability({ status: 'a', chanceOfPlayingNextRound: null }, weights);
    expect(result.state).toBe('available');
    expect(result.probability).toBe(1);
    expect(result.excluded).toBe(false);
  });

  it('weights a doubtful player by the chance the API states', () => {
    for (const [chance, expected] of [
      [75, 0.75],
      [50, 0.5],
      [25, 0.25],
    ] as const) {
      const result = classifyAvailability({ status: 'd', chanceOfPlayingNextRound: chance }, weights);
      expect(result.probability).toBeCloseTo(expected);
      expect(result.state).toBe('doubtful');
      expect(availabilityLabel(result)).toBe(`Doubtful (${chance}%)`);
    }
  });

  it('excludes injured, suspended and unavailable players outright', () => {
    for (const status of ['i', 's', 'u', 'n']) {
      const result = classifyAvailability({ status, chanceOfPlayingNextRound: null }, weights);
      expect(result.probability).toBe(0);
      expect(result.excluded).toBe(true);
    }
  });

  it('excludes a player stated as 0% even when the status code says available', () => {
    // The two fields can disagree. The stated chance wins, and the player is excluded.
    const result = classifyAvailability({ status: 'a', chanceOfPlayingNextRound: 0 }, weights);
    expect(result.excluded).toBe(true);
    expect(result.state).toBe('unavailable');
  });

  it('treats an unrecognised status cautiously rather than as available', () => {
    const result = classifyAvailability({ status: 'z', chanceOfPlayingNextRound: null }, weights);
    expect(result.probability).toBeLessThan(1);
    expect(result.reason).toMatch(/Unrecognised/);
  });

  it('carries the news text into the reason, so advice can explain itself', () => {
    const result = classifyAvailability(
      { status: 'd', chanceOfPlayingNextRound: 50, news: 'Knock - assessed late' },
      weights,
    );
    expect(result.reason).toMatch(/Knock - assessed late/);
  });

  it('detects worsening availability', () => {
    const before = classifyAvailability({ status: 'a', chanceOfPlayingNextRound: null }, weights);
    const after = classifyAvailability({ status: 'd', chanceOfPlayingNextRound: 25 }, weights);
    expect(hasWorsened(before, after)).toBe(true);
    expect(hasWorsened(after, before)).toBe(false);
  });
});

describe('squad rules', () => {
  it('accepts a legal 15', () => {
    expect(validateSquad(legalSquad(), rules)).toEqual([]);
  });

  it('rejects a squad of the wrong size', () => {
    const violations = validateSquad(legalSquad().slice(0, 14), rules);
    expect(violations.map((v) => v.rule)).toContain('squad.size');
  });

  it('rejects the wrong number of a position', () => {
    const squad = legalSquad();
    squad[14] = player({ playerId: 15, position: 'MID', clubId: 9 });
    const violations = validateSquad(squad, rules);
    expect(violations.some((v) => v.message.includes('must have exactly 3'))).toBe(true);
  });

  it('rejects going over budget', () => {
    const squad = legalSquad(() => ({ price: 100 }));
    const violations = validateSquad(squad, rules);
    expect(violations.map((v) => v.rule)).toContain('squad.budget');
    expect(violations.find((v) => v.rule === 'squad.budget')?.message).toMatch(/£150\.0m/);
  });

  it('rejects a fourth player from the same club', () => {
    const squad = legalSquad();
    squad[14] = player({ playerId: 15, position: 'FWD', clubId: 1 });
    const violations = validateSquad(squad, rules);
    expect(violations.map((v) => v.rule)).toContain('squad.maxPerClub');
  });

  it('allows exactly three from one club', () => {
    expect(validateSquad(legalSquad(), rules).filter((v) => v.rule === 'squad.maxPerClub')).toEqual([]);
  });

  it('rejects the same player picked twice', () => {
    const squad = legalSquad();
    squad[1] = { ...squad[0]! };
    const violations = validateSquad(squad, rules);
    expect(violations.map((v) => v.rule)).toContain('squad.duplicates');
  });

  it('rejects an unavailable player, however cheap or highly rated', () => {
    const squad = legalSquad();
    squad[0] = player({ playerId: 1, position: 'GKP', clubId: 1, status: 'i', xPts: 99 });
    const violations = validateSquad(squad, rules);
    expect(violations.map((v) => v.rule)).toContain('availability');
  });

  it('throws with every violation listed at once', () => {
    const squad = legalSquad(() => ({ price: 100, clubId: 1 })).slice(0, 14);
    try {
      assertLegalSquad(squad, rules);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalSelectionError);
      const violations = (error as IllegalSelectionError).violations;
      expect(violations.length).toBeGreaterThan(2);
    }
  });
});

describe('starting XI rules', () => {
  const squad = legalSquad();
  const validXi = [
    ...squad.filter((p) => p.position === 'GKP').slice(0, 1),
    ...squad.filter((p) => p.position === 'DEF').slice(0, 4),
    ...squad.filter((p) => p.position === 'MID').slice(0, 4),
    ...squad.filter((p) => p.position === 'FWD').slice(0, 2),
  ];
  const validBench = squad.filter((p) => !validXi.includes(p));

  it('accepts a legal XI and bench', () => {
    expect(validateStartingEleven(validXi, validBench, rules, { squad })).toEqual([]);
  });

  it('rejects an XI without exactly one goalkeeper', () => {
    const twoKeepers = [...squad.filter((p) => p.position === 'GKP')].concat(validXi.slice(1, 10));
    const violations = validateStartingEleven(twoKeepers, validBench, rules);
    expect(violations.some((v) => v.message.includes('GKP'))).toBe(true);
  });

  it('rejects fewer than three defenders', () => {
    const thin = [
      ...squad.filter((p) => p.position === 'GKP').slice(0, 1),
      ...squad.filter((p) => p.position === 'DEF').slice(0, 2),
      ...squad.filter((p) => p.position === 'MID').slice(0, 5),
      ...squad.filter((p) => p.position === 'FWD').slice(0, 3),
    ];
    const violations = validateStartingEleven(thin, [], rules);
    expect(violations.some((v) => v.rule === 'startingXi.positionBounds')).toBe(true);
  });

  it('rejects an XI containing a player who is not in the squad', () => {
    const intruder = [...validXi.slice(0, 10), player({ playerId: 999, position: 'FWD', clubId: 8 })];
    const violations = validateStartingEleven(intruder, validBench, rules, { squad });
    expect(violations.map((v) => v.rule)).toContain('startingXi.notInSquad');
  });

  it('rejects an unavailable player in the XI', () => {
    const injured = player({ playerId: 1, position: 'GKP', clubId: 1, status: 'i' });
    const xi = [injured, ...validXi.slice(1)];
    const violations = validateStartingEleven(xi, validBench, rules);
    expect(violations.map((v) => v.rule)).toContain('availability');
  });

  it('rejects a captain who is not starting', () => {
    const violations = validateStartingEleven(validXi, validBench, rules, {
      squad,
      captainId: validBench[0]!.playerId,
    });
    expect(violations.map((v) => v.rule)).toContain('captain.inXi');
  });

  it('rejects the same player as captain and vice-captain', () => {
    const violations = validateStartingEleven(validXi, validBench, rules, {
      squad,
      captainId: validXi[0]!.playerId,
      viceCaptainId: validXi[0]!.playerId,
    });
    expect(violations.map((v) => v.rule)).toContain('captain.distinct');
  });

  it('rejects a player appearing in both the XI and the bench', () => {
    const violations = validateStartingEleven(validXi, [validXi[0]!, ...validBench.slice(1)], rules);
    expect(violations.map((v) => v.rule)).toContain('startingXi.overlap');
  });

  it('describes the formation the way FPL does', () => {
    expect(describeFormation(validXi, rules)).toBe('4-4-2');
  });
});
