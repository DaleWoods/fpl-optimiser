import type { Availability } from './availability.js';

/** A player as the rules engine and optimiser see them. */
export interface PlayerCandidate {
  playerId: number;
  name: string;
  clubId: number;
  clubShort: string;
  /** FPL element_type short code, taken from the API. Never hardcoded. */
  position: string;
  /** Tenths of a million. */
  price: number;
  availability: Availability;
}

/** A candidate with a projection attached. */
export interface ProjectedPlayer extends PlayerCandidate {
  xPts: number;
  /** Before availability weighting, for explanation. */
  xPtsRaw: number;
  breakdown: Record<string, number>;
  expectedMinutes: number;
  confidence: 'high' | 'medium' | 'low';
  /** Plain-English justification for this projection, shown alongside any recommendation. */
  reasons: string[];
}

export interface Squad {
  players: ProjectedPlayer[];
  /** Tenths of a million left over. */
  bank: number;
}

export interface StartingEleven {
  starters: ProjectedPlayer[];
  bench: ProjectedPlayer[];
  captain: ProjectedPlayer;
  viceCaptain: ProjectedPlayer;
  formation: string;
  /** Total xPts including the captain's doubled score. */
  expectedPoints: number;
}
