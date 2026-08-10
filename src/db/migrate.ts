import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(HERE, 'migrations');

export interface Migration {
  name: string;
  sql: string;
}

export interface AppliedMigration {
  name: string;
  appliedAt: number;
}

/** Migration files are `NNNN_description.sql` and are applied in filename order. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function appliedMigrations(db: Database): AppliedMigration[] {
  ensureMigrationTable(db);
  return db
    .prepare('SELECT name, applied_at AS appliedAt FROM schema_migration ORDER BY name')
    .all() as AppliedMigration[];
}

/**
 * Apply any migrations not yet recorded. Each runs inside a transaction with its bookkeeping
 * row, so a failure part-way leaves the database on the last complete migration rather than
 * in a half-applied state.
 */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): string[] {
  ensureMigrationTable(db);

  const done = new Set(appliedMigrations(db).map((row) => row.name));
  const pending = loadMigrations(dir).filter((migration) => !done.has(migration.name));

  const record = db.prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)');

  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.name, Math.floor(Date.now() / 1000));
    });
    try {
      run();
    } catch (cause) {
      throw new Error(`Migration ${migration.name} failed: ${(cause as Error).message}`, {
        cause,
      });
    }
  }

  return pending.map((migration) => migration.name);
}
