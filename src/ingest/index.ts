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
  if (options.includePlayerSummaries) {
    report('Ingesting per-player match history (one request per player, throttled)...');
    summaries = await ingestPlayerSummaries(db, api, {
      playerIds: options.playerIds,
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) report(`  ${done}/${total} players`);
      },
    });
    report(`  ${summaries.rowsWritten} match rows from ${summaries.playersIngested} players`);
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
