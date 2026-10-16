import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveFromRoot } from '../config/load.js';
import { isDiskSpaceFailure, planDiskRecovery } from './maintenance.js';
import { migrate } from './migrate.js';

export type { Database } from 'better-sqlite3';

export interface OpenOptions {
  /** Path to the database file, or ':memory:' for a throwaway database (used heavily in tests). */
  path: string;
  /** Apply pending migrations on open. Default true. */
  migrateOnOpen?: boolean;
  readonly?: boolean;
  /**
   * Disposable files to delete if opening fails because the disk is full, before trying once
   * more. The HTTP response cache, in practice: every file in it is a copy of something the API
   * will serve again, and unlinking a file needs no free space at all.
   */
  freeSpaceDir?: string;
  onWarning?: (message: string) => void;
}

/**
 * Open the database with the pragmas this app wants everywhere:
 *  - foreign_keys ON, so a squad pick can never reference a player we never ingested
 *  - WAL, so a long ingestion does not block a read
 *  - busy_timeout, so a concurrent CLI invocation waits rather than throwing
 */
export function openDatabase(options: OpenOptions): Database {
  const warn = options.onWarning ?? ((message: string) => console.warn(`[db] ${message}`));

  try {
    return openOnce(options, warn);
  } catch (cause) {
    // A full disk used to kill the process here, before the server ever listened - which meant
    // the one screen offering to free space could never be served, and the service sat in a
    // restart loop that nothing inside the app could break. Recovery has to happen before the
    // database opens, or it may as well not exist.
    const recovery = planDiskRecovery(cause, options.freeSpaceDir);
    if (recovery.message) warn(recovery.message);
    if (!recovery.retry) throw cause;
    return openOnce(options, warn);
  }
}

function openOnce(options: OpenOptions, warn: (message: string) => void): Database {
  const isMemory = options.path === ':memory:';
  const path = isMemory ? options.path : resolveFromRoot(options.path);

  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new BetterSqlite3(path, { readonly: options.readonly ?? false });

  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!isMemory && !options.readonly) {
    // Switching journal mode rewrites the database header, so on a full disk it is the first
    // thing to fail - and it is the reason a crash loop looked like database corruption. These
    // two are performance settings, not correctness ones: without them SQLite falls back to a
    // rollback journal and everything still works, slightly slower. Losing the app entirely
    // because it could not go faster is the wrong trade.
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    } catch (cause) {
      if (!isDiskSpaceFailure(cause)) throw cause;
      warn(
        'The disk is full, so write-ahead logging could not be enabled. Running on the default ' +
          'journal instead - slower, but working. Free up space on the Import Data tab.',
      );
    }
  }

  if (options.migrateOnOpen !== false && !options.readonly) {
    // Deliberately not caught: a half-migrated schema is a correctness problem, and carrying on
    // with one would corrupt data rather than merely slow it down.
    migrate(db);
  }

  return db;
}

/** A migrated in-memory database. */
export function openTestDatabase(): Database {
  return openDatabase({ path: ':memory:' });
}

/** Unix seconds — the time unit used by every INTEGER timestamp column. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parse an API ISO timestamp to unix seconds. Returns null for null/invalid input rather than
 * NaN, so a malformed deadline surfaces as "unknown" instead of poisoning arithmetic.
 */
export function isoToUnix(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** SQLite has no boolean type; store 0/1. */
export function toSqliteBool(value: boolean | null | undefined): number {
  return value ? 1 : 0;
}

export function fromSqliteBool(value: number | null | undefined): boolean {
  return value === 1;
}
