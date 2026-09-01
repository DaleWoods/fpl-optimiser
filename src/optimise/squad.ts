import type { ModelWeights, Rules } from '../config/schema.js';
import type { ProjectedPlayer, StartingEleven } from '../domain/types.js';
import {
  assertLegalSquad,
  assertLegalStartingEleven,
  describeFormation,
} from '../rules/validate.js';
import { InfeasibleError, type Constraint, type IntegerProgram, type Solver } from './solver.js';

const IN_SQUAD = (id: number) => `x_${id}`;
const IN_XI = (id: number) => `y_${id}`;
const IS_CAPTAIN = (id: number) => `c_${id}`;

export interface SquadSelection {
  squad: ProjectedPlayer[];
  eleven: StartingEleven;
  totalCost: number;
  bankRemaining: number;
}

export interface SelectionOptions {
  /**
   * Extra, bounded points added to a player's captain-selection value only - player id to
   * bonus. Used to prefer a captain who is strong across a run of gameweeks over one who is
   * merely spiking this week, when the two are otherwise close. Never applied to what is
   * reported (StartingEleven.expectedPoints always uses the true, undiscounted xPts), and never
   * a penalty - a player simply absent from the map gets no bonus, not a deduction.
   */
  captainConsistencyBonus?: Map<number, number>;
  /**
   * The discounted value of the fixtures after this gameweek - player id to points. Added only
   * to a player's IN-SQUAD selection value (selectBestSquad), never to IN-XI or captaincy within
   * that same solve: who you OWN is a commitment that lasts until your next transfer, but who
   * starts and who you captain reset every gameweek regardless. Not used by selectBestEleven at
   * all - an already-owned squad's XI choice is rightly single-week, since every player in it is
   * owned either way and re-solved fresh next gameweek.
   */
  futureValueBonus?: Map<number, number>;
  /**
   * How far, at most, to relax the bench discount below - 0 leaves it untouched, 1 would treat
   * bench like starters. Used only by selectBestSquad: a squad built (or rebuilt on a
   * wildcard) with no regard for an approaching double gameweek would happily neglect its bench
   * right up until the week it would be worth boosting. Bounded, and only ever raises the bench
   * discount toward starter value, never past it.
   */
  benchBoostPull?: number;
}

function captainBonusFor(player: ProjectedPlayer, options: SelectionOptions): number {
  return options.captainConsistencyBonus?.get(player.playerId) ?? 0;
}

function futureValueBonusFor(player: ProjectedPlayer, options: SelectionOptions): number {
  return options.futureValueBonus?.get(player.playerId) ?? 0;
}

function benchWeightFor(
  player: ProjectedPlayer,
  rules: Rules,
  weights: ModelWeights,
  options: SelectionOptions = {},
): number {
  const isGoalkeeper = (rules.startingXi.positionBounds[player.position]?.max ?? 99) === 1;
  const base = isGoalkeeper ? weights.optimiser.benchGoalkeeperWeight : weights.optimiser.benchWeight;
  const pull = Math.min(1, Math.max(0, options.benchBoostPull ?? 0));
  return base + (1 - base) * pull;
}

/**
 * xPts alone is not enough to choose between two players: confidence describes how much to
 * trust the number itself. This is a selection-time risk discount only, used everywhere the
 * solver (or a tiebreak sort standing in for it, like bench order) compares players against
 * each other - display and accuracy grading always use the raw xPts, so the app never shows a
 * different number than the one it optimised on.
 */
export function selectionValue(player: ProjectedPlayer, weights: ModelWeights): number {
  return player.xPts * weights.confidence[player.confidence] * startRiskFactor(player, weights);
}

/**
 * An extra selection-time discount for a player who may well not be on the pitch at all.
 *
 * xPts already scales with expected minutes, so a player with a 20% chance of starting is
 * already projected at roughly a fifth of a starter's total. That is the correct *expected
 * value*, and it is still the wrong basis for filling a starting XI slot, because the outcomes
 * are not symmetrical. A 20%-to-start player is not "a fifth of a player": he is overwhelmingly
 * likely to return exactly nothing, and the slot spent on him cannot be recovered afterwards. A
 * genuine starter projected at the same number is a far better use of it.
 *
 * A defender with zero minutes all season, whose club had already played twice, kept getting
 * started on exactly this gap - his expected value looked survivable next to a weak squad's
 * other options, and he returned 0. Display and accuracy grading still use raw xPts.
 */
function startRiskFactor(player: ProjectedPlayer, weights: ModelWeights): number {
  const full = weights.minutes.expectedMinutesIfStarting || 1;
  const share = Math.min(1, Math.max(0, player.expectedMinutes / full));
  return share ** weights.optimiser.startRiskWeight;
}

/**
 * Order the bench for auto-subs: the goalkeeper sits outside the ordering (they can only
 * replace the keeper), and the outfield reserves are ranked by risk-adjusted expected points -
 * the auto-sub who actually comes on should be the safer bet, not just the highest raw number.
 */
export function orderBench(
  bench: ProjectedPlayer[],
  rules: Rules,
  weights: ModelWeights,
): ProjectedPlayer[] {
  const goalkeepers = bench.filter(
    (player) => (rules.startingXi.positionBounds[player.position]?.max ?? 99) === 1,
  );
  const outfield = bench
    .filter((player) => !goalkeepers.includes(player))
    .sort((a, b) => selectionValue(b, weights) - selectionValue(a, weights));
  return [...goalkeepers, ...outfield];
}

function buildEleven(
  starters: ProjectedPlayer[],
  bench: ProjectedPlayer[],
  captain: ProjectedPlayer,
  rules: Rules,
  weights: ModelWeights,
): StartingEleven {
  // Vice-captain is the best remaining starter by risk-adjusted value - the armband may fall to
  // him if the captain doesn't play, so a speculative punt is the wrong choice even if its raw
  // xPts edges out a safer starter's. Ceiling is used only as a tiebreak, per D4.
  const viceCaptain = starters
    .filter((player) => player.playerId !== captain.playerId)
    .sort(
      (a, b) =>
        selectionValue(b, weights) - selectionValue(a, weights) ||
        (b.breakdown.goals ?? 0) * weights.captain.ceilingWeight -
          (a.breakdown.goals ?? 0) * weights.captain.ceilingWeight,
    )[0];

  if (!viceCaptain) {
    throw new InfeasibleError('Cannot choose a vice-captain: fewer than two players in the XI');
  }

  // Reported and graded on the true, undiscounted projection - only selection is risk-adjusted.
  const expectedPoints =
    starters.reduce((total, player) => total + player.xPts, 0) +
    captain.xPts * (rules.captain.multiplier - 1);

  return {
    starters: [...starters].sort((a, b) => b.xPts - a.xPts),
    bench: orderBench(bench, rules, weights),
    captain,
    viceCaptain,
    formation: describeFormation(starters, rules),
    expectedPoints: Math.round(expectedPoints * 100) / 100,
  };
}

function captaincyConstraints(players: readonly ProjectedPlayer[]): Constraint[] {
  const constraints: Constraint[] = [
    {
      name: 'one_captain',
      terms: players.map((player) => ({ variable: IS_CAPTAIN(player.playerId), coefficient: 1 })),
      bound: { type: 'equal', value: 1 },
    },
  ];

  // The captain must be a starter: c_i - y_i <= 0.
  for (const player of players) {
    constraints.push({
      name: `captain_starts_${player.playerId}`,
      terms: [
        { variable: IS_CAPTAIN(player.playerId), coefficient: 1 },
        { variable: IN_XI(player.playerId), coefficient: -1 },
      ],
      bound: { type: 'atMost', value: 0 },
    });
  }

  return constraints;
}

function elevenConstraints(players: readonly ProjectedPlayer[], rules: Rules): Constraint[] {
  const constraints: Constraint[] = [
    {
      name: 'xi_size',
      terms: players.map((player) => ({ variable: IN_XI(player.playerId), coefficient: 1 })),
      bound: { type: 'equal', value: rules.startingXi.size },
    },
  ];

  for (const [position, bounds] of Object.entries(rules.startingXi.positionBounds)) {
    const terms = players
      .filter((player) => player.position === position)
      .map((player) => ({ variable: IN_XI(player.playerId), coefficient: 1 }));
    if (terms.length === 0) continue;
    constraints.push({
      name: `xi_position_${position}`,
      terms,
      bound: { type: 'between', min: bounds.min, max: bounds.max },
    });
  }

  return constraints;
}

/**
 * Choose the best legal starting XI, captain and bench order from a fixed 15.
 *
 * Solved exactly rather than by trying formations: the solver considers every legal
 * combination at once and returns a provably optimal one.
 */
export async function selectBestEleven(
  squad: readonly ProjectedPlayer[],
  rules: Rules,
  weights: ModelWeights,
  solver: Solver,
  options: SelectionOptions = {},
): Promise<StartingEleven> {
  const selectable = squad.filter((player) => !player.availability.excluded);

  if (selectable.length < rules.startingXi.size) {
    throw new InfeasibleError(
      `Only ${selectable.length} of your ${squad.length} players can play, which is not enough ` +
        `to field ${rules.startingXi.size}. Unavailable: ` +
        squad
          .filter((player) => player.availability.excluded)
          .map((player) => `${player.name} (${player.availability.reason})`)
          .join(', '),
    );
  }

  const program: IntegerProgram = {
    name: 'best_eleven',
    direction: 'maximise',
    objective: [
      ...selectable.map((player) => ({
        variable: IN_XI(player.playerId),
        coefficient: selectionValue(player, weights),
      })),
      ...selectable.map((player) => ({
        variable: IS_CAPTAIN(player.playerId),
        coefficient:
          selectionValue(player, weights) * (rules.captain.multiplier - 1) +
          captainBonusFor(player, options),
      })),
    ],
    constraints: [...elevenConstraints(selectable, rules), ...captaincyConstraints(selectable)],
    binaries: [
      ...selectable.map((player) => IN_XI(player.playerId)),
      ...selectable.map((player) => IS_CAPTAIN(player.playerId)),
    ],
  };

  const result = await solver.solve(program);
  if (!result.optimal) {
    throw new InfeasibleError(
      `No legal starting XI could be found (solver reported: ${result.status}). ` +
        'This usually means too many players are unavailable to fill a valid formation.',
    );
  }

  const starters = selectable.filter((player) => (result.values.get(IN_XI(player.playerId)) ?? 0) > 0.5);
  const starterIds = new Set(starters.map((player) => player.playerId));
  const bench = squad.filter((player) => !starterIds.has(player.playerId));

  const captain = selectable.find(
    (player) => (result.values.get(IS_CAPTAIN(player.playerId)) ?? 0) > 0.5,
  );
  if (!captain) throw new InfeasibleError('Solver returned no captain');

  const eleven = buildEleven(starters, bench, captain, rules, weights);

  // The hard gate: nothing is returned without passing the rules engine, independently of
  // whatever the solver believed it was doing.
  assertLegalStartingEleven(eleven.starters, eleven.bench, rules, {
    squad,
    captainId: eleven.captain.playerId,
    viceCaptainId: eleven.viceCaptain.playerId,
  });

  return eleven;
}

/**
 * Choose the best legal 15-player squad from the whole player pool, together with the XI it
 * would field. This is the season-start and wildcard problem.
 *
 * Squad and XI are solved together on purpose. Picking 15 on total expected points alone would
 * happily spend the budget on four excellent bench players who never start; the objective
 * weights a bench place far lower than a starting place, so the money goes where it scores.
 */
export async function selectBestSquad(
  pool: readonly ProjectedPlayer[],
  rules: Rules,
  weights: ModelWeights,
  solver: Solver,
  options: { budget?: number; mustInclude?: number[]; mustExclude?: number[] } & SelectionOptions = {},
): Promise<SquadSelection> {
  const budget = options.budget ?? rules.squad.budget;
  const mustInclude = new Set(options.mustInclude ?? []);
  const mustExclude = new Set(options.mustExclude ?? []);

  const selectable = pool.filter(
    (player) => !player.availability.excluded && !mustExclude.has(player.playerId),
  );

  assertPoolIsViable(selectable, rules, budget);

  const constraints: Constraint[] = [
    {
      name: 'squad_size',
      terms: selectable.map((player) => ({ variable: IN_SQUAD(player.playerId), coefficient: 1 })),
      bound: { type: 'equal', value: rules.squad.size },
    },
    {
      name: 'budget',
      terms: selectable.map((player) => ({
        variable: IN_SQUAD(player.playerId),
        coefficient: player.price,
      })),
      bound: { type: 'atMost', value: budget },
    },
  ];

  for (const [position, required] of Object.entries(rules.squad.positionCounts)) {
    constraints.push({
      name: `squad_position_${position}`,
      terms: selectable
        .filter((player) => player.position === position)
        .map((player) => ({ variable: IN_SQUAD(player.playerId), coefficient: 1 })),
      bound: { type: 'equal', value: required },
    });
  }

  const clubIds = [...new Set(selectable.map((player) => player.clubId))];
  for (const clubId of clubIds) {
    constraints.push({
      name: `club_limit_${clubId}`,
      terms: selectable
        .filter((player) => player.clubId === clubId)
        .map((player) => ({ variable: IN_SQUAD(player.playerId), coefficient: 1 })),
      bound: { type: 'atMost', value: rules.squad.maxPerClub },
    });
  }

  // A starter must be in the squad: y_i - x_i <= 0.
  for (const player of selectable) {
    constraints.push({
      name: `starter_owned_${player.playerId}`,
      terms: [
        { variable: IN_XI(player.playerId), coefficient: 1 },
        { variable: IN_SQUAD(player.playerId), coefficient: -1 },
      ],
      bound: { type: 'atMost', value: 0 },
    });
  }

  for (const playerId of mustInclude) {
    if (!selectable.some((player) => player.playerId === playerId)) {
      throw new InfeasibleError(
        `Player ${playerId} was required in the squad but is not selectable (unavailable, or not in the pool)`,
      );
    }
    constraints.push({
      name: `must_include_${playerId}`,
      terms: [{ variable: IN_SQUAD(playerId), coefficient: 1 }],
      bound: { type: 'equal', value: 1 },
    });
  }

  const program: IntegerProgram = {
    name: 'best_squad',
    direction: 'maximise',
    objective: [
      // A squad place is worth the bench weighting, plus the future value of holding the
      // player beyond this gameweek; a starting place makes up the rest of this week's value.
      ...selectable.map((player) => ({
        variable: IN_SQUAD(player.playerId),
        coefficient:
          selectionValue(player, weights) * benchWeightFor(player, rules, weights, options) +
          futureValueBonusFor(player, options),
      })),
      ...selectable.map((player) => ({
        variable: IN_XI(player.playerId),
        coefficient:
          selectionValue(player, weights) * (1 - benchWeightFor(player, rules, weights, options)),
      })),
      ...selectable.map((player) => ({
        variable: IS_CAPTAIN(player.playerId),
        coefficient:
          selectionValue(player, weights) * (rules.captain.multiplier - 1) +
          captainBonusFor(player, options),
      })),
    ],
    constraints: [
      ...constraints,
      ...elevenConstraints(selectable, rules),
      ...captaincyConstraints(selectable),
    ],
    binaries: [
      ...selectable.map((player) => IN_SQUAD(player.playerId)),
      ...selectable.map((player) => IN_XI(player.playerId)),
      ...selectable.map((player) => IS_CAPTAIN(player.playerId)),
    ],
  };

  const result = await solver.solve(program);
  if (!result.optimal) {
    throw new InfeasibleError(
      `No legal squad could be built within £${(budget / 10).toFixed(1)}m ` +
        `(solver reported: ${result.status}).`,
    );
  }

  const squad = selectable.filter(
    (player) => (result.values.get(IN_SQUAD(player.playerId)) ?? 0) > 0.5,
  );
  const starters = squad.filter((player) => (result.values.get(IN_XI(player.playerId)) ?? 0) > 0.5);
  const starterIds = new Set(starters.map((player) => player.playerId));
  const bench = squad.filter((player) => !starterIds.has(player.playerId));
  const captain = starters.find(
    (player) => (result.values.get(IS_CAPTAIN(player.playerId)) ?? 0) > 0.5,
  );
  if (!captain) throw new InfeasibleError('Solver returned no captain');

  const totalCost = squad.reduce((sum, player) => sum + player.price, 0);

  // Hard gate again, on the full squad this time.
  assertLegalSquad(squad, rules, { budget });
  const eleven = buildEleven(starters, bench, captain, rules, weights);
  assertLegalStartingEleven(eleven.starters, eleven.bench, rules, {
    squad,
    captainId: eleven.captain.playerId,
    viceCaptainId: eleven.viceCaptain.playerId,
  });

  return { squad, eleven, totalCost, bankRemaining: budget - totalCost };
}

export interface TransferPlanSelection {
  squad: ProjectedPlayer[];
  eleven: StartingEleven;
  totalCost: number;
  bankRemaining: number;
  /** Reference-squad players not in the new squad. */
  transfersOut: ProjectedPlayer[];
  /** New-squad players not in the reference squad. Same length as transfersOut. */
  transfersIn: ProjectedPlayer[];
  hitsTaken: number;
  hitCost: number;
}

/**
 * The best legal squad reachable from a reference squad within a transfer budget - not just one
 * swap at a time, the whole squad considered together.
 *
 * A single good player is sometimes only affordable by trimming two or three others to fund
 * them - findTransfers()'s pairwise search can never find that, because every candidate it
 * considers has to be a net gain entirely on its own, one swap at a time. This solves the whole
 * thing as one problem instead: spend up to the full current squad value plus bank, and pay a
 * hit for every transfer beyond the free allowance, exactly as findTransfers() does - but let
 * the solver decide how many changes are actually worth making, all at once, provably optimal
 * for the constraints given rather than found by trial and error.
 *
 * The hit cost is folded straight into the objective via a slack variable `hits`, bounded below
 * by zero and required to be at least (transfers made - free transfers). Since hits only ever
 * costs the objective, the solver pushes it down to exactly that value at the optimum - the
 * standard linear-programming way to fold in a max(0, x) penalty without branching on it.
 */
export async function selectBestTransferPlan(
  pool: readonly ProjectedPlayer[],
  referenceSquad: readonly ProjectedPlayer[],
  rules: Rules,
  weights: ModelWeights,
  solver: Solver,
  options: { totalBudget: number; freeTransfers: number; hitCost: number } & SelectionOptions,
): Promise<TransferPlanSelection> {
  const selectable = pool.filter((player) => !player.availability.excluded);
  assertPoolIsViable(selectable, rules, options.totalBudget);

  const referenceIds = new Set(referenceSquad.map((player) => player.playerId));
  const referenceSelectable = selectable.filter((player) => referenceIds.has(player.playerId));

  const constraints: Constraint[] = [
    {
      name: 'squad_size',
      terms: selectable.map((player) => ({ variable: IN_SQUAD(player.playerId), coefficient: 1 })),
      bound: { type: 'equal', value: rules.squad.size },
    },
    {
      name: 'budget',
      terms: selectable.map((player) => ({
        variable: IN_SQUAD(player.playerId),
        coefficient: player.price,
      })),
      bound: { type: 'atMost', value: options.totalBudget },
    },
    // hits must be non-negative: an explicit row rather than relying on an implicit default
    // column bound, so this holds regardless of how the underlying solver treats an unlisted
    // variable.
    { name: 'hits_non_negative', terms: [{ variable: 'hits', coefficient: 1 }], bound: { type: 'atLeast', value: 0 } },
    // hits >= transfersMade - freeTransfers, i.e. hits >= (squadSize - kept) - freeTransfers,
    // rearranged so every term has a fixed coefficient: hits + sum(kept) >= squadSize - free.
    {
      name: 'hit_slack',
      terms: [
        { variable: 'hits', coefficient: 1 },
        ...referenceSelectable.map((player) => ({ variable: IN_SQUAD(player.playerId), coefficient: 1 })),
      ],
      bound: { type: 'atLeast', value: rules.squad.size - options.freeTransfers },
    },
  ];

  for (const [position, required] of Object.entries(rules.squad.positionCounts)) {
    constraints.push({
      name: `squad_position_${position}`,
      terms: selectable
        .filter((player) => player.position === position)
        .map((player) => ({ variable: IN_SQUAD(player.playerId), coefficient: 1 })),
      bound: { type: 'equal', value: required },
    });
  }

  const clubIds = [...new Set(selectable.map((player) => player.clubId))];
  for (const clubId of clubIds) {
    constraints.push({
      name: `club_limit_${clubId}`,
      terms: selectable
        .filter((player) => player.clubId === clubId)
        .map((player) => ({ variable: IN_SQUAD(player.playerId), coefficient: 1 })),
      bound: { type: 'atMost', value: rules.squad.maxPerClub },
    });
  }

  for (const player of selectable) {
    constraints.push({
      name: `starter_owned_${player.playerId}`,
      terms: [
        { variable: IN_XI(player.playerId), coefficient: 1 },
        { variable: IN_SQUAD(player.playerId), coefficient: -1 },
      ],
      bound: { type: 'atMost', value: 0 },
    });
  }

  const program: IntegerProgram = {
    name: 'best_transfer_plan',
    direction: 'maximise',
    objective: [
      ...selectable.map((player) => ({
        variable: IN_SQUAD(player.playerId),
        coefficient:
          selectionValue(player, weights) * benchWeightFor(player, rules, weights, options) +
          futureValueBonusFor(player, options),
      })),
      ...selectable.map((player) => ({
        variable: IN_XI(player.playerId),
        coefficient:
          selectionValue(player, weights) * (1 - benchWeightFor(player, rules, weights, options)),
      })),
      ...selectable.map((player) => ({
        variable: IS_CAPTAIN(player.playerId),
        coefficient:
          selectionValue(player, weights) * (rules.captain.multiplier - 1) +
          captainBonusFor(player, options),
      })),
      { variable: 'hits', coefficient: -options.hitCost },
    ],
    constraints: [
      ...constraints,
      ...elevenConstraints(selectable, rules),
      ...captaincyConstraints(selectable),
    ],
    binaries: [
      ...selectable.map((player) => IN_SQUAD(player.playerId)),
      ...selectable.map((player) => IN_XI(player.playerId)),
      ...selectable.map((player) => IS_CAPTAIN(player.playerId)),
    ],
  };

  const result = await solver.solve(program);
  if (!result.optimal) {
    throw new InfeasibleError(
      `No legal transfer plan could be found within £${(options.totalBudget / 10).toFixed(1)}m ` +
        `(solver reported: ${result.status}).`,
    );
  }

  const squad = selectable.filter(
    (player) => (result.values.get(IN_SQUAD(player.playerId)) ?? 0) > 0.5,
  );
  const starters = squad.filter((player) => (result.values.get(IN_XI(player.playerId)) ?? 0) > 0.5);
  const starterIds = new Set(starters.map((player) => player.playerId));
  const bench = squad.filter((player) => !starterIds.has(player.playerId));
  const captain = starters.find(
    (player) => (result.values.get(IS_CAPTAIN(player.playerId)) ?? 0) > 0.5,
  );
  if (!captain) throw new InfeasibleError('Solver returned no captain');

  const totalCost = squad.reduce((sum, player) => sum + player.price, 0);

  assertLegalSquad(squad, rules, { budget: options.totalBudget });
  const eleven = buildEleven(starters, bench, captain, rules, weights);
  assertLegalStartingEleven(eleven.starters, eleven.bench, rules, {
    squad,
    captainId: eleven.captain.playerId,
    viceCaptainId: eleven.viceCaptain.playerId,
  });

  const newIds = new Set(squad.map((player) => player.playerId));
  const transfersOut = referenceSquad.filter((player) => !newIds.has(player.playerId));
  const transfersIn = squad.filter((player) => !referenceIds.has(player.playerId));
  const hitsTaken = Math.max(0, transfersOut.length - options.freeTransfers);

  return {
    squad,
    eleven,
    totalCost,
    bankRemaining: options.totalBudget - totalCost,
    transfersOut,
    transfersIn,
    hitsTaken,
    hitCost: hitsTaken * options.hitCost,
  };
}

/** Fail with something actionable before handing an impossible problem to the solver. */
function assertPoolIsViable(
  pool: readonly ProjectedPlayer[],
  rules: Rules,
  budget: number,
): void {
  for (const [position, required] of Object.entries(rules.squad.positionCounts)) {
    const available = pool.filter((player) => player.position === position);
    if (available.length < required) {
      throw new InfeasibleError(
        `Only ${available.length} available ${position} in the player pool, but a squad needs ${required}. ` +
          'Ingest fresh data, or check how many players are flagged as unavailable.',
      );
    }
  }

  // The cheapest legal squad, ignoring club limits - a quick lower bound on cost.
  let cheapest = 0;
  for (const [position, required] of Object.entries(rules.squad.positionCounts)) {
    cheapest += pool
      .filter((player) => player.position === position)
      .map((player) => player.price)
      .sort((a, b) => a - b)
      .slice(0, required)
      .reduce((sum, price) => sum + price, 0);
  }
  if (cheapest > budget) {
    throw new InfeasibleError(
      `Even the cheapest legal squad costs £${(cheapest / 10).toFixed(1)}m, which is over the ` +
        `£${(budget / 10).toFixed(1)}m budget.`,
    );
  }
}
