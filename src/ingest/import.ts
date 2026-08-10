import type { Database } from 'better-sqlite3';
import {
  bootstrapSchema,
  elementSummarySchema,
  fixturesSchema,
  picksSchema,
} from '../api/schemas.js';
import type { Rules } from '../config/schema.js';
import { nowSeconds } from '../db/index.js';
import { ingestBootstrapPayload } from './bootstrap.js';
import { ingestFixturesPayload } from './fixtures.js';
import { ingestElementSummaryPayload } from './playerSummaries.js';
import { num, pick, toTable } from './csv.js';
import { withIngestRun } from './run.js';

/**
 * Import data from files instead of the network.
 *
 * The FPL API is public but not always reachable - a locked-down network, an outage, or simply
 * running the app somewhere without egress. Saving the API's own JSON from a browser and
 * importing it here gives byte-identical data with no scraping and no transformation, which is
 * the most faithful route there is.
 *
 * CSV is supported for previous-season history, because that is what people actually have
 * lying around in spreadsheets.
 */

export type PayloadKind =
  | 'bootstrap'
  | 'fixtures'
  | 'element-summary'
  | 'picks'
  | 'season-csv'
  | 'unknown';

export interface ImportSummary {
  kind: PayloadKind;
  rowsWritten: number;
  detail: string;
  warnings: string[];
}

/**
 * Work out what a file is from its contents rather than its name, so a file saved as
 * "download (3).json" still imports correctly.
 */
export function detectPayloadKind(text: string): PayloadKind {
  const trimmed = text.trimStart();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return 'season-csv';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return 'unknown';
  }

  if (Array.isArray(parsed)) {
    const first = parsed[0] as Record<string, unknown> | undefined;
    if (first && 'team_h' in first && 'team_a' in first) return 'fixtures';
    return 'unknown';
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if ('elements' in record && 'teams' in record && 'element_types' in record) return 'bootstrap';
    if ('history' in record || 'history_past' in record) return 'element-summary';
    if ('picks' in record) return 'picks';
  }

  return 'unknown';
}

export interface ImportOptions {
  /** Only needed for element-summary files that do not name their player. */
  playerId?: number;
  /** Label recorded against the ingest run, e.g. the original filename. */
  sourceLabel?: string;
}

export async function importPayload(
  db: Database,
  rules: Rules,
  text: string,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const kind = detectPayloadKind(text);
  const label = options.sourceLabel ?? 'upload';

  switch (kind) {
    case 'bootstrap':
      return withIngestRun(db, 'import:bootstrap-static', async () => {
        const parsed = bootstrapSchema.parse(JSON.parse(text));
        const result = ingestBootstrapPayload(db, parsed, rules, {
          fetchedAt: nowSeconds(),
          fromCache: false,
        });
        return {
          kind,
          rowsWritten: result.rowsWritten,
          fromCache: false,
          detail:
            `${parsed.elements.length} players, ${parsed.teams.length} clubs, ` +
            `${parsed.events.length} gameweeks` +
            (result.changes.length > 0 ? `, ${result.changes.length} change(s) detected` : ''),
          warnings: [],
        };
      });

    case 'fixtures':
      return withIngestRun(db, 'import:fixtures', async () => {
        const parsed = fixturesSchema.parse(JSON.parse(text));
        const result = ingestFixturesPayload(db, parsed, {
          fetchedAt: nowSeconds(),
          fromCache: false,
        });
        return {
          kind,
          rowsWritten: result.rowsWritten,
          fromCache: false,
          detail: `${result.rowsWritten} fixtures imported`,
          warnings:
            result.skipped > 0
              ? [
                  `${result.skipped} fixture(s) skipped because their clubs are not in the ` +
                    'database yet. Import bootstrap-static first, then re-import fixtures.',
                ]
              : [],
        };
      });

    case 'element-summary':
      return withIngestRun(db, 'import:element-summary', async () => {
        const parsed = elementSummarySchema.parse(JSON.parse(text));
        // The player id is not in the payload itself; take it from the history rows.
        const playerId = options.playerId ?? parsed.history[0]?.element;
        if (playerId === undefined) {
          throw new Error(
            'This element-summary file has no match history, so there is no way to tell which ' +
              'player it belongs to. Import it with an explicit player id.',
          );
        }
        const rows = ingestElementSummaryPayload(db, playerId, parsed);
        return {
          kind,
          rowsWritten: rows,
          fromCache: false,
          detail:
            `player ${playerId}: ${parsed.history.length} match rows, ` +
            `${parsed.history_past.length} previous season(s)`,
          warnings:
            rows === 0
              ? [`Player ${playerId} is not in the database. Import bootstrap-static first.`]
              : [],
        };
      });

    case 'picks':
      return withIngestRun(db, 'import:picks', async () => {
        const parsed = picksSchema.parse(JSON.parse(text));
        return {
          kind,
          rowsWritten: 0,
          fromCache: false,
          detail:
            `${parsed.picks.length} picks read. Squad import from a saved picks file is not ` +
            'wired up yet - use the entry ingestion once the gameweek has started.',
          warnings: ['Picks files are recognised but not yet imported.'],
        };
      });

    case 'season-csv':
      return importSeasonCsv(db, text, label);

    default:
      throw new Error(
        `Could not tell what kind of file this is (${label}). Expected FPL API JSON ` +
          '(bootstrap-static, fixtures, element-summary) or a CSV of season stats.',
      );
  }
}

/**
 * Import previous-season totals from a spreadsheet.
 *
 * Rows are matched to players by FPL element id where the file supplies one, otherwise by name
 * and club. Anything that cannot be matched is reported with its row number rather than
 * dropped: a silently ignored row is how a season of stats goes missing without anyone noticing.
 */
export function importSeasonCsv(
  db: Database,
  text: string,
  label = 'upload',
): Promise<ImportSummary> {
  return withIngestRun(db, 'import:season-csv', async () => {
    const table = toTable(text);
    if (table.rows.length === 0) {
      throw new Error(`${label} has no data rows.`);
    }

    const players = db
      .prepare(
        `SELECT p.id, p.code, p.web_name AS webName, p.second_name AS secondName,
                t.short_name AS club, t.name AS clubName
         FROM player p JOIN team t ON t.id = p.team_id`,
      )
      .all() as {
      id: number;
      code: number | null;
      webName: string;
      secondName: string | null;
      club: string;
      clubName: string;
    }[];

    if (players.length === 0) {
      throw new Error(
        'No players in the database to match against. Import bootstrap-static first, then this file.',
      );
    }

    // Strip accents, case and punctuation, but keep digits: names can legitimately contain
    // them, and discarding them collapses distinct players onto the same key.
    const key = (name: string) =>
      name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    const byId = new Map(players.map((p) => [p.id, p]));
    const byCode = new Map(players.filter((p) => p.code !== null).map((p) => [p.code!, p]));
    // A player is indexed under both their display name and their surname, which are often the
    // same. Deduplicate by id, or one player indexed twice looks like two players and every
    // match is wrongly rejected as ambiguous.
    const byName = new Map<string, typeof players>();
    for (const p of players) {
      for (const candidate of [p.webName, p.secondName].filter(Boolean) as string[]) {
        const list = byName.get(key(candidate)) ?? [];
        if (!list.some((existing) => existing.id === p.id)) list.push(p);
        byName.set(key(candidate), list);
      }
    }

    const upsert = db.prepare(`
      INSERT INTO player_season_history (
        player_id, season_name, element_code, start_cost, end_cost, total_points, minutes, starts,
        goals_scored, assists, clean_sheets, goals_conceded, saves, bonus, bps,
        yellow_cards, red_cards, expected_goals, expected_assists, expected_goal_involvements,
        expected_goals_conceded, defensive_contribution, updated_at, raw_json
      ) VALUES (
        @player_id, @season_name, @element_code, @start_cost, @end_cost, @total_points, @minutes, @starts,
        @goals_scored, @assists, @clean_sheets, @goals_conceded, @saves, @bonus, @bps,
        @yellow_cards, @red_cards, @expected_goals, @expected_assists, @expected_goal_involvements,
        @expected_goals_conceded, @defensive_contribution, @updated_at, @raw_json
      )
      ON CONFLICT (player_id, season_name) DO UPDATE SET
        total_points = excluded.total_points, minutes = excluded.minutes, starts = excluded.starts,
        goals_scored = excluded.goals_scored, assists = excluded.assists,
        clean_sheets = excluded.clean_sheets, goals_conceded = excluded.goals_conceded,
        saves = excluded.saves, bonus = excluded.bonus, bps = excluded.bps,
        expected_goals = excluded.expected_goals, expected_assists = excluded.expected_assists,
        expected_goals_conceded = excluded.expected_goals_conceded,
        defensive_contribution = excluded.defensive_contribution,
        start_cost = excluded.start_cost, end_cost = excluded.end_cost,
        updated_at = excluded.updated_at, raw_json = excluded.raw_json
    `);

    const at = nowSeconds();
    const warnings: string[] = [];
    const unmatched: string[] = [];
    const ambiguous: string[] = [];
    let written = 0;

    const defaultSeason = pick(table.rows[0]!, 'season', 'season_name') ?? '2025/26';

    const write = db.transaction(() => {
      for (const [index, row] of table.rows.entries()) {
        const lineNumber = index + 2; // +1 for the header, +1 for 1-based counting

        const idValue = num(pick(row, 'id', 'element', 'player_id', 'element_id'));
        const codeValue = num(pick(row, 'code', 'element_code'));
        const name = pick(row, 'name', 'player_name', 'web_name', 'second_name', 'player');
        const club = pick(row, 'team', 'club', 'team_name', 'short_name');

        let match =
          (idValue !== null ? byId.get(idValue) : undefined) ??
          (codeValue !== null ? byCode.get(codeValue) : undefined);

        if (!match && name) {
          const candidates = byName.get(key(name)) ?? [];
          if (candidates.length === 1) {
            match = candidates[0];
          } else if (candidates.length > 1 && club) {
            const clubKey = key(club);
            const narrowed = candidates.filter(
              (c) => key(c.club) === clubKey || key(c.clubName) === clubKey,
            );
            if (narrowed.length === 1) match = narrowed[0];
            else if (narrowed.length > 1) ambiguous.push(`line ${lineNumber}: ${name}`);
          } else if (candidates.length > 1) {
            ambiguous.push(`line ${lineNumber}: ${name} (add a club column to disambiguate)`);
          }
        }

        if (!match) {
          unmatched.push(`line ${lineNumber}: ${name ?? '(no name column)'}`);
          continue;
        }

        upsert.run({
          player_id: match.id,
          season_name: pick(row, 'season', 'season_name') ?? defaultSeason,
          element_code: match.code,
          start_cost: num(pick(row, 'start_cost', 'startprice')),
          end_cost: num(pick(row, 'end_cost', 'price', 'now_cost', 'value')),
          total_points: num(pick(row, 'total_points', 'points', 'pts')),
          minutes: num(pick(row, 'minutes', 'mins')),
          starts: num(pick(row, 'starts')),
          goals_scored: num(pick(row, 'goals_scored', 'goals')),
          assists: num(pick(row, 'assists')),
          clean_sheets: num(pick(row, 'clean_sheets', 'cs')),
          goals_conceded: num(pick(row, 'goals_conceded', 'gc')),
          saves: num(pick(row, 'saves')),
          bonus: num(pick(row, 'bonus')),
          bps: num(pick(row, 'bps')),
          yellow_cards: num(pick(row, 'yellow_cards', 'yc')),
          red_cards: num(pick(row, 'red_cards', 'rc')),
          expected_goals: num(pick(row, 'expected_goals', 'xg')),
          expected_assists: num(pick(row, 'expected_assists', 'xa')),
          expected_goal_involvements: num(pick(row, 'expected_goal_involvements', 'xgi')),
          expected_goals_conceded: num(pick(row, 'expected_goals_conceded', 'xgc')),
          defensive_contribution: num(pick(row, 'defensive_contribution', 'defcon', 'cbit', 'cbirt')),
          updated_at: at,
          raw_json: JSON.stringify(row),
        });
        written += 1;
      }
    });

    write();

    if (unmatched.length > 0) {
      warnings.push(
        `${unmatched.length} row(s) matched no player and were not imported: ` +
          `${unmatched.slice(0, 8).join('; ')}${unmatched.length > 8 ? ' ...' : ''}`,
      );
    }
    if (ambiguous.length > 0) {
      warnings.push(
        `${ambiguous.length} row(s) matched more than one player and were skipped: ` +
          `${ambiguous.slice(0, 8).join('; ')}${ambiguous.length > 8 ? ' ...' : ''}`,
      );
    }

    return {
      kind: 'season-csv' as const,
      rowsWritten: written,
      fromCache: false,
      detail: `${written} of ${table.rows.length} row(s) imported into season history`,
      warnings,
    };
  });
}
