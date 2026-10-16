import { existsSync, readdirSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from 'better-sqlite3';

/**
 * Keeping the database from eating its own disk.
 *
 * This app writes history on purpose - snapshots are how it detects a price change, and stored
 * projections are how it grades itself afterwards. Nothing ever deleted any of it, so both grew
 * without limit on a 1 GB disk and eventually SQLite started returning "disk I/O error", which
 * tells a reader nothing about what went wrong or what to do.
 *
 * Measured: one snapshot of 700 players costs about 0.94 MB, almost all of it `raw_json`, which
 * is a verbatim copy of fields already parsed into columns beside it. At the configured
 * three-hourly refresh that is ~7.5 MB a day, and a stored projection run adds ~650 more rows
 * with their own breakdown JSON every time a team is generated.
 *
 * So history is kept deliberately rather than indefinitely. What has to survive is the part
 * something actually reads:
 *
 *  - **The newest snapshots.** Change detection compares against the immediately previous one,
 *    and prices and injury flags come from the latest.
 *  - **The last snapshot before each gameweek deadline.** The Accuracy page's benchmark scores
 *    FPL's own `ep_next` against this model using what was knowable before kick-off; prune those
 *    and the comparison silently loses its baseline, which is a far worse outcome than a large
 *    file.
 *  - **The most recent projection per player per gameweek.** Grading and calibration both select
 *    `MAX(created_at)` anyway, so every earlier run for the same gameweek is already ignored.
 */

export interface TableUsage {
  table: string;
  rows: number;
  /** Approximate bytes, from the stored payload rather than page accounting. */
  approximateBytes: number;
}

export interface SpaceReport {
  databaseBytes: number;
  tables: TableUsage[];
}

const BIG_TABLES: { table: string; jsonColumns: string[] }[] = [
  { table: 'player_snapshot', jsonColumns: ['raw_json'] },
  { table: 'projection', jsonColumns: ['breakdown_json'] },
  { table: 'player_fixture_history', jsonColumns: ['raw_json'] },
  { table: 'player_season_history', jsonColumns: ['raw_json'] },
  { table: 'recommendation', jsonColumns: ['detail_json'] },
  { table: 'change_log', jsonColumns: [] },
  { table: 'ingest_run', jsonColumns: [] },
  { table: 'actual_points', jsonColumns: [] },
];

/** What the file is made of, so a full disk is a diagnosis rather than a mystery. */
export function spaceReport(db: Database): SpaceReport {
  const databaseBytes = (
    db
      .prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')
      .get() as { n: number }
  ).n;

  const tables: TableUsage[] = [];
  for (const { table, jsonColumns } of BIG_TABLES) {
    try {
      const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      // length() on the stored text is a far better guide to what a table costs than row count,
      // and it is what makes the JSON columns' dominance visible at all.
      const payload =
        jsonColumns.length > 0 && rows > 0
          ? (
              db
                .prepare(
                  `SELECT COALESCE(SUM(${jsonColumns.map((c) => `LENGTH(${c})`).join(' + ')}), 0) AS n FROM ${table}`,
                )
                .get() as { n: number }
            ).n
          : 0;
      tables.push({ table, rows, approximateBytes: payload });
    } catch {
      // A table a future migration has not created yet is not a reason to fail the report.
    }
  }

  tables.sort((a, b) => b.approximateBytes - a.approximateBytes || b.rows - a.rows);
  return { databaseBytes, tables };
}

export interface PruneOptions {
  /**
   * Snapshots to keep regardless of age. Must be at least 2: change detection compares the
   * newest against the one before it, and keeping only one would silently turn every refresh
   * into "nothing changed".
   */
  keepSnapshots?: number;
  /** Cleared before any database work. Omitted by the automatic post-refresh prune, which is
   *  not a recovery and should not throw away a warm cache. */
  cacheDir?: string;
}

/**
 * Delete the HTTP response cache from disk.
 *
 * Done before any database work, and this ordering is the whole point rather than tidiness. On
 * a genuinely full disk SQLite cannot delete a row either - a DELETE still has to write to its
 * journal first - so a recovery that starts with the database can fail with the same error it
 * is trying to clear. Unlinking plain files needs no free space at all, so this always works and
 * buys the room for everything after it.
 *
 * Safe by nature: every one of these files is a copy of something the FPL API will serve again.
 */
export function clearHttpCache(cacheDir: string): { filesDeleted: number; bytesFreed: number } {
  const dir = resolve(cacheDir);
  if (!existsSync(dir)) return { filesDeleted: 0, bytesFreed: 0 };

  let filesDeleted = 0;
  let bytesFreed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = resolve(dir, name);
    try {
      const size = statSync(path).size;
      unlinkSync(path);
      filesDeleted += 1;
      bytesFreed += size;
    } catch {
      // A file that vanished underneath us, or one we may not remove, is not worth failing for.
    }
  }
  return { filesDeleted, bytesFreed };
}

export interface PruneResult {
  snapshotsDeleted: number;
  projectionsDeleted: number;
  ingestRunsDeleted: number;
  bytesBefore: number;
  bytesAfter: number;
  /** VACUUM needs room for a second copy, so on a genuinely full disk it fails - and that is survivable. */
  reclaimed: boolean;
  note: string | null;
  cacheFilesDeleted: number;
  cacheBytesFreed: number;
}

export function pruneHistory(db: Database, options: PruneOptions = {}): PruneResult {
  const keepSnapshots = Math.max(2, options.keepSnapshots ?? 8);
  let note: string | null = null;
  const bytesBefore = spaceReport(db).databaseBytes;

  // First, because on a full disk the database cannot delete anything either.
  const cache = options.cacheDir
    ? clearHttpCache(options.cacheDir)
    : { filesDeleted: 0, bytesFreed: 0 };

  // Snapshots worth keeping, by id: the newest few, plus the last one before each gameweek
  // deadline. The second group is the Accuracy benchmark's baseline and is the one that would
  // be quietly destroyed by a naive "delete anything older than a week".
  const keepIds = new Set<number>();
  for (const row of db
    .prepare('SELECT id FROM snapshot ORDER BY taken_at DESC, id DESC LIMIT ?')
    .all(keepSnapshots) as { id: number }[]) {
    keepIds.add(row.id);
  }
  for (const row of db
    .prepare(
      `SELECT (
         SELECT id FROM snapshot
         WHERE taken_at <= e.deadline_time
         ORDER BY taken_at DESC, id DESC LIMIT 1
       ) AS id
       FROM event e WHERE e.deadline_time IS NOT NULL`,
    )
    .all() as { id: number | null }[]) {
    if (row.id !== null) keepIds.add(row.id);
  }

  const snapshotIds = (db.prepare('SELECT id FROM snapshot').all() as { id: number }[]).map(
    (row) => row.id,
  );
  const doomed = snapshotIds.filter((id) => !keepIds.has(id));

  let snapshotsDeleted = 0;
  let projectionsDeleted = 0;
  let ingestRunsDeleted = 0;

  // Reclaim the column that caused all this on the snapshots being kept, not just the ones
  // being deleted. Cheap relative to what it frees, and it means an existing database shrinks
  // rather than merely stopping its growth.
  const blankRawJson = () =>
    db.prepare("UPDATE player_snapshot SET raw_json = '' WHERE raw_json != ''").run().changes;

  const work = db.transaction(() => {
    // Chunked: SQLite has a hard limit on how many parameters one statement may carry, and a
    // season's worth of snapshots goes past it.
    for (let i = 0; i < doomed.length; i += 400) {
      const batch = doomed.slice(i, i + 400);
      const placeholders = batch.map(() => '?').join(',');
      db.prepare(`DELETE FROM player_snapshot WHERE snapshot_id IN (${placeholders})`).run(...batch);
      snapshotsDeleted += db
        .prepare(`DELETE FROM snapshot WHERE id IN (${placeholders})`)
        .run(...batch).changes;
    }

    // Every superseded projection run. Grading and calibration both already select only the
    // newest per player per gameweek, so these rows are read by nothing.
    projectionsDeleted = db.prepare(
      `DELETE FROM projection WHERE rowid NOT IN (
         SELECT rowid FROM projection p
         WHERE p.created_at = (
           SELECT MAX(created_at) FROM projection
           WHERE player_id = p.player_id AND event_id = p.event_id
             AND model_version = p.model_version
         )
       )`,
    ).run().changes;

    // Ingest bookkeeping: useful for "when did this last work", worthless a thousand runs back.
    ingestRunsDeleted = db.prepare(
      'DELETE FROM ingest_run WHERE id NOT IN (SELECT id FROM ingest_run ORDER BY id DESC LIMIT 200)',
    ).run().changes;

    blankRawJson();
  });

  try {
    work();
  } catch (cause) {
    // The bind this is written for. On a genuinely full volume SQLite cannot delete a row
    // either: a DELETE writes its undo journal first, and there is nowhere to put it. So the
    // one operation that would free space is the one the lack of space forbids, and the app
    // stays dead until somebody resizes the disk by hand.
    //
    // Journalling to memory removes that requirement. It is a real trade - a crash midway
    // through leaves the database inconsistent, which is exactly why it is not how this
    // normally runs - but it is only reached once an ordinary prune has already failed for
    // want of space, and the alternative at that point is an application that cannot start.
    if (!isDiskSpaceFailure(cause)) throw cause;

    const previous = db.pragma('journal_mode', { simple: true });
    try {
      db.pragma('journal_mode = MEMORY');
      work();
      note =
        'The disk was too full to delete anything the usual way, so this ran without an undo ' +
        'journal. It worked, but the volume is genuinely out of room - give it more space.';
    } finally {
      try {
        db.pragma(`journal_mode = ${String(previous)}`);
      } catch {
        // Restoring the old mode needs a write too. Leaving it is survivable; the next start
        // sets it again, and failing here would throw away a prune that just succeeded.
      }
    }
  }

  // Deleting rows already frees pages inside the file for reuse, which is what actually unblocks
  // writing again. VACUUM only shrinks the file on disk, and it needs room for a second copy to
  // do it - so on the full disk that caused all this, it is expected to fail and must not be
  // allowed to turn a successful prune into an error.
  let reclaimed = false;
  try {
    db.exec('VACUUM');
    reclaimed = true;
  } catch (cause) {
    note ??=
      `Rows were deleted and that space is free for the database to reuse, but the file could ` +
      `not be shrunk on disk (${cause instanceof Error ? cause.message : 'unknown error'}). ` +
      `That needs room for a temporary second copy. Importing should work again regardless.`;
  }

  return {
    snapshotsDeleted,
    projectionsDeleted,
    ingestRunsDeleted,
    bytesBefore,
    bytesAfter: spaceReport(db).databaseBytes,
    reclaimed,
    note,
    cacheFilesDeleted: cache.filesDeleted,
    cacheBytesFreed: cache.bytesFreed,
  };
}

/**
 * How much room is left on the volume holding a given path.
 *
 * Checked at boot so a filling disk is a warning while it is still fixable, rather than a crash
 * loop once it is not. `statfs` is not available on every platform or filesystem, and a missing
 * answer is not an emergency - it simply means this particular check has nothing to say.
 */
export function freeDiskBytes(path: string): number | null {
  try {
    // Statically imported, not required. This was a `require('node:fs')` inside an ES module,
    // where `require` is not defined at all - so it threw on every call, the catch below
    // swallowed it, and the function returned null for ever. Silently: the one caller treats
    // null as "cannot tell" and skips, so the boot-time prune this exists to trigger never ran
    // a single time while the disk filled.
    if (typeof statfsSync !== 'function') return null;
    const stats = statfsSync(resolve(path));
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * What to do when opening the database failed.
 *
 * Separated from the opening itself because it is a policy decision with real consequences -
 * throwing away a warm cache - and because a full disk cannot be conjured up in a test while
 * this can be exercised directly.
 */
export function planDiskRecovery(
  cause: unknown,
  freeSpaceDir: string | undefined,
  clear: (dir: string) => { filesDeleted: number; bytesFreed: number } = clearHttpCache,
): { retry: boolean; message: string | null } {
  // Only a space failure justifies deleting anything. Any other fault - a missing file, a
  // corrupt header, a path that is really a directory - is made no better by it, and a bad day
  // should not also cost a warm cache and a few hundred needless API calls.
  if (!isDiskSpaceFailure(cause) || !freeSpaceDir) return { retry: false, message: null };

  const freed = clear(freeSpaceDir);
  if (freed.filesDeleted === 0) {
    return {
      retry: false,
      message:
        'The disk is full and there was no cached data left to delete. Free space on the volume ' +
        'itself, or give it more room, before this can start.',
    };
  }

  return {
    retry: true,
    message:
      `Could not open the database because the disk is full. Deleted ${freed.filesDeleted} ` +
      `cached file(s) (${(freed.bytesFreed / 1024 / 1024).toFixed(1)} MB) and retrying.`,
  };
}

/**
 * Whether a failure was the disk rather than the code.
 *
 * SQLite reports a full or unwritable disk as "disk I/O error", which reads like a hardware
 * fault and sends you looking in the wrong place entirely.
 */
export function isDiskSpaceFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  return (
    message.includes('disk i/o error') ||
    message.includes('database or disk is full') ||
    message.includes('sqlite_full') ||
    message.includes('sqlite_ioerr') ||
    message.includes('enospc') ||
    message.includes('no space left')
  );
}
