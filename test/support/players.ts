import { classifyAvailability } from '../../src/domain/availability.js';
import { loadModelWeights } from '../../src/config/load.js';
import type { ProjectedPlayer } from '../../src/domain/types.js';

const weights = loadModelWeights();

let nextId = 1;

export interface PlayerOverrides {
  playerId?: number;
  name?: string;
  position?: string;
  clubId?: number;
  price?: number;
  xPts?: number;
  status?: string;
  chance?: number | null;
  confidence?: 'high' | 'medium' | 'low';
}

/** Build a projected player for optimiser and rules tests. */
export function player(overrides: PlayerOverrides = {}): ProjectedPlayer {
  const id = overrides.playerId ?? nextId++;
  const availability = classifyAvailability(
    {
      status: overrides.status ?? 'a',
      chanceOfPlayingNextRound: overrides.chance ?? null,
      news: null,
    },
    weights,
  );

  const xPts = overrides.xPts ?? 4;
  return {
    playerId: id,
    name: overrides.name ?? `Player ${id}`,
    clubId: overrides.clubId ?? 1,
    clubShort: `C${overrides.clubId ?? 1}`,
    position: overrides.position ?? 'MID',
    price: overrides.price ?? 50,
    availability,
    xPts,
    xPtsRaw: xPts,
    breakdown: {},
    expectedMinutes: 80,
    confidence: overrides.confidence ?? 'high',
    reasons: [],
  };
}

/**
 * A legal 15: 2 GKP, 5 DEF, 5 MID, 3 FWD, spread across enough clubs to satisfy the
 * max-three-per-club rule.
 */
export function legalSquad(overrides: (index: number) => PlayerOverrides = () => ({})): ProjectedPlayer[] {
  const shape: Array<[string, number]> = [
    ['GKP', 2],
    ['DEF', 5],
    ['MID', 5],
    ['FWD', 3],
  ];
  const squad: ProjectedPlayer[] = [];
  let index = 0;
  for (const [position, count] of shape) {
    for (let n = 0; n < count; n += 1) {
      squad.push(
        player({
          playerId: index + 1,
          position,
          // Five clubs, three players each: exactly at the club limit, never over.
          clubId: Math.floor(index / 3) + 1,
          price: 45,
          xPts: 4,
          ...overrides(index),
        }),
      );
      index += 1;
    }
  }
  return squad;
}

/** A pool large enough for full-squad optimisation. */
export function playerPool(options: { clubs?: number; perPosition?: number } = {}): ProjectedPlayer[] {
  const clubs = options.clubs ?? 10;
  const perPosition = options.perPosition ?? 3;
  const pool: ProjectedPlayer[] = [];
  let id = 1;

  for (let club = 1; club <= clubs; club += 1) {
    for (const [position, basePrice] of [
      ['GKP', 40],
      ['DEF', 40],
      ['MID', 45],
      ['FWD', 45],
    ] as const) {
      for (let n = 0; n < perPosition; n += 1) {
        pool.push(
          player({
            playerId: id,
            name: `${position}${id}`,
            position,
            clubId: club,
            price: basePrice + n * 10,
            // Pricier players are better, so the budget constraint genuinely bites.
            xPts: 2 + n * 1.5 + (club % 3) * 0.25,
          }),
        );
        id += 1;
      }
    }
  }
  return pool;
}
