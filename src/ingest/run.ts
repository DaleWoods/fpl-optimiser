import type { Database } from 'better-sqlite3';
import { nowSeconds } from '../db/index.js';

export interface IngestRunResult {
  runId: number;
  source: string;
  ok: boolean;
  rowsWritten: number;
  fromCache: boolean;
  note?: string;
}

/**
 * Wrap an ingestion in bookkeeping. Every attempt is recorded, successful or not, so
 * "when did we last manage to refresh this?" is always answerable - which is what the
 * staleness warnings before a deadline depend on.
 */
export async function withIngestRun<T extends { rowsWritten: number; fromCache: boolean }>(
  db: Database,
  source: string,
  work: () => Promise<T>,
): Promise<T & { runId: number }> {
  const startedAt = nowSeconds();
  const insert = db.prepare(
    'INSERT INTO ingest_run (source, started_at, ok) VALUES (?, ?, 0)',
  );
  const info = insert.run(source, startedAt);
  const runId = Number(info.lastInsertRowid);

  try {
    const result = await work();
    db.prepare(
      'UPDATE ingest_run SET finished_at = ?, ok = 1, rows_written = ?, from_cache = ? WHERE id = ?',
    ).run(nowSeconds(), result.rowsWritten, result.fromCache ? 1 : 0, runId);
    return { ...result, runId };
  } catch (cause) {
    db.prepare('UPDATE ingest_run SET finished_at = ?, ok = 0, note = ? WHERE id = ?').run(
      nowSeconds(),
      (cause as Error).message.slice(0, 2000),
      runId,
    );
    throw cause;
  }
}

export interface LastRun {
  source: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean;
  rowsWritten: number;
  note: string | null;
}

/** The most recent successful run for a source, or null if it has never succeeded. */
export function lastSuccessfulRun(db: Database, source: string): LastRun | null {
  const row = db
    .prepare(
      `SELECT source, started_at AS startedAt, finished_at AS finishedAt, ok,
              rows_written AS rowsWritten, note
       FROM ingest_run
       WHERE source = ? AND ok = 1
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(source) as (Omit<LastRun, 'ok'> & { ok: number }) | undefined;
  return row ? { ...row, ok: row.ok === 1 } : null;
}
