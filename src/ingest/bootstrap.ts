import type { Database } from 'better-sqlite3';
import type { FplApi } from '../api/client.js';
import type { ApiElement, Bootstrap } from '../api/schemas.js';
import { reconcilePositions } from '../config/load.js';
import type { Rules } from '../config/schema.js';
import { isoToUnix, nowSeconds, toSqliteBool } from '../db/index.js';
import { withIngestRun } from './run.js';

export interface BootstrapIngestResult {
  snapshotId: number;
  rowsWritten: number;
  fromCache: boolean;
  fetchedAt: number;
  changes: DetectedChange[];
}

export interface DetectedChange {
  playerId: number;
  kind: 'price' | 'status' | 'news' | 'chance';
  before: string | null;
  after: string | null;
  note: string;
}

/** The fields of the previous snapshot that change detection compares against. */
interface PreviousState {
  player_id: number;
  now_cost: number;
  status: string;
  news: string | null;
  chance_of_playing_next_round: number | null;
}

function priceLabel(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}

/**
 * Compare this snapshot against the previous one and describe what moved.
 *
 * This is what powers "a starter just got injured" and "a price is about to drop": the API
 * only ever states the present, so trend and change have to be derived from our own history.
 */
export function detectChanges(
  previous: Map<number, PreviousState>,
  elements: readonly ApiElement[],
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  for (const element of elements) {
    const before = previous.get(element.id);
    if (!before) continue; // A new player has nothing to compare against.

    if (before.now_cost !== element.now_cost) {
      const direction = element.now_cost > before.now_cost ? 'rose' : 'fell';
      changes.push({
        playerId: element.id,
        kind: 'price',
        before: String(before.now_cost),
        after: String(element.now_cost),
        note: `Price ${direction} from ${priceLabel(before.now_cost)} to ${priceLabel(element.now_cost)}`,
      });
    }

    if (before.status !== element.status) {
      changes.push({
        playerId: element.id,
        kind: 'status',
        before: before.status,
        after: element.status,
        note: `Availability status changed from '${before.status}' to '${element.status}'`,
      });
    }

    const beforeChance = before.chance_of_playing_next_round;
    const afterChance = element.chance_of_playing_next_round;
    if (beforeChance !== afterChance) {
      changes.push({
        playerId: element.id,
        kind: 'chance',
        before: beforeChance === null ? null : String(beforeChance),
        after: afterChance === null ? null : String(afterChance),
        note: `Chance of playing changed from ${beforeChance ?? 'unstated'} to ${afterChance ?? 'unstated'}`,
      });
    }

    const beforeNews = before.news ?? '';
    const afterNews = element.news ?? '';
    if (beforeNews !== afterNews && afterNews !== '') {
      changes.push({
        playerId: element.id,
        kind: 'news',
        before: beforeNews || null,
        after: afterNews,
        note: `News: ${afterNews}`,
      });
    }
  }

  return changes;
}

/**
 * Ingest bootstrap-static: positions, teams, gameweeks, players, and a full player snapshot.
 *
 * Reference rows are upserted; the snapshot is append-only. Positions are reconciled against
 * config here - this is the one place config's view of the world meets the live API's, and a
 * mismatch must stop the run rather than quietly skew every projection downstream.
 */
export async function ingestBootstrap(
  db: Database,
  api: FplApi,
  rules: Rules,
): Promise<BootstrapIngestResult> {
  return withIngestRun(db, 'bootstrap-static', async () => {
    const { data, fetchedAt, fromCache } = await api.bootstrap();
    return ingestBootstrapPayload(db, data, rules, { fetchedAt, fromCache });
  });
}

export function ingestBootstrapPayload(
  db: Database,
  data: Bootstrap,
  rules: Rules,
  meta: { fetchedAt: number; fromCache: boolean },
): BootstrapIngestResult {
  reconcilePositions(
    rules,
    data.element_types.map((type) => type.singular_name_short),
  );

  const at = nowSeconds();
  let rowsWritten = 0;

  // The previous snapshot, read before the new one is written, for change detection.
  const previousSnapshot = db
    .prepare('SELECT id FROM snapshot ORDER BY taken_at DESC, id DESC LIMIT 1')
    .get() as { id: number } | undefined;

  const previous = new Map<number, PreviousState>();
  if (previousSnapshot) {
    const rows = db
      .prepare(
        `SELECT player_id, now_cost, status, news, chance_of_playing_next_round
         FROM player_snapshot WHERE snapshot_id = ?`,
      )
      .all(previousSnapshot.id) as PreviousState[];
    for (const row of rows) previous.set(row.player_id, row);
  }

  const changes = detectChanges(previous, data.elements);

  const upsertPosition = db.prepare(`
    INSERT INTO position (id, short_name, singular_name, plural_name, squad_select,
                          squad_min_play, squad_max_play, element_count, updated_at, raw_json)
    VALUES (@id, @short_name, @singular_name, @plural_name, @squad_select,
            @squad_min_play, @squad_max_play, @element_count, @updated_at, @raw_json)
    ON CONFLICT (id) DO UPDATE SET
      short_name = excluded.short_name, singular_name = excluded.singular_name,
      plural_name = excluded.plural_name, squad_select = excluded.squad_select,
      squad_min_play = excluded.squad_min_play, squad_max_play = excluded.squad_max_play,
      element_count = excluded.element_count, updated_at = excluded.updated_at,
      raw_json = excluded.raw_json
  `);

  const upsertTeam = db.prepare(`
    INSERT INTO team (id, code, name, short_name, strength, strength_overall_home,
                      strength_overall_away, strength_attack_home, strength_attack_away,
                      strength_defence_home, strength_defence_away, updated_at, raw_json)
    VALUES (@id, @code, @name, @short_name, @strength, @strength_overall_home,
            @strength_overall_away, @strength_attack_home, @strength_attack_away,
            @strength_defence_home, @strength_defence_away, @updated_at, @raw_json)
    ON CONFLICT (id) DO UPDATE SET
      code = excluded.code, name = excluded.name, short_name = excluded.short_name,
      strength = excluded.strength, strength_overall_home = excluded.strength_overall_home,
      strength_overall_away = excluded.strength_overall_away,
      strength_attack_home = excluded.strength_attack_home,
      strength_attack_away = excluded.strength_attack_away,
      strength_defence_home = excluded.strength_defence_home,
      strength_defence_away = excluded.strength_defence_away,
      updated_at = excluded.updated_at, raw_json = excluded.raw_json
  `);

  const upsertEvent = db.prepare(`
    INSERT INTO event (id, name, deadline_time_iso, deadline_time, is_current, is_next,
                       is_previous, finished, data_checked, average_score, highest_score,
                       updated_at, raw_json)
    VALUES (@id, @name, @deadline_time_iso, @deadline_time, @is_current, @is_next,
            @is_previous, @finished, @data_checked, @average_score, @highest_score,
            @updated_at, @raw_json)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, deadline_time_iso = excluded.deadline_time_iso,
      deadline_time = excluded.deadline_time, is_current = excluded.is_current,
      is_next = excluded.is_next, is_previous = excluded.is_previous,
      finished = excluded.finished, data_checked = excluded.data_checked,
      average_score = excluded.average_score, highest_score = excluded.highest_score,
      updated_at = excluded.updated_at, raw_json = excluded.raw_json
  `);

  const upsertPlayer = db.prepare(`
    INSERT INTO player (id, code, web_name, first_name, second_name, team_id, position_id, updated_at)
    VALUES (@id, @code, @web_name, @first_name, @second_name, @team_id, @position_id, @updated_at)
    ON CONFLICT (id) DO UPDATE SET
      code = excluded.code, web_name = excluded.web_name, first_name = excluded.first_name,
      second_name = excluded.second_name, team_id = excluded.team_id,
      position_id = excluded.position_id, updated_at = excluded.updated_at
  `);

  const insertSnapshot = db.prepare(
    'INSERT INTO snapshot (taken_at, current_event_id, next_event_id) VALUES (?, ?, ?)',
  );

  const insertPlayerSnapshot = db.prepare(`
    INSERT INTO player_snapshot (
      snapshot_id, player_id, taken_at, now_cost, cost_change_start, cost_change_event,
      status, chance_of_playing_this_round, chance_of_playing_next_round, news, news_added_iso,
      form, points_per_game, total_points, selected_by_percent, ep_this, ep_next,
      minutes, starts, goals_scored, assists, clean_sheets, goals_conceded, saves, bonus, bps,
      yellow_cards, red_cards, expected_goals, expected_assists, expected_goal_involvements,
      expected_goals_conceded, defensive_contribution, transfers_in_event, transfers_out_event,
      raw_json
    ) VALUES (
      @snapshot_id, @player_id, @taken_at, @now_cost, @cost_change_start, @cost_change_event,
      @status, @chance_of_playing_this_round, @chance_of_playing_next_round, @news, @news_added_iso,
      @form, @points_per_game, @total_points, @selected_by_percent, @ep_this, @ep_next,
      @minutes, @starts, @goals_scored, @assists, @clean_sheets, @goals_conceded, @saves, @bonus, @bps,
      @yellow_cards, @red_cards, @expected_goals, @expected_assists, @expected_goal_involvements,
      @expected_goals_conceded, @defensive_contribution, @transfers_in_event, @transfers_out_event,
      @raw_json
    )
  `);

  const insertChange = db.prepare(
    'INSERT INTO change_log (detected_at, player_id, kind, before_value, after_value, note) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const currentEvent = data.events.find((event) => event.is_current);
  const nextEvent = data.events.find((event) => event.is_next);

  const write = db.transaction((): number => {
    for (const type of data.element_types) {
      upsertPosition.run({
        id: type.id,
        short_name: type.singular_name_short,
        singular_name: type.singular_name,
        plural_name: type.plural_name,
        squad_select: type.squad_select,
        squad_min_play: type.squad_min_play,
        squad_max_play: type.squad_max_play,
        element_count: type.element_count,
        updated_at: at,
        raw_json: JSON.stringify(type),
      });
    }

    for (const team of data.teams) {
      upsertTeam.run({
        id: team.id,
        code: team.code,
        name: team.name,
        short_name: team.short_name,
        strength: team.strength,
        strength_overall_home: team.strength_overall_home,
        strength_overall_away: team.strength_overall_away,
        strength_attack_home: team.strength_attack_home,
        strength_attack_away: team.strength_attack_away,
        strength_defence_home: team.strength_defence_home,
        strength_defence_away: team.strength_defence_away,
        updated_at: at,
        raw_json: JSON.stringify(team),
      });
    }

    for (const event of data.events) {
      upsertEvent.run({
        id: event.id,
        name: event.name,
        deadline_time_iso: event.deadline_time,
        deadline_time: isoToUnix(event.deadline_time),
        is_current: toSqliteBool(event.is_current),
        is_next: toSqliteBool(event.is_next),
        is_previous: toSqliteBool(event.is_previous),
        finished: toSqliteBool(event.finished),
        data_checked: toSqliteBool(event.data_checked),
        average_score: event.average_entry_score,
        highest_score: event.highest_score,
        updated_at: at,
        raw_json: JSON.stringify(event),
      });
    }

    for (const element of data.elements) {
      upsertPlayer.run({
        id: element.id,
        code: element.code,
        web_name: element.web_name,
        first_name: element.first_name,
        second_name: element.second_name,
        team_id: element.team,
        position_id: element.element_type,
        updated_at: at,
      });
    }

    const snapshotInfo = insertSnapshot.run(
      meta.fetchedAt,
      currentEvent?.id ?? null,
      nextEvent?.id ?? null,
    );
    const snapshotId = Number(snapshotInfo.lastInsertRowid);

    for (const element of data.elements) {
      insertPlayerSnapshot.run({
        snapshot_id: snapshotId,
        player_id: element.id,
        taken_at: meta.fetchedAt,
        now_cost: element.now_cost,
        cost_change_start: element.cost_change_start,
        cost_change_event: element.cost_change_event,
        status: element.status,
        chance_of_playing_this_round: element.chance_of_playing_this_round,
        chance_of_playing_next_round: element.chance_of_playing_next_round,
        news: element.news,
        news_added_iso: element.news_added,
        form: element.form,
        points_per_game: element.points_per_game,
        total_points: element.total_points,
        selected_by_percent: element.selected_by_percent,
        ep_this: element.ep_this,
        ep_next: element.ep_next,
        minutes: element.minutes,
        starts: element.starts,
        goals_scored: element.goals_scored,
        assists: element.assists,
        clean_sheets: element.clean_sheets,
        goals_conceded: element.goals_conceded,
        saves: element.saves,
        bonus: element.bonus,
        bps: element.bps,
        yellow_cards: element.yellow_cards,
        red_cards: element.red_cards,
        expected_goals: element.expected_goals,
        expected_assists: element.expected_assists,
        expected_goal_involvements: element.expected_goal_involvements,
        expected_goals_conceded: element.expected_goals_conceded,
        defensive_contribution: element.defensive_contribution,
        transfers_in_event: element.transfers_in_event,
        transfers_out_event: element.transfers_out_event,
        raw_json: JSON.stringify(element),
      });
    }

    for (const change of changes) {
      insertChange.run(at, change.playerId, change.kind, change.before, change.after, change.note);
    }

    return snapshotId;
  });

  const snapshotId = write();
  rowsWritten =
    data.element_types.length + data.teams.length + data.events.length + data.elements.length * 2;

  return {
    snapshotId,
    rowsWritten,
    fromCache: meta.fromCache,
    fetchedAt: meta.fetchedAt,
    changes,
  };
}
