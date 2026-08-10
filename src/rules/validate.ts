import type { Rules } from '../config/schema.js';
import type { PlayerCandidate } from '../domain/types.js';

export interface Violation {
  rule: string;
  message: string;
}

export class IllegalSelectionError extends Error {
  readonly violations: Violation[];

  constructor(violations: Violation[]) {
    super(
      `Selection breaks ${violations.length} rule(s):\n${violations
        .map((violation) => `  - ${violation.message}`)
        .join('\n')}`,
    );
    this.name = 'IllegalSelectionError';
    this.violations = violations;
  }
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Validate a full 15-player squad against every hard constraint.
 *
 * Returns violations rather than throwing, so callers can report all the problems at once.
 * `assertLegalSquad` is the gate that turns them into a failure.
 */
export function validateSquad(
  players: readonly PlayerCandidate[],
  rules: Rules,
  options: { budget?: number } = {},
): Violation[] {
  const violations: Violation[] = [];
  const budget = options.budget ?? rules.squad.budget;

  if (players.length !== rules.squad.size) {
    violations.push({
      rule: 'squad.size',
      message: `Squad has ${players.length} players, must have exactly ${rules.squad.size}`,
    });
  }

  const duplicates = players.length - new Set(players.map((player) => player.playerId)).size;
  if (duplicates > 0) {
    violations.push({
      rule: 'squad.duplicates',
      message: `Squad contains the same player more than once (${duplicates} duplicate selection(s))`,
    });
  }

  const byPosition = countBy(players, (player) => player.position);
  for (const [position, required] of Object.entries(rules.squad.positionCounts)) {
    const actual = byPosition.get(position) ?? 0;
    if (actual !== required) {
      violations.push({
        rule: 'squad.positionCounts',
        message: `Squad has ${actual} ${position}, must have exactly ${required}`,
      });
    }
  }
  for (const position of byPosition.keys()) {
    if (!Object.hasOwn(rules.squad.positionCounts, position)) {
      violations.push({
        rule: 'squad.positionCounts',
        message: `Squad contains position '${position}', which has no rule in config`,
      });
    }
  }

  const totalCost = players.reduce((sum, player) => sum + player.price, 0);
  if (totalCost > budget) {
    violations.push({
      rule: 'squad.budget',
      message: `Squad costs £${(totalCost / 10).toFixed(1)}m, over the £${(budget / 10).toFixed(1)}m budget`,
    });
  }

  const byClub = countBy(players, (player) => String(player.clubId));
  for (const [clubId, count] of byClub) {
    if (count > rules.squad.maxPerClub) {
      const clubShort = players.find((player) => String(player.clubId) === clubId)?.clubShort ?? clubId;
      violations.push({
        rule: 'squad.maxPerClub',
        message: `Squad has ${count} players from ${clubShort}, more than the ${rules.squad.maxPerClub} allowed`,
      });
    }
  }

  for (const player of players) {
    if (player.availability.excluded) {
      violations.push({
        rule: 'availability',
        message: `${player.name} cannot play (${player.availability.reason}) and must not be selected`,
      });
    }
  }

  return violations;
}

/**
 * Validate a starting XI, its bench, and the captaincy.
 *
 * `squad` is the 15 the XI must be drawn from. Passing it is what stops an XI containing a
 * player who is not actually owned.
 */
export function validateStartingEleven(
  starters: readonly PlayerCandidate[],
  bench: readonly PlayerCandidate[],
  rules: Rules,
  options: {
    squad?: readonly PlayerCandidate[];
    captainId?: number;
    viceCaptainId?: number;
  } = {},
): Violation[] {
  const violations: Violation[] = [];

  if (starters.length !== rules.startingXi.size) {
    violations.push({
      rule: 'startingXi.size',
      message: `Starting XI has ${starters.length} players, must have exactly ${rules.startingXi.size}`,
    });
  }

  if (bench.length !== rules.bench.size) {
    violations.push({
      rule: 'bench.size',
      message: `Bench has ${bench.length} players, must have exactly ${rules.bench.size}`,
    });
  }

  const starterIds = new Set(starters.map((player) => player.playerId));
  const overlap = bench.filter((player) => starterIds.has(player.playerId));
  if (overlap.length > 0) {
    violations.push({
      rule: 'startingXi.overlap',
      message: `${overlap.map((player) => player.name).join(', ')} appear in both the XI and the bench`,
    });
  }

  if (options.squad) {
    const squadIds = new Set(options.squad.map((player) => player.playerId));
    const outsiders = [...starters, ...bench].filter((player) => !squadIds.has(player.playerId));
    if (outsiders.length > 0) {
      violations.push({
        rule: 'startingXi.notInSquad',
        message: `${outsiders.map((player) => player.name).join(', ')} are not in the squad`,
      });
    }
  }

  const byPosition = countBy(starters, (player) => player.position);
  for (const [position, bounds] of Object.entries(rules.startingXi.positionBounds)) {
    const actual = byPosition.get(position) ?? 0;
    if (actual < bounds.min || actual > bounds.max) {
      violations.push({
        rule: 'startingXi.positionBounds',
        message: `Starting XI has ${actual} ${position}, must be between ${bounds.min} and ${bounds.max}`,
      });
    }
  }

  const benchByPosition = countBy(bench, (player) => player.position);
  for (const [position, required] of Object.entries(rules.bench.positionCounts)) {
    const actual = benchByPosition.get(position) ?? 0;
    if (actual !== required) {
      violations.push({
        rule: 'bench.positionCounts',
        message: `Bench has ${actual} ${position}, must have exactly ${required}`,
      });
    }
  }

  for (const player of starters) {
    if (player.availability.excluded) {
      violations.push({
        rule: 'availability',
        message: `${player.name} cannot play (${player.availability.reason}) and must not start`,
      });
    }
  }

  if (options.captainId !== undefined) {
    if (!starterIds.has(options.captainId)) {
      violations.push({
        rule: 'captain.inXi',
        message: 'The captain must be in the starting XI',
      });
    }
    if (options.viceCaptainId !== undefined) {
      if (!starterIds.has(options.viceCaptainId)) {
        violations.push({
          rule: 'captain.viceInXi',
          message: 'The vice-captain must be in the starting XI',
        });
      }
      if (options.captainId === options.viceCaptainId) {
        violations.push({
          rule: 'captain.distinct',
          message: 'The captain and vice-captain must be different players',
        });
      }
    }
  }

  return violations;
}

/** The hard gate. Nothing reaches the user without passing through one of these. */
export function assertLegalSquad(
  players: readonly PlayerCandidate[],
  rules: Rules,
  options: { budget?: number } = {},
): void {
  const violations = validateSquad(players, rules, options);
  if (violations.length > 0) throw new IllegalSelectionError(violations);
}

export function assertLegalStartingEleven(
  starters: readonly PlayerCandidate[],
  bench: readonly PlayerCandidate[],
  rules: Rules,
  options: {
    squad?: readonly PlayerCandidate[];
    captainId?: number;
    viceCaptainId?: number;
  } = {},
): void {
  const violations = validateStartingEleven(starters, bench, rules, options);
  if (violations.length > 0) throw new IllegalSelectionError(violations);
}

/** Describe a formation as FPL does, e.g. "3-5-2" (defenders-midfielders-forwards). */
export function describeFormation(
  starters: readonly PlayerCandidate[],
  rules: Rules,
): string {
  const outfieldOrder = Object.keys(rules.startingXi.positionBounds).filter(
    (position) => rules.startingXi.positionBounds[position]!.max > 1,
  );
  const counts = countBy(starters, (player) => player.position);
  return outfieldOrder.map((position) => counts.get(position) ?? 0).join('-');
}
