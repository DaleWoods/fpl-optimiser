import type { Database } from 'better-sqlite3';
import { ApiError, type FplApi } from '../api/client.js';
import { nowSeconds } from '../db/index.js';
import { withIngestRun } from './run.js';

/** League 314 is FPL's "Overall" league - every manager in the game. */
export const OVERALL_LEAGUE_ID = 314;

export interface EliteIngestResult {
  sampleId: number | null;
  rowsWritten: number;
  fromCache: boolean;
  fetchedAt: number;
  managersSampled: number;
  playersSeen: number;
  notes: string[];
}

export interface EliteIngestOptions {
  leagueId?: number;
  eventId: number;
  /** How many top managers to sample. Each costs one request, so keep it modest. */
  managers?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Sample what the highest-ranked managers in the game actually own.
 *
 * Overall ownership counts a casual manager's pick the same as a top-1k manager's. The top of
 * the overall league is a far better signal of what people who consistently do well rate, and
 * it is all public.
 *
 * This can only work once a gameweek has been played: before the season's first deadline the
 * league has no standings and no squad is visible. That is reported, not treated as a failure.
 */
export async function ingestEliteOwnership(
  db: Database,
  api: FplApi,
  options: EliteIngestOptions,
): Promise<EliteIngestResult> {
  return withIngestRun(db, 'elite-ownership', async () => {
    const leagueId = options.leagueId ?? OVERALL_LEAGUE_ID;
    const wanted = options.managers ?? 50;
    const notes: string[] = [];

    let standings;
    try {
      standings = await api.leagueStandings(leagueId, 1);
    } catch (cause) {
      if (cause instanceof ApiError && cause.notFound) {
        return {
          sampleId: null,
          rowsWritten: 0,
          fromCache: false,
          fetchedAt: nowSeconds(),
          managersSampled: 0,
          playersSeen: 0,
          notes: [
            `League ${leagueId} has no standings yet. Before the first gameweek is played ` +
              'there is no ranking to sample, so elite ownership is unavailable.',
          ],
        };
      }
      throw cause;
    }

    const entries = standings.data.standings.results.slice(0, wanted);
    if (entries.length === 0) {
      return {
        sampleId: null,
        rowsWritten: 0,
        fromCache: standings.fromCache,
        fetchedAt: standings.fetchedAt,
        managersSampled: 0,
        playersSeen: 0,
        notes: [`League ${leagueId} returned no managers - the season has probably not started.`],
      };
    }

    const knownPlayers = new Set(
      (db.prepare('SELECT id FROM player').all() as { id: number }[]).map((row) => row.id),
    );

    const owned = new Map<number, { owned: number; started: number; captained: number }>();
    let sampled = 0;
    let failures = 0;

    for (const [index, entry] of entries.entries()) {
      try {
        const picks = await api.entryPicks(entry.entry, options.eventId);
        sampled += 1;
        for (const pick of picks.data.picks) {
          if (!knownPlayers.has(pick.element)) continue;
          const record = owned.get(pick.element) ?? { owned: 0, started: 0, captained: 0 };
          record.owned += 1;
          if (pick.position <= 11) record.started += 1;
          if (pick.is_captain) record.captained += 1;
          owned.set(pick.element, record);
        }
      } catch {
        // One manager's squad being unreadable must not cost us the rest of the sample.
        failures += 1;
      }
      options.onProgress?.(index + 1, entries.length);
    }

    if (failures > 0) {
      notes.push(`${failures} of ${entries.length} sampled managers could not be read.`);
    }

    if (sampled === 0) {
      return {
        sampleId: null,
        rowsWritten: 0,
        fromCache: standings.fromCache,
        fetchedAt: standings.fetchedAt,
        managersSampled: 0,
        playersSeen: 0,
        notes: [
          ...notes,
          `No squads could be read for gameweek ${options.eventId}. Squads only become ` +
            'visible once that gameweek has started.',
        ],
      };
    }

    const insertSample = db.prepare(
      'INSERT INTO elite_sample (captured_at, event_id, league_id, managers, note) VALUES (?, ?, ?, ?, ?)',
    );
    const insertOwnership = db.prepare(
      `INSERT INTO elite_ownership (sample_id, player_id, owned_by, started_by, captained_by, ownership)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const write = db.transaction((): number => {
      const info = insertSample.run(
        nowSeconds(),
        options.eventId,
        leagueId,
        sampled,
        notes.join(' ') || null,
      );
      const sampleId = Number(info.lastInsertRowid);
      for (const [playerId, record] of owned) {
        insertOwnership.run(
          sampleId,
          playerId,
          record.owned,
          record.started,
          record.captained,
          record.owned / sampled,
        );
      }
      return sampleId;
    });

    const sampleId = write();

    return {
      sampleId,
      rowsWritten: owned.size,
      fromCache: standings.fromCache,
      fetchedAt: standings.fetchedAt,
      managersSampled: sampled,
      playersSeen: owned.size,
      notes,
    };
  });
}

export interface EliteOwnershipRow {
  playerId: number;
  ownership: number;
  startedBy: number;
  captainedBy: number;
  managers: number;
}

/** The most recent elite sample, as a lookup by player. */
export function latestEliteOwnership(db: Database): Map<number, EliteOwnershipRow> {
  const sample = db
    .prepare('SELECT id, managers FROM elite_sample ORDER BY captured_at DESC, id DESC LIMIT 1')
    .get() as { id: number; managers: number } | undefined;

  if (!sample) return new Map();

  const rows = db
    .prepare(
      `SELECT player_id AS playerId, ownership, started_by AS startedBy, captained_by AS captainedBy
       FROM elite_ownership WHERE sample_id = ?`,
    )
    .all(sample.id) as Omit<EliteOwnershipRow, 'managers'>[];

  return new Map(rows.map((row) => [row.playerId, { ...row, managers: sample.managers }]));
}
