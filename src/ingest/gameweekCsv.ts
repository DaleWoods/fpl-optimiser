import type { Database } from 'better-sqlite3';
import { nowSeconds, toSqliteBool } from '../db/index.js';
import { num, pick, toTable, type CsvTable } from './csv.js';
import { withIngestRun } from './run.js';
import type { ImportSummary } from './import.js';

/**
 * Import a per-gameweek player stats spreadsheet.
 *
 * This is a richer shape than season totals: one row per player per gameweek, with minutes,
 * underlying numbers and the defensive-contribution inputs. A season total cannot distinguish
 * a player who scored steadily from one who had three hauls and nothing else; this can.
 *
 * MATCHING ACROSS SEASONS IS BY NAME, NOT ID. FPL reassigns element ids between seasons, so a
 * file from last season carries ids that now belong to completely different players. Trusting
 * them would silently attribute one player's season to another - the kind of error that never
 * announces itself and quietly poisons every projection. Names plus clubs are slower and
 * occasionally ambiguous, but they are honest, and anything ambiguous is reported.
 */

/** Prices appear either in millions (6.2) or tenths (62). Normalise to tenths. */
export function normalisePrice(value: number | null): number | null {
  if (value === null) return null;
  // No FPL player has ever cost under £2.0m, so a value that small must be in millions.
  return value < 25 ? Math.round(value * 10) : Math.round(value);
}

/** True when the table looks like per-gameweek rows rather than season totals. */
export function isGameweekTable(table: CsvTable): boolean {
  return table.headers.includes('gameweek') || table.headers.includes('round');
}

function normaliseName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

interface PlayerRow {
  id: number;
  webName: string;
  secondName: string | null;
  club: string;
  clubName: string;
  positionId: number;
}

export interface GameweekCsvOptions {
  /** Defaults to the season named in the file, or a sensible fallback. */
  seasonName?: string;
  /**
   * When true the rows describe the CURRENT season, so actual points are also recorded for
   * scoring projections against. Defaults to false: a file of last season is history, not a
   * result to grade this season's model on.
   */
  currentSeason?: boolean;
  label?: string;
}

export function importGameweekCsv(
  db: Database,
  text: string,
  options: GameweekCsvOptions = {},
): Promise<ImportSummary> {
  return withIngestRun(db, 'import:gameweek-csv', async () => {
    const table = toTable(text);
    if (table.rows.length === 0) throw new Error(`${options.label ?? 'This file'} has no data rows.`);

    const players = db
      .prepare(
        `SELECT p.id, p.web_name AS webName, p.second_name AS secondName,
                t.short_name AS club, t.name AS clubName, p.position_id AS positionId
         FROM player p JOIN team t ON t.id = p.team_id`,
      )
      .all() as PlayerRow[];

    if (players.length === 0) {
      throw new Error(
        "No players in the database to match against. Import this season's player data first, " +
          'then this file.',
      );
    }

    // Index by name; a player is listed under both display name and surname, deduplicated.
    const byName = new Map<string, PlayerRow[]>();
    for (const player of players) {
      for (const candidate of [player.webName, player.secondName].filter(Boolean) as string[]) {
        const key = normaliseName(candidate);
        const list = byName.get(key) ?? [];
        if (!list.some((existing) => existing.id === player.id)) list.push(player);
        byName.set(key, list);
      }
    }

    const seasonName = options.seasonName ?? pick(table.rows[0]!, 'season', 'season_name') ?? '2025/26';

    const upsert = db.prepare(`
      INSERT INTO player_gameweek_stat (
        player_id, season_name, gameweek, opponent_name, was_home, price, selected_by_percent,
        minutes, total_points, goals, assists, clean_sheet, goals_conceded,
        total_shots, shots_on_target, shots_in_box, chances_created,
        expected_goals, non_penalty_expected_goals, expected_assists,
        expected_goal_involvements, expected_goals_conceded, expected_clean_sheet,
        clearances_blocks_interceptions, recoveries, tackles, defensive_contribution,
        touches, touches_opp_box, source_expected_points, updated_at, raw_json
      ) VALUES (
        @player_id, @season_name, @gameweek, @opponent_name, @was_home, @price, @selected_by_percent,
        @minutes, @total_points, @goals, @assists, @clean_sheet, @goals_conceded,
        @total_shots, @shots_on_target, @shots_in_box, @chances_created,
        @expected_goals, @non_penalty_expected_goals, @expected_assists,
        @expected_goal_involvements, @expected_goals_conceded, @expected_clean_sheet,
        @clearances_blocks_interceptions, @recoveries, @tackles, @defensive_contribution,
        @touches, @touches_opp_box, @source_expected_points, @updated_at, @raw_json
      )
      ON CONFLICT (player_id, season_name, gameweek) DO UPDATE SET
        opponent_name = excluded.opponent_name, was_home = excluded.was_home,
        price = excluded.price, selected_by_percent = excluded.selected_by_percent,
        minutes = excluded.minutes, total_points = excluded.total_points,
        goals = excluded.goals, assists = excluded.assists,
        clean_sheet = excluded.clean_sheet, goals_conceded = excluded.goals_conceded,
        total_shots = excluded.total_shots, shots_on_target = excluded.shots_on_target,
        shots_in_box = excluded.shots_in_box, chances_created = excluded.chances_created,
        expected_goals = excluded.expected_goals,
        non_penalty_expected_goals = excluded.non_penalty_expected_goals,
        expected_assists = excluded.expected_assists,
        expected_goal_involvements = excluded.expected_goal_involvements,
        expected_goals_conceded = excluded.expected_goals_conceded,
        expected_clean_sheet = excluded.expected_clean_sheet,
        clearances_blocks_interceptions = excluded.clearances_blocks_interceptions,
        recoveries = excluded.recoveries, tackles = excluded.tackles,
        defensive_contribution = excluded.defensive_contribution,
        touches = excluded.touches, touches_opp_box = excluded.touches_opp_box,
        source_expected_points = excluded.source_expected_points,
        updated_at = excluded.updated_at, raw_json = excluded.raw_json
    `);

    const insertActual = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, ?, ?, ?, 'csv', ?)
       ON CONFLICT (player_id, event_id) DO UPDATE SET
         points = excluded.points, minutes = excluded.minutes,
         source = excluded.source, recorded_at = excluded.recorded_at`,
    );

    const at = nowSeconds();
    const unmatched = new Map<string, number>();
    const ambiguous = new Map<string, number>();
    let written = 0;
    let actuals = 0;
    const gameweeks = new Set<number>();
    const matchedPlayers = new Set<number>();

    const write = db.transaction(() => {
      for (const row of table.rows) {
        const gameweek = num(pick(row, 'gameweek', 'round', 'gw'));
        if (gameweek === null) continue;

        const name = pick(row, 'web_name', 'name', 'player_name', 'player', 'second_name');
        const club = pick(row, 'team_name', 'team', 'club', 'short_name');
        if (!name) continue;

        const candidates = byName.get(normaliseName(name)) ?? [];
        let match: PlayerRow | undefined;

        if (candidates.length === 1) {
          match = candidates[0];
        } else if (candidates.length > 1) {
          // Two players can share a name. Narrow by club, then by position - both are in the
          // file already, and using them beats discarding the row.
          let narrowed = candidates;
          if (club) {
            const clubKey = normaliseName(club);
            const byClub = narrowed.filter(
              (c) => normaliseName(c.club) === clubKey || normaliseName(c.clubName) === clubKey,
            );
            if (byClub.length > 0) narrowed = byClub;
          }
          if (narrowed.length > 1) {
            const positionId = num(pick(row, 'element_type', 'position_id', 'position'));
            if (positionId !== null) {
              const byPosition = narrowed.filter((c) => c.positionId === positionId);
              if (byPosition.length > 0) narrowed = byPosition;
            }
          }
          if (narrowed.length === 1) match = narrowed[0];
        }

        if (!match) {
          const label = `${name}${club ? ` (${club})` : ''}`;
          if (candidates.length > 1) ambiguous.set(label, (ambiguous.get(label) ?? 0) + 1);
          else unmatched.set(label, (unmatched.get(label) ?? 0) + 1);
          continue;
        }

        matchedPlayers.add(match.id);
        gameweeks.add(gameweek);

        const points = num(pick(row, 'total_points', 'points', 'pts'));
        const minutes = num(pick(row, 'minutes', 'mins'));

        upsert.run({
          player_id: match.id,
          season_name: seasonName,
          gameweek,
          opponent_name: pick(row, 'opponent_team_name', 'opponent', 'opponent_team') ?? null,
          was_home: (() => {
            const raw = pick(row, 'was_home', 'home');
            if (raw === undefined) return null;
            return toSqliteBool(/^(true|1|yes|h)$/i.test(raw));
          })(),
          price: normalisePrice(num(pick(row, 'now_cost', 'price', 'value', 'cost'))),
          selected_by_percent: num(pick(row, 'selected_by_percent', 'ownership', 'selected')),
          minutes,
          total_points: points,
          goals: num(pick(row, 'goals', 'goals_scored')),
          assists: num(pick(row, 'assists')),
          clean_sheet: num(pick(row, 'clean_sheet', 'clean_sheets', 'cs')),
          goals_conceded: num(pick(row, 'goals_conceded', 'gc')),
          total_shots: num(pick(row, 'total_shots', 'shots')),
          shots_on_target: num(pick(row, 'shots_on_target', 'sot')),
          shots_in_box: num(pick(row, 'shots_in_box')),
          chances_created: num(pick(row, 'chances_created', 'key_passes')),
          expected_goals: num(pick(row, 'expected_goals', 'xg')),
          non_penalty_expected_goals: num(pick(row, 'non_penalty_expected_goals', 'npxg')),
          expected_assists: num(pick(row, 'expected_assists', 'xa')),
          expected_goal_involvements: num(pick(row, 'expected_goal_involvements', 'xgi')),
          expected_goals_conceded: num(pick(row, 'expected_goals_conceded', 'xgc')),
          expected_clean_sheet: num(pick(row, 'expected_clean_sheet', 'xcs')),
          clearances_blocks_interceptions: num(
            pick(row, 'clearances_blocks_interceptions', 'cbi'),
          ),
          recoveries: num(pick(row, 'recoveries')),
          tackles: num(pick(row, 'tackles')),
          defensive_contribution: num(pick(row, 'defensive_contribution', 'defcon')),
          touches: num(pick(row, 'touches')),
          touches_opp_box: num(pick(row, 'touches_opp_box')),
          source_expected_points: num(pick(row, 'expected_points', 'xp', 'xpts')),
          updated_at: at,
          raw_json: JSON.stringify(row),
        });
        written += 1;

        if (options.currentSeason && points !== null) {
          insertActual.run(match.id, gameweek, points, minutes, at);
          actuals += 1;
        }
      }
    });

    write();

    const warnings: string[] = [];
    if (unmatched.size > 0) {
      const worst = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      warnings.push(
        `${unmatched.size} player name(s) matched nobody in the database and were skipped ` +
          `(${worst.map(([n, c]) => `${n} ×${c}`).join('; ')}${unmatched.size > 8 ? ' ...' : ''}). ` +
          'Players who left the league since that season will not match, which is expected.',
      );
    }
    if (ambiguous.size > 0) {
      const worst = [...ambiguous.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      warnings.push(
        `${ambiguous.size} name(s) matched more than one player and were skipped ` +
          `(${worst.map(([n, c]) => `${n} ×${c}`).join('; ')}).`,
      );
    }

    // Roll the per-gameweek rows up into season totals, which is what the projection model
    // reads when a player has no minutes in the current season.
    const aggregated = aggregateToSeasonHistory(db, seasonName);

    return {
      kind: 'season-csv' as const,
      rowsWritten: written,
      fromCache: false,
      detail:
        `${written} gameweek row(s) for ${matchedPlayers.size} players across ` +
        `${gameweeks.size} gameweek(s) of ${seasonName}` +
        (aggregated > 0 ? `, rolled up into ${aggregated} season totals` : '') +
        (actuals > 0 ? `, ${actuals} actual scores recorded` : ''),
      warnings,
    };
  });
}

/**
 * Roll per-gameweek rows into the season-totals table the projection model reads.
 *
 * Done as a single SQL aggregate rather than in application code: it is one pass over the data
 * and cannot drift from what was imported.
 */
export function aggregateToSeasonHistory(db: Database, seasonName: string): number {
  const result = db
    .prepare(
      `INSERT INTO player_season_history (
         player_id, season_name, element_code, start_cost, end_cost, total_points, minutes,
         starts, goals_scored, assists, clean_sheets, goals_conceded, saves, bonus, bps,
         yellow_cards, red_cards, expected_goals, expected_assists,
         expected_goal_involvements, expected_goals_conceded, defensive_contribution,
         updated_at, raw_json
       )
       SELECT
         s.player_id,
         s.season_name,
         p.code,
         NULL,
         MAX(s.price),
         SUM(COALESCE(s.total_points, 0)),
         SUM(COALESCE(s.minutes, 0)),
         -- No explicit "starts" column: a 60-minute appearance is a reliable proxy.
         SUM(CASE WHEN COALESCE(s.minutes, 0) >= 60 THEN 1 ELSE 0 END),
         SUM(COALESCE(s.goals, 0)),
         SUM(COALESCE(s.assists, 0)),
         SUM(COALESCE(s.clean_sheet, 0)),
         SUM(COALESCE(s.goals_conceded, 0)),
         NULL,
         NULL,
         NULL,
         NULL,
         NULL,
         SUM(COALESCE(s.expected_goals, 0)),
         SUM(COALESCE(s.expected_assists, 0)),
         SUM(COALESCE(s.expected_goal_involvements, 0)),
         SUM(COALESCE(s.expected_goals_conceded, 0)),
         SUM(COALESCE(s.defensive_contribution, 0)),
         ?,
         json_object('aggregatedFrom', 'player_gameweek_stat', 'gameweeks', COUNT(*))
       FROM player_gameweek_stat s
       JOIN player p ON p.id = s.player_id
       WHERE s.season_name = ?
       GROUP BY s.player_id, s.season_name
       ON CONFLICT (player_id, season_name) DO UPDATE SET
         total_points = excluded.total_points, minutes = excluded.minutes,
         starts = excluded.starts, goals_scored = excluded.goals_scored,
         assists = excluded.assists, clean_sheets = excluded.clean_sheets,
         goals_conceded = excluded.goals_conceded, end_cost = excluded.end_cost,
         expected_goals = excluded.expected_goals, expected_assists = excluded.expected_assists,
         expected_goal_involvements = excluded.expected_goal_involvements,
         expected_goals_conceded = excluded.expected_goals_conceded,
         defensive_contribution = excluded.defensive_contribution,
         updated_at = excluded.updated_at, raw_json = excluded.raw_json`,
    )
    .run(nowSeconds(), seasonName);

  return result.changes;
}
