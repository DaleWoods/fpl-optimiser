import type { Database } from 'better-sqlite3';
import type { ProjectedPlayer } from '../domain/types.js';
import { nowSeconds } from '../db/index.js';

/**
 * Transfers you have confirmed making, for a gameweek the API cannot show yet.
 *
 * The public API returns your picks only for a gameweek that has already started. From the
 * moment one gameweek ends until the next kicks off - which is most of the week, and all of the
 * time anyone spends planning - the app is looking at last week's team. Every piece of advice in
 * that window silently assumes you still own players you may have sold days ago, and there is no
 * way for it to find out.
 *
 * Ticking a suggested transfer closes that gap. It is an overlay on the last real squad, never a
 * replacement for it: the API is always the truth about a gameweek it can see, and these rows
 * simply stop applying once it can.
 */

export interface ConfirmedTransfer {
  eventId: number;
  outPlayerId: number;
  inPlayerId: number;
}

/** Record that a transfer was actually made. Re-confirming the same one is harmless. */
export function confirmTransfer(
  db: Database,
  entryId: number,
  eventId: number,
  outPlayerId: number,
  inPlayerId: number,
): void {
  db.prepare(
    `INSERT INTO confirmed_transfer (entry_id, event_id, out_player_id, in_player_id, noted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (entry_id, event_id, out_player_id) DO UPDATE SET
       in_player_id = excluded.in_player_id, noted_at = excluded.noted_at`,
  ).run(entryId, eventId, outPlayerId, inPlayerId, nowSeconds());
}

/** Un-tick one: you said you made it and you had not, or you changed your mind. */
export function unconfirmTransfer(
  db: Database,
  entryId: number,
  eventId: number,
  outPlayerId: number,
): void {
  db.prepare(
    'DELETE FROM confirmed_transfer WHERE entry_id = ? AND event_id = ? AND out_player_id = ?',
  ).run(entryId, eventId, outPlayerId);
}

/** Everything confirmed for one gameweek, in the order it was ticked. */
export function loadConfirmedTransfers(
  db: Database,
  entryId: number | null,
  eventId: number,
): ConfirmedTransfer[] {
  if (entryId === null) return [];
  return db
    .prepare(
      `SELECT event_id AS eventId, out_player_id AS outPlayerId, in_player_id AS inPlayerId
       FROM confirmed_transfer WHERE entry_id = ? AND event_id = ? ORDER BY noted_at`,
    )
    .all(entryId, eventId) as ConfirmedTransfer[];
}

/**
 * Apply confirmed transfers to a squad, returning the ones that actually changed anything.
 *
 * Idempotent by construction: a swap is applied only when the outgoing player is still in the
 * squad and the incoming one is not. That is what makes it safe to leave the rows in place after
 * the API catches up - by then the squad already reflects the move, so the swap no longer
 * matches and is skipped rather than applied twice.
 */
export function applyConfirmedTransfers(
  squad: readonly ProjectedPlayer[],
  confirmed: readonly ConfirmedTransfer[],
  byId: ReadonlyMap<number, ProjectedPlayer>,
): { squad: ProjectedPlayer[]; applied: ConfirmedTransfer[]; unresolved: ConfirmedTransfer[] } {
  let current = [...squad];
  const applied: ConfirmedTransfer[] = [];
  const unresolved: ConfirmedTransfer[] = [];

  for (const transfer of confirmed) {
    const holds = current.some((player) => player.playerId === transfer.outPlayerId);
    const already = current.some((player) => player.playerId === transfer.inPlayerId);
    if (!holds || already) continue; // Already reflected, or no longer relevant.

    const incoming = byId.get(transfer.inPlayerId);
    if (!incoming) {
      // The player is not in the latest data - a stale import, or an id that no longer exists.
      // Reported rather than silently dropped: a confirmed transfer that did nothing is exactly
      // the kind of thing that would leave advice quietly wrong.
      unresolved.push(transfer);
      continue;
    }

    current = current.map((player) =>
      player.playerId === transfer.outPlayerId ? incoming : player,
    );
    applied.push(transfer);
  }

  return { squad: current, applied, unresolved };
}
