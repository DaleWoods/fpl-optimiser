import type { Database } from 'better-sqlite3';
import type { FplApi } from '../api/client.js';
import { ApiError } from '../api/client.js';
import { nowSeconds } from '../db/index.js';
import { withIngestRun } from './run.js';

/**
 * The squads of specific managers worth watching - usually the one in your mini-league who keeps
 * winning.
 *
 * Kept deliberately separate from elite ownership, which samples the top of the overall league
 * and answers "what does the consensus own". This answers a sharper question: where does one
 * manager who is beating you differ from this model? A player he owns that the model also rates
 * is one you have simply missed. A player he owns that the model rates poorly is either his edge
 * or his luck - and conflating those two is exactly how you end up copying someone's variance.
 *
 * Picks are only public once a gameweek has started, the same API blind spot that applies to
 * your own squad, so this stores the most recent started gameweek and never guesses beyond it.
 */

export interface RivalIngestResult {
  tracked: number;
  stored: number;
  notes: string[];
  rowsWritten: number;
  fromCache: boolean;
}

export async function ingestRivals(
  db: Database,
  api: FplApi,
  entryIds: readonly number[],
  eventId: number,
): Promise<RivalIngestResult> {
  return withIngestRun(db, 'rivals', async () => {
    const notes: string[] = [];
    const at = nowSeconds();
    let stored = 0;

    if (entryIds.length === 0) {
      return { tracked: 0, stored: 0, notes, rowsWritten: 0, fromCache: false };
    }

    const upsertEntry = db.prepare(
      `INSERT INTO rival_entry (entry_id, label, total_points, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (entry_id) DO UPDATE SET
         label = COALESCE(excluded.label, rival_entry.label),
         total_points = COALESCE(excluded.total_points, rival_entry.total_points),
         updated_at = excluded.updated_at`,
    );
    const insertPick = db.prepare(
      `INSERT INTO rival_pick (entry_id, event_id, player_id, slot, multiplier, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (entry_id, event_id, player_id) DO UPDATE SET
         slot = excluded.slot, multiplier = excluded.multiplier,
         captured_at = excluded.captured_at`,
    );
    // Players this app has never heard of would violate the foreign key and abort the whole
    // write. Skipping them costs one row; letting it throw costs every rival on the page.
    const known = new Set(
      (db.prepare('SELECT id FROM player').all() as { id: number }[]).map((row) => row.id),
    );

    for (const entryId of entryIds) {
      let label: string | null = null;
      let totalPoints: number | null = null;
      try {
        const entry = await api.entry(entryId);
        label =
          [entry.data.player_first_name, entry.data.player_last_name]
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join(' ') ||
          entry.data.name ||
          null;
        totalPoints = entry.data.summary_overall_points ?? null;
      } catch (cause) {
        notes.push(
          `Could not read manager ${entryId}: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        );
      }
      upsertEntry.run(entryId, label, totalPoints, at);

      try {
        const picks = await api.entryPicks(entryId, eventId);
        const write = db.transaction(() => {
          for (const pick of picks.data.picks) {
            if (!known.has(pick.element)) continue;
            insertPick.run(entryId, eventId, pick.element, pick.position, pick.multiplier, at);
            stored += 1;
          }
        });
        write();
      } catch (cause) {
        // A 404 here is the normal state before a gameweek kicks off, not a failure worth
        // shouting about - picks simply are not public yet.
        notes.push(
          cause instanceof ApiError && cause.notFound
            ? `Manager ${entryId}'s gameweek ${eventId} squad is not public yet - picks appear once the gameweek starts.`
            : `Could not read manager ${entryId}'s squad: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        );
      }
    }

    return { tracked: entryIds.length, stored, notes, rowsWritten: stored, fromCache: false };
  });
}
