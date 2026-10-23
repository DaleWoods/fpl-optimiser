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
  /**
   * xPts before the model's own measured-error correction was applied, and the factor that was
   * applied. Both absent when no correction applied - "we have not measured this yet" and "we
   * measured it and it was fine" look the same once applied but are different claims, and only
   * the uncorrected figure is safe to measure the next correction against.
   */
  xPtsUncalibrated?: number;
  calibrationFactor?: number;
  /**
   * The shape of the score, not just its mean: a 90th-percentile good week and the chance of a
   * haul. Used for captaincy and Triple Captain timing, where doubling or trebling one pick
   * makes the distribution matter - never for xPts itself, which stays the thing the Accuracy
   * page grades. Absent for a blank gameweek or a player with no modelled distribution.
   */
  ceiling?: number;
  haulProbability?: number;
  /**
   * Set-piece duty as the club publishes it: 1 is first choice, absent means not on the list.
   *
   * Carried for explanation and comparison, not as a scoring term. A player's expected goals
   * already contain the penalties he has taken, so adding an uplift on top of them would be
   * counting the same thing twice for every settled taker - the large majority. What history
   * cannot describe is the taker who was appointed last week, and separating that case from
   * the rest needs a measurement this app does not have yet.
   */
  setPieces?: { penalties: number | null; freekicks: number | null; corners: number | null };
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
