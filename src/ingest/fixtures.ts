import type { Database } from 'better-sqlite3';
import type { FplApi } from '../api/client.js';
import type { ApiFixtures } from '../api/schemas.js';
import { isoToUnix, nowSeconds, toSqliteBool } from '../db/index.js';
import { withIngestRun } from './run.js';

export interface FixturesIngestResult {
  rowsWritten: number;
  fromCache: boolean;
  fetchedAt: number;
  skipped: number;
}

/**
 * Ingest the fixture list.
 *
 * Fixtures reference teams and events by foreign key. A fixture can legitimately arrive before
 * its event does (or reference a team we have not ingested, if bootstrap and fixtures are pulled
 * out of order), so unresolvable rows are skipped and counted rather than aborting the run - the
 * next ingestion, with bootstrap first, will pick them up.
 */
export async function ingestFixtures(db: Database, api: FplApi): Promise<FixturesIngestResult> {
  return withIngestRun(db, 'fixtures', async () => {
    const { data, fetchedAt, fromCache } = await api.fixtures();
    return ingestFixturesPayload(db, data, { fetchedAt, fromCache });
  });
}

export function ingestFixturesPayload(
  db: Database,
  data: ApiFixtures,
  meta: { fetchedAt: number; fromCache: boolean },
): FixturesIngestResult {
  const at = nowSeconds();

  const knownTeams = new Set(
    (db.prepare('SELECT id FROM team').all() as { id: number }[]).map((row) => row.id),
  );
  const knownEvents = new Set(
    (db.prepare('SELECT id FROM event').all() as { id: number }[]).map((row) => row.id),
  );

  const upsert = db.prepare(`
    INSERT INTO fixture (id, event_id, team_h, team_a, kickoff_time_iso, kickoff_time,
                         team_h_difficulty, team_a_difficulty, team_h_score, team_a_score,
                         started, finished, updated_at, raw_json)
    VALUES (@id, @event_id, @team_h, @team_a, @kickoff_time_iso, @kickoff_time,
            @team_h_difficulty, @team_a_difficulty, @team_h_score, @team_a_score,
            @started, @finished, @updated_at, @raw_json)
    ON CONFLICT (id) DO UPDATE SET
      event_id = excluded.event_id, team_h = excluded.team_h, team_a = excluded.team_a,
      kickoff_time_iso = excluded.kickoff_time_iso, kickoff_time = excluded.kickoff_time,
      team_h_difficulty = excluded.team_h_difficulty,
      team_a_difficulty = excluded.team_a_difficulty,
      team_h_score = excluded.team_h_score, team_a_score = excluded.team_a_score,
      started = excluded.started, finished = excluded.finished,
      updated_at = excluded.updated_at, raw_json = excluded.raw_json
  `);

  let written = 0;
  let skipped = 0;

  const write = db.transaction(() => {
    for (const fixture of data) {
      if (!knownTeams.has(fixture.team_h) || !knownTeams.has(fixture.team_a)) {
        skipped += 1;
        continue;
      }
      upsert.run({
        id: fixture.id,
        event_id: fixture.event !== null && knownEvents.has(fixture.event) ? fixture.event : null,
        team_h: fixture.team_h,
        team_a: fixture.team_a,
        kickoff_time_iso: fixture.kickoff_time,
        kickoff_time: isoToUnix(fixture.kickoff_time),
        team_h_difficulty: fixture.team_h_difficulty,
        team_a_difficulty: fixture.team_a_difficulty,
        team_h_score: fixture.team_h_score,
        team_a_score: fixture.team_a_score,
        started: toSqliteBool(fixture.started),
        finished: toSqliteBool(fixture.finished),
        updated_at: at,
        raw_json: JSON.stringify(fixture),
      });
      written += 1;
    }
  });

  write();

  return { rowsWritten: written, skipped, fromCache: meta.fromCache, fetchedAt: meta.fetchedAt };
}
