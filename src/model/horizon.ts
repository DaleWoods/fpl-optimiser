import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import { buildProjections } from './build.js';

/**
 * Multi-gameweek fixture horizon for transfers and captaincy.
 *
 * A transfer keeps paying off for as long as the player is held, not just for the gameweek
 * being planned for - a mediocre week followed by three good ones is worth more than the
 * reverse, and a hit only makes sense once you weigh the whole run of fixtures against its
 * one-time cost. Captaincy is more trustworthy when the pick is not a one-off spike. Both need
 * a lens across several gameweeks, weighted most heavily toward the near term since a
 * projection three gameweeks out is far less certain than next week's.
 *
 * The target gameweek's own number, wherever it is used elsewhere in the app, is the full model
 * output - curated notes, elite ownership, everything. The gameweeks after it, computed here,
 * are the base model only: they exist to bound a nudge on top of that primary projection, not
 * to replace it, so re-running every curated adjustment for weeks that have not happened yet
 * is not worth the cost.
 */

export interface HorizonGameweek {
  eventId: number;
  name: string | null;
  /** 1.0 for the target gameweek, decaying for each one further out. */
  weight: number;
  /** Fixtures imported for this gameweek. Zero reads as a blank, same as everywhere else - but
   *  it may just mean the fixture list has not been imported that far ahead yet. */
  fixtureCount: number;
  /** Clubs playing twice (or more) this gameweek - what makes a Bench Boost gameweek strong. */
  doubleClubCount: number;
}

export interface HorizonPlayer {
  playerId: number;
  /** The target gameweek's own projection, unweighted - the same number used everywhere else. */
  currentXPts: number;
  /** Decayed sum across every gameweek in the horizon, including the target week. */
  horizonXPts: number;
  /** horizonXPts with the target week's own contribution removed: the discounted value of the
   *  run of fixtures that comes after it. Zero when the horizon is a single gameweek. */
  futureXPts: number;
}

export interface Horizon {
  gameweeks: HorizonGameweek[];
  /** Sum of every gameweek's weight - divide a horizonXPts by this for a per-gameweek average. */
  totalWeight: number;
  players: Map<number, HorizonPlayer>;
}

/** Score every player across a run of upcoming gameweeks, starting from the target one. */
export function computeHorizon(
  db: Database,
  rules: Rules,
  weights: ModelWeights,
  targetEventId: number,
  length: number,
): Horizon {
  const decay = weights.horizon.decay;
  const events = db
    .prepare(`SELECT id, name FROM event WHERE id >= ? ORDER BY id ASC LIMIT ?`)
    .all(targetEventId, Math.max(1, length)) as { id: number; name: string | null }[];

  const gameweeks: HorizonGameweek[] = events.map((event, index) => {
    const fixtureCount = (
      db.prepare('SELECT COUNT(*) AS n FROM fixture WHERE event_id = ?').get(event.id) as {
        n: number;
      }
    ).n;
    const clubAppearances = db
      .prepare(
        `SELECT team_h AS club FROM fixture WHERE event_id = ?
         UNION ALL
         SELECT team_a AS club FROM fixture WHERE event_id = ?`,
      )
      .all(event.id, event.id) as { club: number }[];
    const counts = new Map<number, number>();
    for (const row of clubAppearances) counts.set(row.club, (counts.get(row.club) ?? 0) + 1);
    const doubleClubCount = [...counts.values()].filter((count) => count >= 2).length;

    return {
      eventId: event.id,
      name: event.name,
      weight: decay ** index,
      fixtureCount,
      doubleClubCount,
    };
  });
  const totalWeight = gameweeks.reduce((sum, gw) => sum + gw.weight, 0) || 1;

  const players = new Map<number, HorizonPlayer>();
  for (const gw of gameweeks) {
    const projections = buildProjections(db, gw.eventId, rules, weights);
    for (const player of projections) {
      const entry = players.get(player.playerId) ?? {
        playerId: player.playerId,
        currentXPts: 0,
        horizonXPts: 0,
        futureXPts: 0,
      };
      if (gw.eventId === targetEventId) entry.currentXPts = player.xPts;
      entry.horizonXPts += player.xPts * gw.weight;
      players.set(player.playerId, entry);
    }
  }

  for (const entry of players.values()) {
    entry.horizonXPts = round(entry.horizonXPts);
    entry.futureXPts = round(entry.horizonXPts - entry.currentXPts);
  }

  return { gameweeks, totalWeight, players };
}

/** A player missing from the horizon (no snapshot data at all) is worth nothing anywhere. */
export function horizonFor(horizon: Horizon, playerId: number): HorizonPlayer {
  return (
    horizon.players.get(playerId) ?? { playerId, currentXPts: 0, horizonXPts: 0, futureXPts: 0 }
  );
}

/** The double gameweek within the horizon that would give the strongest bench-boost pull. */
export function bestBenchBoostGameweek(horizon: Horizon): HorizonGameweek | null {
  let best: HorizonGameweek | null = null;
  for (const gw of horizon.gameweeks) {
    if (gw.doubleClubCount === 0) continue;
    if (!best || gw.weight > best.weight) best = gw;
  }
  return best;
}

/**
 * How much to trust the bench when building a squad, on top of the ordinary bench discount.
 *
 * A bench place is normally worth little because it only scores through auto-subs - but a
 * squad built (or rebuilt on a wildcard) without any regard for an approaching double gameweek
 * would happily neglect its bench right up until the week it would have been worth boosting.
 * This is a small, bounded relief toward the best double gameweek in the horizon, weighted by
 * how far out it is - never enough to make the bench as valuable as starters, only enough that
 * a squad naturally keeps a usable bench heading into one.
 */
export function benchBoostPull(horizon: Horizon, weights: ModelWeights): number {
  const gw = bestBenchBoostGameweek(horizon);
  return gw ? weights.horizon.benchBoostRelief * gw.weight : 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
