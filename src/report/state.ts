import type { Database } from 'better-sqlite3';
import { nowSeconds } from '../db/index.js';
import { lastSuccessfulRun } from '../ingest/run.js';

export interface IngestFreshness {
  source: string;
  lastSuccessAt: number | null;
  ageSeconds: number | null;
  stale: boolean;
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

export interface StateOfPlay {
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
  { label: 'players & prices', runs: ['bootstrap-static', 'import:bootstrap-static'] },
  { label: 'fixtures', runs: ['fixtures', 'import:fixtures'] },
  {
    label: 'last season',
    runs: [
      'element-summary',
      'import:element-summary',
      'import:season-csv',
      'import:gameweek-csv',
    ],
  },
  { label: 'your squad', runs: ['entry', 'import:entry', 'import:picks', 'import:entry-history'] },
] as const;

/**
 * A single read-only view of everything worth knowing before a deadline. Shared by the CLI and
 * the web report so both always tell the same story.
 */
export function getStateOfPlay(
  db: Database,
  options: { teamId?: number | null; staleAfterSeconds: number },
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
    const ageSeconds = lastSuccessAt === null ? null : now - lastSuccessAt;
    return {
      source: source.label,
      lastSuccessAt,
      ageSeconds,
      stale: ageSeconds === null || ageSeconds > options.staleAfterSeconds,
    };
  });

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

  let squad: SquadPlayerView[] = [];
  if (state) {
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
      .all(state.id)
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
  if (parts.length === 0) parts.push('<1m');
  return parts.join(' ');
}
