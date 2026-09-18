import type { Database } from 'better-sqlite3';
import type { ProjectedPlayer } from '../domain/types.js';

/**
 * What a rival owns that you do not - sorted by what this model thinks of them.
 *
 * The instruction this is built around is "don't just copy other people unless it's the right
 * thing to do", and a list of a winning manager's players cannot honour that on its own: copied
 * wholesale it is cargo-culting, ignored entirely it wastes the one signal you have about
 * someone who is beating you.
 *
 * So the output is not his squad. It is the *disagreement* between his squad and this model,
 * split three ways:
 *
 *  - **Missed** - he owns them, the model rates them highly, you do not own them. The model
 *    already agrees; you simply have not acted. These are the only ones worth acting on quickly.
 *  - **His call** - he owns them, the model rates them poorly. Either he knows something the
 *    model does not, or he got lucky, and the two look identical for several weeks. Worth
 *    watching, never worth copying on sight.
 *  - **Yours** - you own them and he does not, with the model's rating, so the comparison runs
 *    both ways rather than only flattering him.
 */

export interface RivalPlayer {
  playerId: number;
  name: string;
  position: string;
  club: string;
  xPts: number;
  /** Their multiplier that gameweek: 0 benched, 1 played, 2 captained, 3 triple-captained. */
  multiplier: number;
}

export interface RivalComparison {
  entryId: number;
  label: string | null;
  totalPoints: number | null;
  eventId: number;
  /** He owns, model rates highly, you do not own. */
  missed: RivalPlayer[];
  /** He owns, model rates poorly. His judgement or his luck - not yet distinguishable. */
  hisCall: RivalPlayer[];
  /** You own, he does not. */
  yoursOnly: RivalPlayer[];
  /** Who he captained, if the picks say. */
  captain: RivalPlayer | null;
}

/**
 * Compare one rival's stored squad against yours.
 *
 * `threshold` splits "the model agrees with him" from "the model does not". Taken from the
 * projections themselves - the median of your own starting projections - rather than a fixed
 * number, because a good projection early in a season and a good one in April are not the same
 * size, and a hardcoded line would drift out of meaning.
 */
export function compareRival(
  db: Database,
  entryId: number,
  eventId: number,
  projections: readonly ProjectedPlayer[],
  ownedIds: ReadonlySet<number>,
): RivalComparison | null {
  const entry = db
    .prepare(
      'SELECT entry_id AS entryId, label, total_points AS totalPoints FROM rival_entry WHERE entry_id = ?',
    )
    .get(entryId) as { entryId: number; label: string | null; totalPoints: number | null } | undefined;

  const picks = db
    .prepare(
      `SELECT player_id AS playerId, multiplier FROM rival_pick
       WHERE entry_id = ? AND event_id = ?`,
    )
    .all(entryId, eventId) as { playerId: number; multiplier: number }[];

  if (picks.length === 0) return null;

  const byId = new Map(projections.map((player) => [player.playerId, player]));
  const describe = (playerId: number, multiplier: number): RivalPlayer | null => {
    const player = byId.get(playerId);
    if (!player) return null;
    return {
      playerId,
      name: player.name,
      position: player.position,
      club: player.clubShort,
      xPts: Math.round(player.xPts * 100) / 100,
      multiplier,
    };
  };

  // The line between "the model rates him" and "it does not", taken from your own XI so it
  // moves with the season rather than being a number frozen in a config file.
  const ownedProjections = projections
    .filter((player) => ownedIds.has(player.playerId))
    .map((player) => player.xPts)
    .sort((a, b) => b - a);
  const threshold =
    ownedProjections.length > 0
      ? ownedProjections[Math.min(ownedProjections.length - 1, 7)]!
      : 0;

  const his = picks
    .map((pick) => describe(pick.playerId, pick.multiplier))
    .filter((player): player is RivalPlayer => player !== null);
  const hisIds = new Set(his.map((player) => player.playerId));

  const byXptsDesc = (a: RivalPlayer, b: RivalPlayer) => b.xPts - a.xPts;

  return {
    entryId,
    label: entry?.label ?? null,
    totalPoints: entry?.totalPoints ?? null,
    eventId,
    missed: his
      .filter((player) => !ownedIds.has(player.playerId) && player.xPts >= threshold)
      .sort(byXptsDesc),
    hisCall: his
      .filter((player) => !ownedIds.has(player.playerId) && player.xPts < threshold)
      .sort(byXptsDesc),
    yoursOnly: projections
      .filter((player) => ownedIds.has(player.playerId) && !hisIds.has(player.playerId))
      .map((player) => describe(player.playerId, 1))
      .filter((player): player is RivalPlayer => player !== null)
      .sort(byXptsDesc),
    // multiplier 2 is the armband, 3 is Triple Captain.
    captain: his.find((player) => player.multiplier >= 2) ?? null,
  };
}

/** Every rival with a stored squad for this gameweek. */
export function compareRivals(
  db: Database,
  eventId: number,
  projections: readonly ProjectedPlayer[],
  ownedIds: ReadonlySet<number>,
): RivalComparison[] {
  const ids = (
    db
      .prepare('SELECT DISTINCT entry_id AS entryId FROM rival_pick WHERE event_id = ?')
      .all(eventId) as { entryId: number }[]
  ).map((row) => row.entryId);

  return ids
    .map((entryId) => compareRival(db, entryId, eventId, projections, ownedIds))
    .filter((entry): entry is RivalComparison => entry !== null);
}
