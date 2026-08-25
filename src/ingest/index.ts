import type { Database } from 'better-sqlite3';
import type { FplApi } from '../api/client.js';
import type { Rules } from '../config/schema.js';
import { ingestBootstrap, type BootstrapIngestResult } from './bootstrap.js';
import { ingestEliteOwnership, type EliteIngestResult } from './elite.js';
import { ingestEntry, type EntryIngestResult } from './entry.js';
import { ingestFixtures, type FixturesIngestResult } from './fixtures.js';
import { ingestPlayerSummaries, type SummariesIngestResult } from './playerSummaries.js';

export * from './bootstrap.js';
export * from './elite.js';
export * from './import.js';
export * from './reset.js';
export * from './csv.js';
export * from './gameweekCsv.js';
export * from './entry.js';
export * from './fixtures.js';
export * from './playerSummaries.js';
export * from './run.js';

export interface FullIngestOptions {
  teamId?: number | null;
  /** Per-player histories are one request each; skip them for a quick refresh. */
  includePlayerSummaries?: boolean;
  playerIds?: number[];
  /** Sample what top-ranked managers own. Only possible once a gameweek has started. */
  includeEliteOwnership?: boolean;
  eliteManagers?: number;
  onProgress?: (message: string) => void;
}

export interface FullIngestResult {
  bootstrap: BootstrapIngestResult;
  fixtures: FixturesIngestResult;
  summaries: SummariesIngestResult | null;
  entry: EntryIngestResult | null;
  elite: EliteIngestResult | null;
}

/**
 * Run a full ingestion in dependency order: bootstrap first (it defines teams, positions,
 * events and players), then fixtures, then per-player history, then the manager's own squad.
 */
export async function ingestAll(
  db: Database,
  api: FplApi,
  rules: Rules,
  options: FullIngestOptions = {},
): Promise<FullIngestResult> {
  const report = options.onProgress ?? (() => {});

  report('Ingesting bootstrap-static (players, teams, positions, gameweeks)...');
  const bootstrap = await ingestBootstrap(db, api, rules);
  report(
    `  ${bootstrap.rowsWritten} rows, snapshot #${bootstrap.snapshotId}` +
      (bootstrap.changes.length > 0 ? `, ${bootstrap.changes.length} change(s) detected` : ''),
  );

  report('Ingesting fixtures...');
  const fixtures = await ingestFixtures(db, api);
  report(`  ${fixtures.rowsWritten} fixtures${fixtures.skipped ? `, ${fixtures.skipped} skipped` : ''}`);

  let summaries: SummariesIngestResult | null = null;
  // Element-summary is the slowest ingestion by far (one request per player), so it is not run
  // on every refresh - but it is also the only source of the exact per-gameweek actual points
  // this app grades projections against, so it must not sit waiting for someone to ask for it
  // either. The fix: run it automatically, but only when there is a genuine reason to -
  // self-throttling, not a fixed schedule.
  const latestFinished = db
    .prepare('SELECT id FROM event WHERE finished = 1 ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  const notYetCaptured =
    latestFinished !== undefined &&
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM player_fixture_history WHERE event_id = ?')
        .get(latestFinished.id) as { n: number }
    ).n === 0;

  // The other reason to run it: last season's history (element-summary's history_past) has
  // never been captured at all. This is what makes the pre-season "last season's stats" import
  // genuinely optional rather than required - the same weekly background refresh that already
  // fetches prices seeds it once, automatically, with no gameweek needing to finish first. A
  // manual CSV upload still works and can still add detail this doesn't (see importSlots.ts),
  // but nobody has to remember to do it just to unblock the model.
  const neverCapturedLastSeason =
    (db.prepare('SELECT COUNT(*) AS n FROM player_season_history').get() as { n: number }).n === 0;

  const reason = options.includePlayerSummaries
    ? 'Ingesting per-player match history (one request per player, throttled)...'
    : notYetCaptured
      ? `Gameweek ${latestFinished!.id} just finished - fetching each player's actual result...`
      : neverCapturedLastSeason
        ? "No last season's history yet - fetching it automatically, one request per player..."
        : null;

  if (reason) {
    report(reason);
    summaries = await ingestPlayerSummaries(db, api, {
      playerIds: options.playerIds,
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) report(`  ${done}/${total} players`);
      },
    });
    report(
      `  ${summaries.rowsWritten} match rows from ${summaries.playersIngested} players, ` +
        `${summaries.actualPointsRecorded} actual score(s) recorded`,
    );
  }

  let entry: EntryIngestResult | null = null;
  if (options.teamId != null) {
    report(`Loading squad for entry ${options.teamId}...`);
    entry = await ingestEntry(db, api, options.teamId, rules);
    for (const note of entry.notes) report(`  note: ${note}`);
  }

  let elite: EliteIngestResult | null = null;
  if (options.includeEliteOwnership) {
    // The most recently finished gameweek is the latest one whose squads are public.
    const lastStarted = db
      .prepare('SELECT id FROM event WHERE finished = 1 ORDER BY id DESC LIMIT 1')
      .get() as { id: number } | undefined;

    if (lastStarted) {
      report(`Sampling what top managers own in gameweek ${lastStarted.id}...`);
      elite = await ingestEliteOwnership(db, api, {
        eventId: lastStarted.id,
        managers: options.eliteManagers,
        onProgress: (done, total) => {
          if (done % 10 === 0 || done === total) report(`  ${done}/${total} managers`);
        },
      });
      for (const note of elite.notes) report(`  note: ${note}`);
      if (elite.managersSampled > 0) {
        report(`  sampled ${elite.managersSampled} managers, ${elite.playersSeen} players seen`);
      }
    } else {
      report('Skipping elite ownership: no gameweek has finished yet, so squads are still private.');
    }
  }

  return { bootstrap, fixtures, summaries, entry, elite };
}
