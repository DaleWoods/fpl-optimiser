import type { Database } from 'better-sqlite3';
import { nowSeconds } from '../db/index.js';
import { lastFailedRun, lastSuccessfulRun } from '../ingest/run.js';
import { freeDiskBytes } from '../db/maintenance.js';

export interface IngestFreshness {
  source: string;
  lastSuccessAt: number | null;
  ageSeconds: number | null;
  stale: boolean;
  /** Why it is stale, when the last attempt failed and nothing has succeeded since. */
  failure: string | null;
  failedAt: number | null;
}

export interface SquadPlayerView {
  playerId: number;
  name: string;
  team: string;
  position: string;
  slot: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  price: number | null;
  status: string | null;
  chanceOfPlaying: number | null;
  news: string | null;
}

export interface RecentChange {
  detectedAt: number;
  playerId: number;
  name: string;
  kind: string;
  note: string;
  inSquad: boolean;
}

export interface NextDeadline {
  eventId: number;
  name: string | null;
  deadline: number | null;
  deadlineIso: string | null;
  secondsUntil: number | null;
}

/**
 * How much room is left, and how long it will last at the rate it is being used.
 *
 * The app had no way to say it was filling up. It went from working to "disk I/O error" with
 * nothing in between, after weeks of writing ~7.5 MB a day that nobody could see - so the first
 * signal anything was wrong was total failure, during a gameweek. A tool that runs unattended
 * has to be able to say "I am most of the way full" long before it says "I am full".
 */
export interface DiskState {
  databaseBytes: number;
  freeBytes: number | null;
  /** Days until the volume is full at the observed growth rate. Null when it cannot be judged. */
  daysRemaining: number | null;
  /** True once this is worth putting on screen rather than only in the detail table. */
  warn: boolean;
}

export interface StateOfPlay {
  disk: DiskState;
  generatedAt: number;
  teamId: number | null;
  freshness: IngestFreshness[];
  anyStale: boolean;
  playerCount: number;
  snapshotCount: number;
  nextDeadline: NextDeadline | null;
  squad: SquadPlayerView[];
  squadLoaded: boolean;
  squadNote: string | null;
  bank: number | null;
  teamValue: number | null;
  freeTransfers: number | null;
  freeTransfersSource: string | null;
  chipsAvailable: string[];
  recentChanges: RecentChange[];
  flaggedInSquad: SquadPlayerView[];
}

/**
 * Each row of the freshness table, and every ingest_run source that can fill it.
 *
 * Data arrives two ways - pulled from the API, or imported from a file - and they record
 * different source names. Counting only the API ones made the dashboard report "never" for
 * someone who imports files, along with a permanent staleness warning, however recently they
 * had uploaded.
 */
const SOURCES = [
  { label: 'players & prices', runs: ['bootstrap-static', 'import:bootstrap-static'], oneOff: false },
  { label: 'fixtures', runs: ['fixtures', 'import:fixtures'], oneOff: false },
  {
    // A genuine one-off: last season's history never changes once it is in, and it can go
    // weeks between the automatic element-summary refresh (only after a gameweek finishes).
    // Judging it by the same few-hours-old threshold as the weekly sources meant it was
    // permanently reported "stale" - present, correct, and untouched is not the same thing as
    // out of date, so age does not apply here: only whether it has ever been imported at all.
    label: 'last season',
    runs: [
      'element-summary',
      'import:element-summary',
      'import:season-csv',
      'import:gameweek-csv',
    ],
    oneOff: true,
  },
  {
    label: 'your squad',
    runs: ['entry', 'import:entry', 'import:picks', 'import:entry-history'],
    oneOff: false,
  },
] as const;

/**
 * A single read-only view of everything worth knowing before a deadline. Shared by the CLI and
 * the web report so both always tell the same story.
 */
export function getStateOfPlay(
  db: Database,
  options: { teamId?: number | null; staleAfterSeconds: number; databasePath?: string },
): StateOfPlay {
  const now = nowSeconds();

  const freshness: IngestFreshness[] = SOURCES.map((source) => {
    let lastSuccessAt: number | null = null;
    for (const runSource of source.runs) {
      const run = lastSuccessfulRun(db, runSource);
      if (run && (lastSuccessAt === null || run.startedAt > lastSuccessAt)) {
        lastSuccessAt = run.startedAt;
      }
    }
    // Why it is stale, when the answer is already recorded. A source failing every refresh used
    // to be indistinguishable from one nobody had refreshed, which sends you looking for a
    // button to press instead of at the error that was there all along.
    let failure: string | null = null;
    let failedAt: number | null = null;
    for (const runSource of source.runs) {
      const failed = lastFailedRun(db, runSource);
      if (failed && (failedAt === null || failed.startedAt > failedAt)) {
        failedAt = failed.startedAt;
        failure = failed.note;
      }
    }

    const ageSeconds = lastSuccessAt === null ? null : now - lastSuccessAt;
    return {
      source: source.label,
      lastSuccessAt,
      ageSeconds,
      failure,
      failedAt,
      stale: source.oneOff ? lastSuccessAt === null : ageSeconds === null || ageSeconds > options.staleAfterSeconds,
    };
  });

  // Growth measured from the snapshots themselves rather than assumed: the oldest and newest
  // kept snapshot bracket a known span of time, and the database has grown over it.
  const disk = ((): DiskState => {
    const databaseBytes = (
      db
        .prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')
        .get() as { n: number }
    ).n;
    const freeBytes = freeDiskBytes(options.databasePath ?? '.');

    const span = db
      .prepare('SELECT MIN(taken_at) AS first, MAX(taken_at) AS last, COUNT(*) AS n FROM snapshot')
      .get() as { first: number | null; last: number | null; n: number };

    let daysRemaining: number | null = null;
    if (freeBytes !== null && span.first !== null && span.last !== null && span.n > 1) {
      const days = (span.last - span.first) / 86400;
      // A rate from a few hours of history is not a rate, it is a coincidence.
      if (days >= 1) {
        const perDay = databaseBytes / days;
        if (perDay > 0) daysRemaining = Math.round(freeBytes / perDay);
      }
    }

    return {
      databaseBytes,
      freeBytes,
      daysRemaining,
      // Either genuinely tight, or on course to be within a month - which is the point at which
      // saying something is still useful rather than merely accurate.
      warn:
        (freeBytes !== null && freeBytes < 300 * 1024 * 1024) ||
        (daysRemaining !== null && daysRemaining < 30),
    };
  })();

  const playerCount = (db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n;
  const snapshotCount = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;

  const deadlineRow = db
    .prepare(
      `SELECT id, name, deadline_time AS deadline, deadline_time_iso AS deadlineIso
       FROM event
       WHERE deadline_time IS NOT NULL AND deadline_time > ?
       ORDER BY deadline_time ASC LIMIT 1`,
    )
    .get(now) as
    | { id: number; name: string | null; deadline: number | null; deadlineIso: string | null }
    | undefined;

  const nextDeadline: NextDeadline | null = deadlineRow
    ? {
        eventId: deadlineRow.id,
        name: deadlineRow.name,
        deadline: deadlineRow.deadline,
        deadlineIso: deadlineRow.deadlineIso,
        secondsUntil: deadlineRow.deadline === null ? null : deadlineRow.deadline - now,
      }
    : null;

  const state = options.teamId
    ? (db
        .prepare(
          `SELECT id, bank, team_value AS teamValue, free_transfers AS freeTransfers,
                  free_transfers_source AS freeTransfersSource,
                  chips_available_json AS chipsAvailable, event_id AS eventId
           FROM manager_state WHERE entry_id = ? ORDER BY captured_at DESC LIMIT 1`,
        )
        .get(options.teamId) as
        | {
            id: number;
            bank: number | null;
            teamValue: number | null;
            freeTransfers: number | null;
            freeTransfersSource: string | null;
            chipsAvailable: string | null;
            eventId: number | null;
          }
        | undefined)
    : undefined;

  // The latest manager_state row with at least one squad_pick - not just the latest row full
  // stop (that is `state` above, kept for bank/free-transfers/chips, which are legitimately
  // freshest there regardless of picks). ingestEntry() writes a manager_state snapshot on every
  // refresh even when that gameweek's picks are not retrievable yet (the API 404s right around
  // a deadline, or briefly lags behind entry.current_event flipping over), and that snapshot
  // carries zero squad_pick rows. Using `state.id` unconditionally for the squad listing would
  // let that empty snapshot shadow a perfectly good previous one and make the Dashboard's squad
  // table go blank the moment a background refresh runs into that gap - see the identical fix
  // and fuller explanation in loadOwnedSquad(), src/report/recommend.ts.
  const squadStateId = options.teamId
    ? (db
        .prepare(
          `SELECT ms.id FROM manager_state ms
           WHERE ms.entry_id = ? AND EXISTS (SELECT 1 FROM squad_pick sp WHERE sp.manager_state_id = ms.id)
           ORDER BY ms.captured_at DESC LIMIT 1`,
        )
        .get(options.teamId) as { id: number } | undefined)?.id
    : undefined;

  let squad: SquadPlayerView[] = [];
  if (squadStateId !== undefined) {
    squad = db
      .prepare(
        `SELECT sp.player_id AS playerId, p.web_name AS name, t.short_name AS team,
                pos.short_name AS position, sp.slot, sp.is_captain AS isCaptain,
                sp.is_vice_captain AS isViceCaptain,
                ps.now_cost AS price, ps.status, ps.chance_of_playing_next_round AS chanceOfPlaying,
                ps.news
         FROM squad_pick sp
         JOIN player p ON p.id = sp.player_id
         JOIN team t ON t.id = p.team_id
         JOIN position pos ON pos.id = p.position_id
         LEFT JOIN player_snapshot ps
           ON ps.player_id = sp.player_id
          AND ps.snapshot_id = (SELECT id FROM snapshot ORDER BY taken_at DESC, id DESC LIMIT 1)
         WHERE sp.manager_state_id = ?
         ORDER BY sp.slot`,
      )
      .all(squadStateId)
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          playerId: r.playerId as number,
          name: r.name as string,
          team: r.team as string,
          position: r.position as string,
          slot: r.slot as number,
          isCaptain: r.isCaptain === 1,
          isViceCaptain: r.isViceCaptain === 1,
          price: (r.price as number | null) ?? null,
          status: (r.status as string | null) ?? null,
          chanceOfPlaying: (r.chanceOfPlaying as number | null) ?? null,
          news: (r.news as string | null) ?? null,
        };
      });
  }

  const squadIds = new Set(squad.map((player) => player.playerId));

  const recentChanges: RecentChange[] = (
    db
      .prepare(
        `SELECT c.detected_at AS detectedAt, c.player_id AS playerId, p.web_name AS name,
                c.kind, c.note
         FROM change_log c
         JOIN player p ON p.id = c.player_id
         ORDER BY c.detected_at DESC, c.id DESC
         LIMIT 50`,
      )
      .all() as Omit<RecentChange, 'inSquad'>[]
  ).map((change) => ({ ...change, inSquad: squadIds.has(change.playerId) }));

  // Anything not fully available. This is the list that must never appear in a recommendation.
  const flaggedInSquad = squad.filter(
    (player) => (player.status !== null && player.status !== 'a') || (player.chanceOfPlaying ?? 100) < 100,
  );

  const squadNote =
    squad.length > 0
      ? null
      : state
        ? 'Manager state is loaded but no squad picks are recorded yet - before the first ' +
          'deadline of a season there is nothing to load.'
        : 'No manager state ingested yet. Run an ingest with a team ID configured.';

  return {
    generatedAt: now,
    teamId: options.teamId ?? null,
    disk,
    freshness,
    anyStale: freshness.some((entry) => entry.stale),
    playerCount,
    snapshotCount,
    nextDeadline,
    squad,
    squadLoaded: squad.length > 0,
    squadNote,
    bank: state?.bank ?? null,
    teamValue: state?.teamValue ?? null,
    freeTransfers: state?.freeTransfers ?? null,
    freeTransfersSource: state?.freeTransfersSource ?? null,
    chipsAvailable: state?.chipsAvailable ? (JSON.parse(state.chipsAvailable) as string[]) : [],
    recentChanges,
    flaggedInSquad,
  };
}

export function formatMoney(tenths: number | null): string {
  return tenths === null ? 'unknown' : `£${(tenths / 10).toFixed(1)}m`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'never';
  const abs = Math.abs(seconds);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && minutes) parts.push(`${minutes}m`);
  // Not '<1m': every caller drops this straight into HTML, where a leading '<' opens what the
  // parser takes for a tag and silently eats the rest of the sentence.
  if (parts.length === 0) parts.push('under a minute');
  return parts.join(' ');
}
