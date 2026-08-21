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

/** One fixture a player's club has this gameweek, for display - not itself a model output. */
export interface FixtureSummary {
  opponentShort: string;
  isHome: boolean;
  /** The API's own fixture difficulty rating, carried through for display only. */
  difficulty: number | null;
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
  /** This gameweek's fixture(s) for the player's club: empty for a blank, two for a double. */
  fixtures: FixtureSummary[];
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
