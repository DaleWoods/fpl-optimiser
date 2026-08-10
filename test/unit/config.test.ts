import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadAppConfig,
  loadModelWeights,
  loadRules,
  reconcilePositions,
  requireTeamId,
  stripComments,
  validateRulesConsistency,
} from '../../src/config/load.js';
import type { Rules } from '../../src/config/schema.js';

/** A deep clone so each test can mutate rules freely without leaking into the next. */
function mutableRules(): Rules {
  return structuredClone(loadRules());
}

describe('stripComments', () => {
  it('removes $-prefixed keys at every depth but keeps real values', () => {
    const input = {
      $comment: 'ignore me',
      keep: 1,
      nested: { $comment: ['a', 'b'], deep: { $note: 'x', value: 2 } },
      list: [{ $comment: 'y', n: 3 }],
    };
    expect(stripComments(input)).toEqual({
      keep: 1,
      nested: { deep: { value: 2 } },
      list: [{ n: 3 }],
    });
  });

  it('leaves primitives and nulls alone', () => {
    expect(stripComments(null)).toBeNull();
    expect(stripComments(5)).toBe(5);
    expect(stripComments('$comment')).toBe('$comment');
  });
});

describe('the shipped config files', () => {
  it('loads rules.json and it satisfies its own invariants', () => {
    const rules = loadRules();
    expect(rules.squad.size).toBe(15);
    expect(rules.squad.budget).toBe(1000);
    expect(rules.squad.maxPerClub).toBe(3);
    expect(rules.startingXi.size).toBe(11);
    expect(rules.transfers.hitCost).toBe(4);
    expect(rules.transfers.maxBanked).toBe(5);
    expect(() => validateRulesConsistency(rules)).not.toThrow();
  });

  it('encodes the 2/5/5/3 squad make-up from the spec', () => {
    const { positionCounts } = loadRules().squad;
    expect(positionCounts).toEqual({ GKP: 2, DEF: 5, MID: 5, FWD: 3 });
  });

  it('encodes the 2026/27 DefCon thresholds', () => {
    const defcon = loadRules().scoring.defensiveContribution;
    expect(defcon.points).toBe(2);
    expect(defcon.thresholds.DEF).toBe(10);
    expect(defcon.thresholds.MID).toBe(12);
    expect(defcon.thresholds.FWD).toBe(12);
    expect(defcon.thresholds.GKP).toBeNull();
  });

  it('loads model weights with a stamped model version', () => {
    const weights = loadModelWeights();
    expect(weights.modelVersion).toMatch(/\S/);
    expect(weights.availability.statusProbability.a).toBe(1);
    expect(weights.availability.statusProbability.i).toBe(0);
  });

  it('defaults the differential knob to pure expected-points maximisation (D4)', () => {
    expect(loadModelWeights().differential.weight).toBe(0);
  });

  it('loads app config with the configured team ID', () => {
    const app = loadAppConfig();
    expect(app.teamId).toBe(2651633);
    expect(app.api.userAgent).toMatch(/fpl-optimiser/);
    expect(app.api.minRequestIntervalMs).toBeGreaterThan(0);
  });
});

describe('requireTeamId', () => {
  it('explains how to find the team ID rather than guessing one', () => {
    const app = { ...loadAppConfig(), teamId: null };
    expect(() => requireTeamId(app)).toThrow(ConfigError);
    expect(() => requireTeamId(app)).toThrow(/config\/app\.json/);
  });

  it('returns the id once configured', () => {
    expect(requireTeamId({ ...loadAppConfig(), teamId: 1234567 })).toBe(1234567);
  });
});

describe('validateRulesConsistency', () => {
  it('rejects position counts that do not add up to the squad size', () => {
    const rules = mutableRules();
    rules.squad.positionCounts.DEF = 4;
    expect(() => validateRulesConsistency(rules)).toThrow(/sums to 14 but squad.size is 15/);
  });

  it('rejects an XI plus bench that does not equal the squad', () => {
    const rules = mutableRules();
    rules.bench.size = 3;
    expect(() => validateRulesConsistency(rules)).toThrow(/must equal squad.size/);
  });

  it('rejects a formation whose minimums cannot fit in the XI', () => {
    const rules = mutableRules();
    rules.startingXi.positionBounds.DEF = { min: 5, max: 5 };
    rules.startingXi.positionBounds.MID = { min: 5, max: 5 };
    rules.startingXi.positionBounds.FWD = { min: 3, max: 3 };
    expect(() => validateRulesConsistency(rules)).toThrow(/position minimums sum to 14/);
  });

  it('rejects a formation whose maximums cannot fill the XI', () => {
    const rules = mutableRules();
    rules.startingXi.positionBounds.DEF = { min: 3, max: 3 };
    rules.startingXi.positionBounds.MID = { min: 2, max: 3 };
    rules.startingXi.positionBounds.FWD = { min: 1, max: 3 };
    expect(() => validateRulesConsistency(rules)).toThrow(/position maximums sum to 10/);
  });

  it('rejects a position bound that exceeds the players available in the squad', () => {
    const rules = mutableRules();
    rules.startingXi.positionBounds.FWD = { min: 1, max: 4 };
    expect(() => validateRulesConsistency(rules)).toThrow(/exceeds the 3 FWD in the squad/);
  });

  it('rejects min greater than max', () => {
    const rules = mutableRules();
    rules.startingXi.positionBounds.MID = { min: 5, max: 2 };
    expect(() => validateRulesConsistency(rules)).toThrow(/min 5 exceeds max 2/);
  });

  it('rejects a bench composition inconsistent with the squad and XI', () => {
    const rules = mutableRules();
    rules.bench.positionCounts.GKP = 2;
    expect(() => validateRulesConsistency(rules)).toThrow(/bench.positionCounts.GKP is 2/);
  });

  it('rejects a banked-transfer cap below the weekly free allowance', () => {
    const rules = mutableRules();
    rules.transfers.maxBanked = 1;
    rules.transfers.freePerGameweek = 2;
    expect(() => validateRulesConsistency(rules)).toThrow(/below transfers.freePerGameweek/);
  });

  it('rejects squad and XI describing different sets of positions', () => {
    const rules = mutableRules();
    delete rules.startingXi.positionBounds.FWD;
    expect(() => validateRulesConsistency(rules)).toThrow(/must describe the same positions/);
  });
});

describe('reconcilePositions', () => {
  const rules = loadRules();

  it('accepts the live position codes the config was written for', () => {
    expect(() => reconcilePositions(rules, ['GKP', 'DEF', 'MID', 'FWD'])).not.toThrow();
  });

  it('is order independent', () => {
    expect(() => reconcilePositions(rules, ['FWD', 'MID', 'GKP', 'DEF'])).not.toThrow();
  });

  it('fails loudly when the API introduces a position config knows nothing about', () => {
    expect(() => reconcilePositions(rules, ['GKP', 'DEF', 'MID', 'FWD', 'WNG'])).toThrow(
      /no rules for/,
    );
  });

  it('fails loudly when a configured position disappears from the API', () => {
    expect(() => reconcilePositions(rules, ['GKP', 'DEF', 'MID'])).toThrow(/no longer returns/);
  });
});
