import type { Database } from 'better-sqlite3';
import type { FplApi } from '../api/client.js';
import type { Rules } from '../config/schema.js';
import { ingestBootstrap, type BootstrapIngestResult } from './bootstrap.js';
import { ingestEliteOwnership, type EliteIngestResult } from './elite.js';
import { backfillHistoricPicks, ingestEntry, type EntryIngestResult } from './entry.js';
import { ingestFixtures, type FixturesIngestResult } from './fixtures.js';
import {
  gameweeksMissingResults,
  ingestPlayerSummaries,
  syncActualPointsFromFixtureHistory,
  type SummariesIngestResult,
} from './playerSummaries.js';

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
  /** Steps that failed without stopping the rest, each already recorded against its source. */
  failures: string[];
}


/**
 * Run one ingest step without letting its failure end the refresh.
 *
 * Only for steps nothing downstream depends on. Bootstrap is deliberately not wrapped: every
 * later step references the players and gameweeks it writes, so carrying on without it would
 * produce a refresh that looks successful and leaves the data inconsistent.
 */
async function step<T>(
  label: string,
  report: (message: string) => void,
  work: () => Promise<T>,
  failures: string[],
): Promise<T | null> {
  try {
    return await work();
  } catch (cause) {
    const message = `${label} failed: ${(cause as Error).message}`;
    report(`  ${message}`);
    failures.push(message);
    return null;
  }
}

/**
 * Run a full ingestion in dependency order: bootstrap first (it defines teams, positions,
 * events and players), then fixtures, then per-player history, then the manager's own squad.
 *
 * Order is a dependency, not a chain of command. Bootstrap genuinely must succeed - everything
 * after it references the players and gameweeks it writes - but the later steps are independent
 * of each other, and letting one abort the rest is how a single slow or flaky step took the
 * whole refresh down with it: per-player results failed, so the squad after it never refreshed,
 * so the Dashboard reported the squad stale and pointed at a button that would fail the same
 * way. Each of those now records its own failure and the rest carries on.
 */
export async function ingestAll(
  db: Database,
  api: FplApi,
  rules: Rules,
  options: FullIngestOptions = {},
): Promise<FullIngestResult> {
  const report = options.onProgress ?? (() => {});
  const failures: string[] = [];

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

  // Copy whatever match history is already stored into gradeable results, every single refresh.
  // One idempotent statement, and it is the cheap half of the job: if the history landed but the
  // step that turns it into results did not - a crash, a full disk, a restart in between - this
  // alone fixes it, with no requests at all.
  const synced = syncActualPointsFromFixtureHistory(db);
  if (synced > 0) report(`Recorded ${synced} actual result(s) from match history already stored`);

  // Element-summary is the slowest ingestion by far (one request per player), so it is not run
  // on every refresh - but it is also the only source of the exact per-gameweek actual points
  // this app grades projections against, so it must not sit waiting for someone to ask for it
  // either. Run it automatically, but only when there is a genuine reason to.
  //
  // That reason used to be "the most recently finished gameweek has no match history at all",
  // and both halves of it were wrong. It asked about `player_fixture_history` while what
  // grading actually needs is `actual_points`, so a gameweek whose history arrived but never
  // became results looked captured forever. And it only ever examined the single latest
  // finished gameweek, so anything that finished while the app was down - a crash loop, a full
  // disk, a long deploy - was skipped the moment a later one finished and never came back.
  //
  // Asking the question the page asks instead: which finished gameweeks cannot be graded?
  const ungraded = gameweeksMissingResults(db);
  const notYetCaptured = ungraded.length > 0;

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
      ? `Gameweek ${ungraded.join(', ')} ${ungraded.length === 1 ? 'has' : 'have'} no results ` +
        "yet - fetching each player's actual result..."

      : neverCapturedLastSeason
        ? "No last season's history yet - fetching it automatically, one request per player..."
        : null;

  if (reason) {
    report(reason);
    summaries = await step(
      "Per-player results",
      report,
      () =>
        ingestPlayerSummaries(db, api, {
          playerIds: options.playerIds,
          onProgress: (done, total) => {
            if (done % 50 === 0 || done === total) report(`  ${done}/${total} players`);
          },
        }),
      failures,
    );
    if (summaries) {
      report(
        `  ${summaries.rowsWritten} match rows from ${summaries.playersIngested} players, ` +
          `${summaries.actualPointsRecorded} actual score(s) recorded`,
      );
    }
    // Whatever did land becomes gradeable, even when the fetch died partway through. Without
    // this a run that got 600 players in before failing recorded nothing at all.
    const lateSync = syncActualPointsFromFixtureHistory(db);
    if (lateSync > 0) report(`  ${lateSync} further actual result(s) recorded`);
  }

  let entry: EntryIngestResult | null = null;
  if (options.teamId != null) {
    report(`Loading squad for entry ${options.teamId}...`);
    entry = await step(
      'Your squad',
      report,
      () => ingestEntry(db, api, options.teamId!, rules),
      failures,
    );
    for (const note of entry?.notes ?? []) report(`  note: ${note}`);

    // The squads held in past gameweeks, which the backtest cannot replay a week without. Only
    // the current week's picks were ever stored, so the usable sample was capped at the weeks
    // somebody happened to be running this app - while the data sat public and unfetched the
    // whole time. Cheap and idempotent: one request per gameweek not already held, and none
    // at all once the season is caught up.
    const lastStartedEvent = db
      .prepare('SELECT id FROM event WHERE finished = 1 ORDER BY id DESC LIMIT 1')
      .get() as { id: number } | undefined;

    if (lastStartedEvent) {
      const backfill = await step(
        'Past squads',
        report,
        () =>
          backfillHistoricPicks(db, api, options.teamId!, { throughEvent: lastStartedEvent.id }),
        failures,
      );
      for (const note of backfill?.notes ?? []) report(`  note: ${note}`);
    }
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

  // Reported rather than thrown. A refresh that got most of the way is far more useful than
  // one that pretends nothing happened, and the caller needs to be able to say which part is
  // broken instead of a single top-level message that names none of them.
  return { bootstrap, fixtures, summaries, entry, elite, failures };
}
