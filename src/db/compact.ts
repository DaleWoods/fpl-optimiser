import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { freeDiskBytes, pruneHistory } from './maintenance.js';
import { migrate } from './migrate.js';

/**
 * Shrink a database file that has filled its own volume.
 *
 * Pruning deletes rows and frees pages *inside* the file, which is enough to let the app write
 * again - but the file on disk stays the size it grew to. Normally `VACUUM` fixes that, and
 * normally that is fine. It is not fine here: `VACUUM` builds a second copy beside the original
 * before replacing it, so it needs roughly twice the file size free. A 1 GB database that has
 * filled a 1 GB volume can therefore never be vacuumed, and the volume never comes back. The
 * app runs, the disk stays full, and every restart prunes rows that were already deleted.
 *
 * The way out is that the second copy does not have to live on the same volume. `VACUUM INTO`
 * writes a complete, consistent database to any path, and after pruning that copy is tiny - a
 * full season's data is about 35 MB. So it is written to scratch space outside the volume, the
 * bloated original is removed, and the small copy is moved back.
 *
 * Deliberately careful about the order, because there is a moment when the only copy is the
 * scratch one: the copy is opened and integrity-checked *before* anything is deleted, and if any
 * of that fails the original is left exactly as it was. A full disk is recoverable; a database
 * destroyed while trying to recover one is not.
 */

export interface CompactResult {
  compacted: boolean;
  bytesBefore: number;
  bytesAfter: number;
  note: string;
}

/** Bytes of free space below which the volume is treated as unusable rather than merely tight. */
const STARVED_BYTES = 50 * 1024 * 1024;

export function compactIfStarved(
  databasePath: string,
  options: {
    cacheDir?: string;
    scratchDir?: string;
    onProgress?: (message: string) => void;
    /** Take the salvage route even when a whole-file copy would fit. */
    preferSalvage?: boolean;
    /**
     * Compact regardless of free space. Not used by the automatic path, which must only act on
     * a volume that is genuinely starved - but it is how this gets tested on a healthy disk,
     * and how someone reclaims space deliberately rather than waiting to run out.
     */
    force?: boolean;
  } = {},
): CompactResult {
  const report = options.onProgress ?? (() => {});
  const path = resolve(databasePath);

  if (!existsSync(path)) {
    return { compacted: false, bytesBefore: 0, bytesAfter: 0, note: 'No database file yet.' };
  }

  const free = freeDiskBytes(dirname(path));
  const bytesBefore = statSync(path).size;

  // Only ever on a volume that is genuinely out of room. This swaps the database file, and that
  // is not something to do on a hunch during an ordinary start-up.
  if (!options.force && (free === null || free >= STARVED_BYTES)) {
    return {
      compacted: false,
      bytesBefore,
      bytesAfter: bytesBefore,
      note:
        free === null
          ? 'Could not read free space, so nothing was changed.'
          : `${(free / 1024 / 1024).toFixed(0)} MB free - no need.`,
    };
  }

  report(
    free === null
      ? `Compacting a ${(bytesBefore / 1024 / 1024).toFixed(0)} MB database.`
      : `Only ${(free / 1024 / 1024).toFixed(0)} MB free and the database is ` +
          `${(bytesBefore / 1024 / 1024).toFixed(0)} MB. Compacting it.`,
  );

  // tmpdir() on a hosted container is ephemeral local disk, deliberately NOT the mounted volume
  // this is rescuing - which is the only reason there is anywhere to put the copy at all.
  const scratchDir = resolve(options.scratchDir ?? tmpdir());
  const rawPath = resolve(scratchDir, 'fpl-raw.db');
  const finalPath = resolve(scratchDir, 'fpl-final.db');

  try {
    // Inside the try, because preparing scratch can fail too - an unusable path, a read-only
    // filesystem - and this runs during start-up. A recovery that cannot proceed must report
    // that and let the app carry on failing in its own way, not throw out of the boot sequence
    // and replace one unexplained crash with another.
    mkdirSync(scratchDir, { recursive: true });
    rmSync(rawPath, { force: true, recursive: true });
    rmSync(finalPath, { force: true, recursive: true });

    // The source is opened READ-ONLY and never written to, and that is the whole correction.
    // Pruning the original first needs a write transaction, a write transaction needs somewhere
    // to put its journal, and on a volume with zero bytes free there is nowhere - so the
    // recovery died at precisely the moment it was needed. VACUUM INTO only reads its source,
    // so it works on a volume that cannot accept a single byte.
    const scratchFree = freeDiskBytes(scratchDir);
    report(
      `Scratch at ${scratchDir} has ` +
        (scratchFree === null ? 'unknown' : `${(scratchFree / 1024 / 1024).toFixed(0)} MB`) +
        ' free.',
    );

    // Two ways to produce a small database, and which one is possible depends entirely on how
    // much scratch there is. VACUUM INTO is the exact, boring, well-tested one - but it copies
    // the file whole, so it needs more room than the file itself. Scratch on a hosted container
    // is ephemeral and modest, and this very deploy failed because a 931 MB copy would not fit.
    const roomForWholeCopy =
      !options.preferSalvage && scratchFree !== null && scratchFree > bytesBefore * 1.2;
    let usedSalvage = false;

    if (roomForWholeCopy) {
      try {
        report('Copying the database out, read-only, then pruning the copy.');
        const source = new BetterSqlite3(path, { readonly: true });
        try {
          // Sorting during the copy must not spill temporary files back onto the volume being
          // rescued, which would fail for the same reason everything else does.
          source.pragma('temp_store = MEMORY');
          source.exec(`VACUUM INTO '${rawPath.replace(/'/g, "''")}'`);
        } finally {
          source.close();
        }

        const copy = new BetterSqlite3(rawPath);
        try {
          copy.pragma('temp_store = MEMORY');
          const pruned = pruneHistory(copy, { cacheDir: options.cacheDir });
          report(
            `Pruned ${pruned.snapshotsDeleted} snapshot(s), ${pruned.projectionsDeleted} ` +
              `superseded projection(s), ${pruned.cacheFilesDeleted} cached file(s).`,
          );
          copy.exec(`VACUUM INTO '${finalPath.replace(/'/g, "''")}'`);
        } finally {
          copy.close();
        }
        rmSync(rawPath, { force: true });
      } catch (cause) {
        report(
          `Whole-file copy failed (${cause instanceof Error ? cause.message : 'unknown'}), ` +
            'salvaging the rows that matter instead.',
        );
        usedSalvage = true;
      }
    } else {
      report('Not enough scratch for a whole copy - salvaging the rows that matter instead.');
      usedSalvage = true;
    }

    if (usedSalvage) {
      rmSync(rawPath, { force: true });
      salvageInto(path, finalPath, report);
    }

    const compactSize = statSync(finalPath).size;
    report(`Compacted copy is ${(compactSize / 1024 / 1024).toFixed(1)} MB.`);

    // Checked before anything irreversible happens. From here until the copy is back in place
    // the scratch file is the only database there is, so it had better be a good one.
    verifyUsable(finalPath);

    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });

    // Scratch is deliberately on another filesystem, so this is a copy rather than a rename.
    // The original is already gone by now, which is exactly why it was verified first.
    try {
      renameSync(finalPath, path);
    } catch {
      copyFileSync(finalPath, path);
      rmSync(finalPath, { force: true });
    }

    const bytesAfter = statSync(path).size;
    return {
      compacted: true,
      bytesBefore,
      bytesAfter,
      note:
        `Reclaimed ${((bytesBefore - bytesAfter) / 1024 / 1024).toFixed(0)} MB. ` +
        'No data you can see was lost: only superseded snapshots and replaced projection runs.',
    };
  } catch (cause) {
    // The original is untouched unless the swap itself failed, and the swap only begins once
    // the replacement has been opened and integrity-checked.
    //
    // Cleanup that can throw is not cleanup. These paths may be unusable - that is often why we
    // are in here - and an exception raised while reporting a failure replaces a clear message
    // with a crash, in the boot sequence, which is exactly the fault being recovered from.
    for (const leftover of [rawPath, finalPath]) {
      try {
        rmSync(leftover, { force: true, recursive: true });
      } catch {
        // Nothing to do about it, and nothing worth failing for.
      }
    }
    return {
      compacted: false,
      bytesBefore,
      bytesAfter: existsSync(path) ? statSync(path).size : 0,
      note: `Could not compact: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
    };
  }
}



/**
 * Rebuild a small database from a huge one by copying only the rows that matter.
 *
 * `VACUUM INTO` is the right tool when there is room for a complete copy, and on a volume that
 * has already filled there often is not: scratch space on a hosted container is ephemeral and
 * modest, and a near-gigabyte copy can fail outright. This needs about 35 MB instead, because it
 * never copies the bulk - it attaches the old database, selects out of it, and writes a fresh
 * one containing only what anything reads.
 *
 * What is deliberately left behind:
 *  - `player_snapshot.raw_json`, a verbatim copy of an API payload nothing has ever read back,
 *    and roughly ninety per cent of the file.
 *  - Superseded snapshots. The newest few and the last before each deadline are kept, because
 *    price-change detection and the Accuracy benchmark read exactly those.
 *  - Replaced projection runs. Grading already selects the newest per player per gameweek.
 *
 * What is kept in full is everything irreplaceable: stored recommendations and projections are
 * the record of what this app advised, and cannot be fetched again from anywhere.
 */
export function salvageInto(
  sourcePath: string,
  targetPath: string,
  report: (m: string) => void = () => {},
): void {
  rmSync(targetPath, { force: true });
  const out = new BetterSqlite3(targetPath);

  try {
    out.pragma('temp_store = MEMORY');
    // The new file gets the schema from the migrations, not from the old database, so a salvage
    // also brings a stale schema up to date rather than preserving whatever it had.
    migrate(out);
    // Copying between databases walks tables in whatever order they come; enforcing references
    // mid-copy would reject rows whose parent simply has not been copied yet.
    out.pragma('foreign_keys = OFF');
    out.exec(`ATTACH '${sourcePath.replace(/'/g, "''")}' AS src`);

    const tableNames = (sql: string) =>
      new Set(
        (out.prepare(sql).all() as { name: string }[])
          .map((row) => row.name)
          .filter((name) => !name.startsWith('sqlite_')),
      );
    const inSource = tableNames("SELECT name FROM src.sqlite_master WHERE type = 'table'");
    const inTarget = tableNames("SELECT name FROM main.sqlite_master WHERE type = 'table'");

    // Which snapshots survive: the newest few, plus the last before each deadline.
    const keep = new Set<number>();
    for (const row of out
      .prepare('SELECT id FROM src.snapshot ORDER BY taken_at DESC, id DESC LIMIT 8')
      .all() as { id: number }[]) {
      keep.add(row.id);
    }
    for (const row of out
      .prepare(
        `SELECT (SELECT id FROM src.snapshot WHERE taken_at <= e.deadline_time
                 ORDER BY taken_at DESC, id DESC LIMIT 1) AS id
         FROM src.event e WHERE e.deadline_time IS NOT NULL`,
      )
      .all() as { id: number | null }[]) {
      if (row.id !== null) keep.add(row.id);
    }
    const keepList = [...keep].join(',') || '-1';

    const copy = out.transaction(() => {
      for (const table of inTarget) {
        if (!inSource.has(table) || table === 'schema_migration') continue;

        // Column intersection, so a column added or dropped by a migration since this database
        // was written does not abort the whole salvage.
        //
        // The schema goes in the pragma's SECOND argument. Passing 'src.player' as the table
        // name instead returns no columns at all - silently, because an unknown table is not an
        // error to a pragma - so the intersection came out empty and every table was skipped.
        // The result was a perfectly valid, perfectly empty database, which the guard below
        // rejected rather than swapping in over the real one.
        const columnsOf = (schema: string): string[] =>
          (
            out.prepare(`SELECT name FROM pragma_table_xinfo(?, ?)`).all(table, schema) as {
              name: string;
            }[]
          ).map((row) => row.name);

        const targetCols = columnsOf('main');
        const sourceCols = new Set(columnsOf('src'));
        const shared = targetCols.filter((name) => sourceCols.has(name));
        if (shared.length === 0) continue;

        const select = shared
          .map((name) =>
            table === 'player_snapshot' && name === 'raw_json' ? `'' AS ${name}` : name,
          )
          .join(', ');
        const where =
          table === 'player_snapshot'
            ? ` WHERE snapshot_id IN (${keepList})`
            : table === 'snapshot'
              ? ` WHERE id IN (${keepList})`
              : table === 'projection'
                ? ` WHERE created_at = (SELECT MAX(created_at) FROM src.projection p
                     WHERE p.player_id = src.projection.player_id
                       AND p.event_id = src.projection.event_id
                       AND p.model_version = src.projection.model_version)`
                : '';

        const written = out
          .prepare(
            `INSERT OR IGNORE INTO main.${table} (${shared.join(', ')})
             SELECT ${select} FROM src.${table}${where}`,
          )
          .run().changes;
        if (written > 0) report(`  salvaged ${written} row(s) from ${table}`);
      }
    });
    copy();

    out.exec('DETACH src');
  } finally {
    out.close();
  }
}

/**
 * Open the candidate and make it prove it is a working database before anything is deleted.
 *
 * Exported because it is the guard standing between a recovery and a destroyed database, and a
 * guard nothing tests is a guard nobody should trust.
 */
export function verifyUsable(path: string): void {
  const check = new BetterSqlite3(path, { readonly: true });
  try {
    const integrity = check.pragma('integrity_check', { simple: true });
    if (String(integrity).toLowerCase() !== 'ok') {
      throw new Error(`the compacted copy failed its integrity check (${String(integrity)})`);
    }
    // A structurally valid but empty file would pass integrity_check happily, so the tables
    // this app cannot run without have to actually be there.
    for (const table of ['player', 'event', 'projection', 'schema_migration']) {
      check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    }
    const players = (check.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n;
    if (players === 0) throw new Error('the compacted copy has no players in it');
  } finally {
    check.close();
  }
}
