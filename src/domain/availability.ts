import type { ModelWeights } from '../config/schema.js';

export type AvailabilityState =
  | 'available'
  | 'doubtful'
  | 'injured'
  | 'suspended'
  | 'unavailable';

export interface AvailabilityInput {
  status: string | null;
  chanceOfPlayingNextRound: number | null;
  chanceOfPlayingThisRound?: number | null;
  news?: string | null;
}

export interface Availability {
  state: AvailabilityState;
  /** 0..1. Every xPts figure is multiplied by this. */
  probability: number;
  /** Plain English, for the explanation attached to any recommendation. */
  reason: string;
  /** True when the player must never appear in a recommendation. */
  excluded: boolean;
}

/**
 * FPL status codes. Taken from the API, mapped to a state and a probability.
 *   a = available, d = doubtful, i = injured, s = suspended, u = unavailable, n = not in squad
 */
const STATE_BY_STATUS: Record<string, AvailabilityState> = {
  a: 'available',
  d: 'doubtful',
  i: 'injured',
  s: 'suspended',
  u: 'unavailable',
  n: 'unavailable',
};

const STATUS_DESCRIPTION: Record<AvailabilityState, string> = {
  available: 'available',
  doubtful: 'a doubt',
  injured: 'injured',
  suspended: 'suspended',
  unavailable: 'unavailable',
};

/**
 * Classify a player's availability and derive the probability their xPts is weighted by.
 *
 * Two rules matter most, and both come straight from the spec:
 *  - A doubtful player is weighted by the chance the API states: 50% doubtful is half-weighted.
 *  - A player who cannot play is *excluded*, not merely down-weighted. Zero probability would
 *    already zero their xPts, but exclusion is an explicit hard gate so a rounding error or a
 *    tweaked weight can never let an unavailable player back into a recommendation.
 */
export function classifyAvailability(
  input: AvailabilityInput,
  weights: ModelWeights,
): Availability {
  const status = (input.status ?? '').toLowerCase();
  const known = Object.hasOwn(STATE_BY_STATUS, status);
  const state: AvailabilityState = known ? STATE_BY_STATUS[status]! : 'doubtful';

  const chance = input.chanceOfPlayingNextRound ?? input.chanceOfPlayingThisRound ?? null;

  let probability: number;
  let reason: string;

  if (!known) {
    // An unrecognised status is treated cautiously rather than optimistically: a new code we
    // have never seen must not be assumed to mean "fine".
    probability = weights.availability.unknownStatusProbability;
    reason = `Unrecognised availability status '${input.status ?? 'none'}' - treated as a doubt`;
  } else if (weights.availability.chanceOfPlayingOverridesStatus && chance !== null) {
    probability = clamp01(chance / 100);
    reason =
      chance >= 100
        ? 'Fully available'
        : `${chance}% chance of playing${input.news ? ` (${input.news})` : ''}`;
  } else {
    probability = weights.availability.statusProbability[status] ?? 0;
    reason = input.news
      ? `${capitalise(STATUS_DESCRIPTION[state])}: ${input.news}`
      : capitalise(STATUS_DESCRIPTION[state]);
  }

  // A stated chance of 0 means out, whatever the status code says.
  const effectiveState: AvailabilityState =
    probability <= 0 && state === 'available' ? 'unavailable' : state;

  return {
    state: effectiveState,
    probability,
    reason,
    excluded: probability <= 0,
  };
}

/** Bucket a probability into the labels the spec asks for: 25/50/75%. */
export function availabilityLabel(availability: Availability): string {
  if (availability.state === 'available') return 'Available';
  if (availability.state !== 'doubtful') return capitalise(STATUS_DESCRIPTION[availability.state]);
  const percent = Math.round(availability.probability * 100);
  return `Doubtful (${percent}%)`;
}

/** True when availability got worse, used to flag a squad player since the last check. */
export function hasWorsened(before: Availability, after: Availability): boolean {
  return after.probability < before.probability;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
