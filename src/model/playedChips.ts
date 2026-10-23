import type { Database } from 'better-sqlite3';
import { nowSeconds } from '../db/index.js';

/**
 * Chips you have told the app you played, for a gameweek it cannot see yet.
 *
 * Chip usage reaches this app only through the entry-history endpoint, and that endpoint - like
 * picks - says nothing about a gameweek that has not started. So for the whole week between
 * playing a Wildcard and the deadline passing, the chips page carries on recommending the chip
 * you have already spent. Telling you to do a thing you have done is worse than saying nothing:
 * it reads as a second opinion rather than a stale one.
 *
 * An overlay on what the API reports, never a replacement, for the same reason confirmed
 * transfers are. The API is always the truth about a gameweek it can see.
 */

export interface PlayedChip {
  chip: string;
  eventId: number;
}

/** Record that a chip was played. Re-noting the same one is harmless. */
export function notePlayedChip(db: Database, entryId: number, eventId: number, chip: string): void {
  db.prepare(
    `INSERT INTO played_chip (entry_id, event_id, chip, noted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (entry_id, event_id, chip) DO UPDATE SET noted_at = excluded.noted_at`,
  ).run(entryId, eventId, chip, nowSeconds());
}

/** Un-note one: you said you played it and you had not, or you changed your mind. */
export function unnotePlayedChip(db: Database, entryId: number, eventId: number, chip: string): void {
  db.prepare('DELETE FROM played_chip WHERE entry_id = ? AND event_id = ? AND chip = ?').run(
    entryId,
    eventId,
    chip,
  );
}

/** Everything noted for this entry. */
export function loadPlayedChips(db: Database, entryId: number | null): PlayedChip[] {
  if (entryId === null) return [];
  return db
    .prepare(
      'SELECT chip, event_id AS eventId FROM played_chip WHERE entry_id = ? ORDER BY event_id',
    )
    .all(entryId) as PlayedChip[];
}

/**
 * What the API knows plus what you have told us, with the API winning any disagreement.
 *
 * Matched on the chip name rather than the pair, because a chip the API has already reported is
 * the same chip however it got recorded - keeping both would show one play as two and could
 * retire a whole set of chips a season early.
 */
export function mergeChipsUsed(
  fromApi: readonly { name: string; event: number | null }[],
  noted: readonly PlayedChip[],
): { name: string; event: number | null }[] {
  const known = new Set(fromApi.map((chip) => chip.name));
  return [
    ...fromApi,
    ...noted.filter((chip) => !known.has(chip.chip)).map((chip) => ({ name: chip.chip, event: chip.eventId })),
  ];
}
