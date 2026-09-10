import type { Database } from 'better-sqlite3';
import { nowSeconds } from '../db/index.js';
import type { Recommendation } from '../report/recommend.js';

/**
 * Keeping the last generated team, so that looking at it again is free.
 *
 * Generation stays explicit - it is the one thing on this site that must be built from all the
 * evidence at once. But that rule was being applied to *looking* as well as to building: leaving
 * the tab and coming back demanded the button again and then produced the same answer from the
 * same data, which trains a reader to click past the one screen that is supposed to make them
 * stop and check.
 *
 * The question that actually matters is whether the team on screen was built from the data
 * currently on disk. So the inputs are fingerprinted, and the stored page is served until that
 * fingerprint stops matching - at which point the page says what changed rather than silently
 * serving something stale.
 */

/**
 * A fingerprint of every input the projections read.
 *
 * Deliberately built from counts as well as maximum timestamps. A timestamp alone misses a
 * deletion - clearing a squad leaves the remaining rows' timestamps untouched - and a count
 * alone misses a same-size overwrite, which is exactly what re-importing a bootstrap file is.
 * Cheap: six indexed aggregates.
 */
export function dataStamp(db: Database): string {
  const one = (sql: string): string => {
    const row = db.prepare(sql).get() as Record<string, number | null>;
    return Object.values(row)
      .map((value) => value ?? 0)
      .join('.');
  };

  return [
    one('SELECT COUNT(*) a, MAX(taken_at) b FROM snapshot'),
    one('SELECT COUNT(*) a, MAX(updated_at) b FROM player'),
    one('SELECT COUNT(*) a, MAX(updated_at) b FROM fixture'),
    one('SELECT COUNT(*) a, MAX(updated_at) b FROM player_fixture_history'),
    one('SELECT COUNT(*) a, MAX(updated_at) b FROM player_season_history'),
    one('SELECT COUNT(*) a, MAX(captured_at) b FROM manager_state'),
    one('SELECT COUNT(*) a, MAX(noted_at) b FROM confirmed_transfer'),
  ].join('|');
}

export interface CachedRecommendation {
  recommendation: Recommendation;
  generatedAt: number;
}

/** Store the page just generated, replacing whatever was there. */
export function saveCachedRecommendation(
  db: Database,
  recommendation: Recommendation,
  entryId: number | null,
): void {
  db.prepare(
    `INSERT INTO cached_recommendation
       (id, event_id, entry_id, model_version, data_stamp, generated_at, payload_json)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       event_id = excluded.event_id, entry_id = excluded.entry_id,
       model_version = excluded.model_version, data_stamp = excluded.data_stamp,
       generated_at = excluded.generated_at, payload_json = excluded.payload_json`,
  ).run(
    recommendation.eventId,
    entryId,
    recommendation.modelVersion,
    dataStamp(db),
    nowSeconds(),
    JSON.stringify(recommendation),
  );
}

/**
 * The stored page, if it still describes the data on disk.
 *
 * Returns null rather than something stale on every mismatch - a different gameweek, a different
 * team, a scoring change, or any import since. Serving a team built from data the reader has
 * since replaced is worse than asking them to click a button.
 */
export function loadCachedRecommendation(
  db: Database,
  eventId: number,
  entryId: number | null,
  modelVersion: string,
): CachedRecommendation | null {
  const row = db
    .prepare(
      `SELECT event_id AS eventId, entry_id AS entryId, model_version AS modelVersion,
              data_stamp AS dataStamp, generated_at AS generatedAt, payload_json AS payload
       FROM cached_recommendation WHERE id = 1`,
    )
    .get() as
    | {
        eventId: number;
        entryId: number | null;
        modelVersion: string;
        dataStamp: string;
        generatedAt: number;
        payload: string;
      }
    | undefined;

  if (!row) return null;
  if (row.eventId !== eventId) return null;
  if ((row.entryId ?? null) !== entryId) return null;
  if (row.modelVersion !== modelVersion) return null;
  if (row.dataStamp !== dataStamp(db)) return null;

  try {
    return {
      recommendation: JSON.parse(row.payload) as Recommendation,
      generatedAt: row.generatedAt,
    };
  } catch {
    // A payload written by an older shape of the app is not worth crashing a page over.
    return null;
  }
}

/** Whether a page was stored at all, regardless of whether it is still current. */
export function hasStaleCachedRecommendation(db: Database): boolean {
  return (
    (db.prepare('SELECT COUNT(*) AS n FROM cached_recommendation').get() as { n: number }).n > 0
  );
}
