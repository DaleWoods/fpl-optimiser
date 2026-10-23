import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import { runBacktest, type BacktestResult } from './backtest.js';

/**
 * Turning each part of the model off, one at a time, and replaying the season without it.
 *
 * Every component in here was added because it sounded right. None has ever been asked to
 * justify itself, and the model has spent the season losing to the manager it advises - so at
 * least one of them is probably costing points rather than earning them. A component that does
 * nothing is dead weight; a component that does harm is worse than dead weight, and neither is
 * visible from a figure that only ever reports the whole model at once.
 *
 * This is deliberately a *subtractive* test. Adding a feature and watching the number go up is
 * the easiest way in the world to fool yourself, because there is always some number that went
 * up. Removing one and watching the number stay still is a much harder thing to explain away.
 *
 * ## What it can and cannot see
 *
 * The replay holds your squad fixed and scores the XI and the captain chosen from it. So this
 * measures each component's effect on **those two decisions only**. A component that mainly
 * shapes which fifteen you own - the horizon, the bench discount, anything priced - is invisible
 * here, and is reported as such rather than as a zero. "No effect on picking an XI" and "no
 * effect" are different claims and must not be allowed to look alike.
 *
 * ## Reading the result
 *
 * `delta` is points per week WITHOUT the component minus points per week WITH it. So:
 *
 *  - **negative** - removing it costs points, so it is earning its place;
 *  - **positive** - removing it GAINS points, so it is actively harmful;
 *  - **zero** - it changed no decision at all over the replayed weeks.
 *
 * The interval is what decides whether any of that is real, and over a short season almost
 * nothing will be. That is the honest answer, and it is still far more useful than a point
 * estimate nobody can act on.
 */

export interface AblationRow {
  key: string;
  label: string;
  /** What is switched off, in words, for the page. */
  what: string;
  /** Points per week without it, minus points per week with it. */
  delta: number;
  /** Weekly scores with the component removed, for the paired comparison. */
  weekly: number[];
  /** 95% paired-bootstrap interval on `delta`. */
  low: number;
  high: number;
  significant: boolean;
  /** True when removing it changed no XI or captain in any replayed week. */
  inert: boolean;
  /** Set when the component cannot be judged by this instrument at all. */
  notMeasurable: string | null;
}

export interface AblationResult {
  /** The full model's weekly scores, which every row is paired against. */
  baselineWeekly: number[];
  baselineMean: number;
  weeks: number;
  rows: AblationRow[];
  detectableEdge: number | null;
  notes: string[];
}

/** A component, and the weights that switch it off. */
interface Knockout {
  key: string;
  label: string;
  what: string;
  /** Null when this instrument structurally cannot see it - see the header. */
  notMeasurable?: string;
  apply: (weights: ModelWeights) => ModelWeights;
}

/** Structured clone that keeps the type, so a knockout cannot leak into the live weights. */
function clone(weights: ModelWeights): ModelWeights {
  return JSON.parse(JSON.stringify(weights)) as ModelWeights;
}

export const KNOCKOUTS: Knockout[] = [
  {
    key: 'clubForm',
    label: 'Club form',
    what: "the expected-goals adjustment to each club's strength rating",
    apply: (weights) => {
      const next = clone(weights);
      next.teamStrength.tableWeight = 0;
      return next;
    },
  },
  {
    key: 'expectedGoals',
    label: 'Expected goals',
    what: 'preferring expected goals to goals actually scored, for players',
    apply: (weights) => {
      const next = clone(weights);
      next.attacking.xgWeight = 0;
      return next;
    },
  },
  {
    key: 'recentForm',
    label: 'Recent form',
    what: 'weighting the last few gameweeks above the season average',
    apply: (weights) => {
      const next = clone(weights);
      next.attacking.recentWeight = 0;
      next.minutes.recentWeight = 0;
      next.saves.recentWeight = 0;
      next.bonus.recentWeight = 0;
      next.defensiveContribution.recentWeight = 0;
      return next;
    },
  },
  {
    key: 'fixtureDifficulty',
    label: 'Fixture difficulty',
    what: "scaling a player's attacking rate by how hard the fixture is",
    apply: (weights) => {
      const next = clone(weights);
      next.attacking.fixtureScalingWeight = 0;
      return next;
    },
  },
  {
    key: 'calibration',
    label: 'Self-correction',
    what: "the model's own measured error, applied back to its projections",
    apply: (weights) => {
      const next = clone(weights);
      next.calibration.enabled = false;
      return next;
    },
  },
  {
    key: 'differential',
    label: 'Differential bonus',
    what: 'the nudge toward players few managers own',
    apply: (weights) => {
      const next = clone(weights);
      next.differential.weight = 0;
      return next;
    },
  },
  {
    key: 'eliteOwnership',
    label: 'What good managers own',
    what: 'the nudge toward players the sampled top managers hold',
    apply: (weights) => {
      const next = clone(weights);
      next.eliteOwnership.weight = 0;
      next.eliteOwnership.captainWeight = 0;
      return next;
    },
  },
  {
    key: 'captainCeiling',
    label: 'Captain upside',
    what: 'preferring a captain with a higher ceiling at the same average',
    apply: (weights) => {
      const next = clone(weights);
      next.captain.ceilingWeight = 0;
      next.captain.maxCeilingBonus = 0;
      return next;
    },
  },
  {
    key: 'rotationRisk',
    label: 'Rotation risk',
    what: 'discounting a player whose club played again very recently',
    apply: (weights) => {
      const next = clone(weights);
      next.minutes.rotationRiskDiscount = 1;
      return next;
    },
  },
  {
    key: 'ownershipPrior',
    label: 'Ownership as a starting prior',
    what: 'using how widely a player is owned to guess whether he starts',
    apply: (weights) => {
      const next = clone(weights);
      next.minutes.ownershipPriorMax = next.minutes.priorStartProbability;
      next.minutes.lowOwnershipStartCap = 1;
      return next;
    },
  },
  {
    key: 'horizon',
    label: 'The run of fixtures',
    what: 'looking beyond this gameweek when choosing players',
    notMeasurable:
      'The replay holds your squad fixed, and the run of fixtures only ever decides which ' +
      'fifteen you own - never which eleven of them play this week. Measuring it needs a ' +
      'replay that simulates transfers, which would change the squad and make the weeks ' +
      'incomparable.',
    apply: (weights) => {
      const next = clone(weights);
      next.horizon.length = 1;
      return next;
    },
  },
];

export function runAblation(db: Database, rules: Rules, weights: ModelWeights): AblationResult {
  const baseline = runBacktest(db, rules, weights);
  const notes: string[] = [];

  if (baseline.weeks.length < 2) {
    return {
      baselineWeekly: baseline.policies.find((p) => p.key === 'model')?.weekly ?? [],
      baselineMean: baseline.policies.find((p) => p.key === 'model')?.mean ?? 0,
      weeks: baseline.weeks.length,
      rows: [],
      detectableEdge: baseline.detectableEdge,
      notes: [
        'Not enough replayable gameweeks to turn anything off and see what happens. This needs ' +
          'at least two, and is worth very little below about ten.',
      ],
    };
  }

  const baselineWeekly = baseline.policies.find((policy) => policy.key === 'model')!.weekly;
  const baselineByEvent = new Map(
    baseline.weeks.map((week, index) => [week.eventId, baselineWeekly[index]!]),
  );

  const rows: AblationRow[] = [];
  for (const knockout of KNOCKOUTS) {
    const without = runBacktest(db, rules, knockout.apply(weights));
    const withoutModel = without.policies.find((policy) => policy.key === 'model')!;

    // Paired on gameweek rather than on position in the list. A knockout can change which
    // weeks are replayable at all - a projection of zero everywhere fails the coverage gate -
    // and lining two different sets of weeks up by index would silently compare GW4 against
    // GW6 and call the difference an effect.
    const differences: number[] = [];
    without.weeks.forEach((week, index) => {
      const base = baselineByEvent.get(week.eventId);
      if (base !== undefined) differences.push(withoutModel.weekly[index]! - base);
    });

    if (differences.length === 0) {
      notes.push(`${knockout.label}: no gameweek could be replayed without it, so it is skipped.`);
      continue;
    }

    const interval = bootstrapInterval(differences);
    rows.push({
      key: knockout.key,
      label: knockout.label,
      what: knockout.what,
      delta: round(mean(differences)),
      weekly: withoutModel.weekly,
      low: round(interval.low),
      high: round(interval.high),
      significant: interval.low > 0 || interval.high < 0,
      inert: differences.every((difference) => difference === 0),
      notMeasurable: knockout.notMeasurable ?? null,
    });
  }

  // Sorted by how much harm removing it does, so the components earning their place come first
  // and anything actively costing points sits at the bottom where it is impossible to miss.
  rows.sort((a, b) => a.delta - b.delta);

  const inert = rows.filter((row) => row.inert && row.notMeasurable === null);
  if (inert.length > 0) {
    notes.push(
      `${inert.map((row) => row.label).join(', ')} changed no XI and no captain in any replayed ` +
        'gameweek. That is not the same as being wrong - it may simply never have been the ' +
        'deciding factor in a squad this small - but it has not earned its place here either.',
    );
  }

  return {
    baselineWeekly,
    baselineMean: baseline.policies.find((policy) => policy.key === 'model')!.mean,
    weeks: baseline.weeks.length,
    rows,
    detectableEdge: baseline.detectableEdge,
    notes,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Same fixed-seed paired bootstrap the backtest uses, and for the same reasons. */
function bootstrapInterval(values: number[], iterations = 10000): { low: number; high: number } {
  if (values.length < 2) return { low: Number.NaN, high: Number.NaN };

  let seed = 1234567;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const means: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let total = 0;
    for (let j = 0; j < values.length; j += 1) total += values[Math.floor(next() * values.length)]!;
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  return {
    low: means[Math.floor(iterations * 0.025)]!,
    high: means[Math.floor(iterations * 0.975)]!,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export type { BacktestResult };
