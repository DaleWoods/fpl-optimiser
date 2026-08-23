import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import { classifyAvailability } from '../domain/availability.js';
import type { ProjectedPlayer } from '../domain/types.js';
import { computeLeagueTable } from './table.js';
import { projectPlayer, type FixtureContext, type PlayerModelInput } from './xpts.js';

interface PlayerRow {
  playerId: number;
  name: string;
  teamId: number;
  clubShort: string;
  position: string;
  price: number;
  status: string | null;
  chanceNext: number | null;
  news: string | null;
  ownership: number | null;
  minutes: number | null;
  starts: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  bonus: number | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
  defensiveContribution: number | null;
  epNext: number | null;
}

interface TeamRow {
  id: number;
  shortName: string;
  attackHome: number | null;
  attackAway: number | null;
  defenceHome: number | null;
  defenceAway: number | null;
}

interface SeasonHistoryRow {
  playerId: number;
  seasonName: string;
  totalPoints: number | null;
  minutes: number | null;
  starts: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  bonus: number | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
  defensiveContribution: number | null;
}

interface FixtureRow {
  id: number;
  eventId: number | null;
  teamH: number;
  teamA: number;
  difficultyH: number | null;
  difficultyA: number | null;
}

/** Per-90 rate, or null when there are not enough minutes to say anything. */
function per90(total: number | null, minutes: number | null): number | null {
  if (total === null || minutes === null || minutes <= 0) return null;
  return (total / minutes) * 90;
}

/**
 * Shrink a per-90 rate toward zero in proportion to how few minutes sit behind it.
 *
 * Two goal involvements in 90 minutes is not a superstar rate, it is one good afternoon. With
 * priorWeightMinutes at 270, a 90-minute sample keeps a quarter of its face-value rate while a
 * full season keeps nearly all of it. Without this, fringe players with lucky cameos outscore
 * genuine starters in the projections - which is exactly how a 6-point season can look like a
 * must-have pick.
 */
function shrinkRate(
  rate: number | null,
  minutes: number | null,
  priorWeightMinutes: number,
): number | null {
  if (rate === null) return null;
  const mins = minutes ?? 0;
  return rate * (mins / (mins + priorWeightMinutes));
}

/**
 * Turn stored data into projections for a gameweek.
 *
 * Reads the most recent snapshot for every player, the fixtures for the gameweek, and the club
 * strength ratings, then runs each player through the model.
 */
export function buildProjections(
  db: Database,
  eventId: number,
  rules: Rules,
  weights: ModelWeights,
): ProjectedPlayer[] {
  const snapshot = db
    .prepare('SELECT id FROM snapshot ORDER BY taken_at DESC, id DESC LIMIT 1')
    .get() as { id: number } | undefined;

  if (!snapshot) return [];

  const players = db
    .prepare(
      `SELECT p.id AS playerId, p.web_name AS name, p.team_id AS teamId,
              t.short_name AS clubShort, pos.short_name AS position,
              ps.now_cost AS price, ps.status, ps.chance_of_playing_next_round AS chanceNext,
              ps.news, ps.selected_by_percent AS ownership, ps.minutes, ps.starts,
              ps.goals_scored AS goals, ps.assists, ps.saves, ps.bonus,
              ps.expected_goals AS expectedGoals, ps.expected_assists AS expectedAssists,
              ps.defensive_contribution AS defensiveContribution, ps.ep_next AS epNext
       FROM player_snapshot ps
       JOIN player p ON p.id = ps.player_id
       JOIN team t ON t.id = p.team_id
       JOIN position pos ON pos.id = p.position_id
       WHERE ps.snapshot_id = ?`,
    )
    .all(snapshot.id) as PlayerRow[];

  const teams = new Map(
    (
      db
        .prepare(
          `SELECT id, short_name AS shortName, strength_attack_home AS attackHome,
                  strength_attack_away AS attackAway, strength_defence_home AS defenceHome,
                  strength_defence_away AS defenceAway
           FROM team`,
        )
        .all() as TeamRow[]
    ).map((team) => [team.id, team]),
  );

  const fixtures = db
    .prepare(
      `SELECT id, event_id AS eventId, team_h AS teamH, team_a AS teamA,
              team_h_difficulty AS difficultyH, team_a_difficulty AS difficultyA
       FROM fixture WHERE event_id = ?`,
    )
    .all(eventId) as FixtureRow[];

  // Current league form, blended into club strength. Computed from imported fixture results,
  // so it needs no separate upload and updates the moment results land. Bounded so a hot start
  // nudges rather than dominates the API's own strength ratings.
  const strengthAdjust = new Map<number, number>();
  if (weights.teamStrength.tableWeight > 0) {
    const table = computeLeagueTable(db);
    const played = table.filter((row) => row.played > 0);
    if (played.length > 0) {
      const averagePpg =
        played.reduce((sum, row) => sum + row.ppg, 0) / played.length || 1;
      for (const row of played) {
        const factor = (row.ppg > 0 ? row.ppg / averagePpg : 0.5) ** weights.teamStrength.tableWeight;
        strengthAdjust.set(row.teamId, Math.min(1.3, Math.max(0.7, factor)));
      }
    }
  }
  const adjustFor = (teamId: number): number => strengthAdjust.get(teamId) ?? 1;

  // Every club's fixtures this gameweek: none is a blank, two is a double.
  const fixturesByTeam = new Map<number, FixtureContext[]>();
  for (const fixture of fixtures) {
    const home = teams.get(fixture.teamH);
    const away = teams.get(fixture.teamA);
    if (!home || !away) continue;

    const fallback = weights.teamStrength.fallbackStrength;

    push(fixturesByTeam, fixture.teamH, {
      teamAttack: (home.attackHome ?? fallback) * adjustFor(fixture.teamH),
      teamDefence: (home.defenceHome ?? fallback) * adjustFor(fixture.teamH),
      opponentAttack: (away.attackAway ?? fallback) * adjustFor(fixture.teamA),
      opponentDefence: (away.defenceAway ?? fallback) * adjustFor(fixture.teamA),
      isHome: true,
      opponentShort: away.shortName,
      difficulty: fixture.difficultyH,
    });

    push(fixturesByTeam, fixture.teamA, {
      teamAttack: (away.attackAway ?? fallback) * adjustFor(fixture.teamA),
      teamDefence: (away.defenceAway ?? fallback) * adjustFor(fixture.teamA),
      opponentAttack: (home.attackHome ?? fallback) * adjustFor(fixture.teamH),
      opponentDefence: (home.defenceHome ?? fallback) * adjustFor(fixture.teamH),
      isHome: false,
      opponentShort: home.shortName,
      difficulty: fixture.difficultyA,
    });
  }

  // How many matches each club has already played, as the denominator for start rate.
  const playedByTeam = new Map<number, number>();
  for (const row of db
    .prepare(
      `SELECT team_h AS h, team_a AS a FROM fixture WHERE finished = 1`,
    )
    .all() as { h: number; a: number }[]) {
    playedByTeam.set(row.h, (playedByTeam.get(row.h) ?? 0) + 1);
    playedByTeam.set(row.a, (playedByTeam.get(row.a) ?? 0) + 1);
  }

  // Last completed season per player, for opening-gameweek projections when this season has
  // no minutes yet. Sorted so the most recent season wins.
  const lastSeason = new Map<number, SeasonHistoryRow>();
  for (const row of db
    .prepare(
      `SELECT player_id AS playerId, season_name AS seasonName, total_points AS totalPoints,
              minutes, starts, goals_scored AS goals, assists, saves, bonus,
              expected_goals AS expectedGoals, expected_assists AS expectedAssists,
              defensive_contribution AS defensiveContribution
       FROM player_season_history ORDER BY season_name ASC`,
    )
    .all() as SeasonHistoryRow[]) {
    lastSeason.set(row.playerId, row);
  }

  const projected: ProjectedPlayer[] = [];

  for (const row of players) {
    const availability = classifyAvailability(
      {
        status: row.status,
        chanceOfPlayingNextRound: row.chanceNext,
        news: row.news,
      },
      weights,
    );

    // This season's minutes decide which evidence to use. With none *and* the season not yet
    // underway, last season's rates are the best real signal there is. But once this player's
    // club has actually played and he still has zero minutes, that zero is not an absence of
    // evidence any more - it is evidence, and usually strong evidence he is not first-choice.
    // Falling back to last season's rate here was the bug behind a nailed-on-bench player (or a
    // summer signing behind an established starter) getting picked on the strength of a start
    // rate that no longer applies: it kept re-consulting a stale prior instead of ever letting
    // this season's zero starts speak for themselves.
    const seasonUnderway = (playedByTeam.get(row.teamId) ?? 0) > 0;
    const previous =
      (row.minutes ?? 0) > 0 || seasonUnderway ? undefined : lastSeason.get(row.playerId);
    const usingPrevious = previous !== undefined && (previous.minutes ?? 0) > 0;

    const source = usingPrevious ? previous : row;
    const sourceMinutes = usingPrevious ? previous.minutes : row.minutes;

    // Previous-season rates are shrunk by their sample size: a per-90 from 90 minutes keeps a
    // quarter of its face value, a full season keeps nearly all of it. This is what stops a
    // player with one lucky cameo outscoring genuine starters. Defcon is a stable volume stat
    // and keeps the same treatment for consistency.
    const priorMins = weights.attacking.priorWeightMinutes;
    const rate = (total: number | null): number | null =>
      usingPrevious
        ? shrinkRate(per90(total, sourceMinutes), sourceMinutes, priorMins)
        : per90(total, sourceMinutes);

    const input: PlayerModelInput = {
      playerId: row.playerId,
      name: row.name,
      position: row.position,
      availability,
      ownership: row.ownership,
      minutesPlayed: row.minutes ?? 0,
      matchesAvailable: usingPrevious
        ? Math.round((previous.minutes ?? 0) / 90)
        : (playedByTeam.get(row.teamId) ?? 0),
      starts: usingPrevious ? (previous.starts ?? 0) : (row.starts ?? 0),
      xgPer90: rate(source.expectedGoals),
      xaPer90: rate(source.expectedAssists),
      goalsPer90: rate(source.goals),
      assistsPer90: rate(source.assists),
      savesPer90: rate(source.saves),
      defconPer90: rate(source.defensiveContribution),
      bonusPer90: rate(source.bonus),
      fixtures: fixturesByTeam.get(row.teamId) ?? [],
      usingPreviousSeason: usingPrevious,
      previousSeasonName: usingPrevious ? previous.seasonName : null,
      previousSeasonPoints: usingPrevious ? previous.totalPoints : null,
      previousSeasonMinutes: usingPrevious ? previous.minutes : null,
      fallbackExpectedPoints: row.epNext,
    };

    const projection = projectPlayer(input, weights, rules);

    projected.push({
      playerId: row.playerId,
      name: row.name,
      clubId: row.teamId,
      clubShort: row.clubShort,
      position: row.position,
      price: row.price,
      availability,
      xPts: projection.xPts,
      xPtsRaw: projection.xPtsRaw,
      breakdown: projection.breakdown,
      expectedMinutes: projection.expectedMinutes,
      confidence: projection.confidence,
      reasons: projection.reasons,
      fixtures: input.fixtures.map((fixture) => ({
        opponentShort: fixture.opponentShort,
        isHome: fixture.isHome,
        difficulty: fixture.difficulty,
      })),
    });
  }

  return projected;
}

/** Store projections so past advice can be reviewed against what actually happened. */
export function saveProjections(
  db: Database,
  projections: readonly ProjectedPlayer[],
  eventId: number,
  modelVersion: string,
): void {
  const createdAt = Math.floor(Date.now() / 1000);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO projection (
       player_id, event_id, model_version, created_at, xpts, xpts_raw,
       availability_probability, expected_minutes, fixture_count, confidence, breakdown_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const write = db.transaction(() => {
    for (const projection of projections) {
      insert.run(
        projection.playerId,
        eventId,
        modelVersion,
        createdAt,
        projection.xPts,
        projection.xPtsRaw,
        projection.availability.probability,
        projection.expectedMinutes,
        1,
        projection.confidence,
        JSON.stringify(projection.breakdown),
      );
    }
  });

  write();
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
