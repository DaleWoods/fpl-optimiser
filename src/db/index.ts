import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveFromRoot } from '../config/load.js';
import { migrate } from './migrate.js';

export type { Database } from 'better-sqlite3';

export interface OpenOptions {
  /** Path to the database file, or ':memory:' for a throwaway database (used heavily in tests). */
  path: string;
  /** Apply pending migrations on open. Default true. */
  migrateOnOpen?: boolean;
  readonly?: boolean;
}

/**
 * Open the database with the pragmas this app wants everywhere:
 *  - foreign_keys ON, so a squad pick can never reference a player we never ingested
 *  - WAL, so a long ingestion does not block a read
 *  - busy_timeout, so a concurrent CLI invocation waits rather than throwing
 */
export function openDatabase(options: OpenOptions): Database {
  const isMemory = options.path === ':memory:';
  const path = isMemory ? options.path : resolveFromRoot(options.path);

  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new BetterSqlite3(path, { readonly: options.readonly ?? false });

  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!isMemory && !options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }

  if (options.migrateOnOpen !== false && !options.readonly) {
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
