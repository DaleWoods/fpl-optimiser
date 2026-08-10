import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import { classifyAvailability } from '../domain/availability.js';
import type { ProjectedPlayer } from '../domain/types.js';
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

  // Every club's fixtures this gameweek: none is a blank, two is a double.
  const fixturesByTeam = new Map<number, FixtureContext[]>();
  for (const fixture of fixtures) {
    const home = teams.get(fixture.teamH);
    const away = teams.get(fixture.teamA);
    if (!home || !away) continue;

    const fallback = weights.teamStrength.fallbackStrength;

    push(fixturesByTeam, fixture.teamH, {
      teamAttack: home.attackHome ?? fallback,
      teamDefence: home.defenceHome ?? fallback,
      opponentAttack: away.attackAway ?? fallback,
      opponentDefence: away.defenceAway ?? fallback,
      isHome: true,
      opponentShort: away.shortName,
      difficulty: fixture.difficultyH,
    });

    push(fixturesByTeam, fixture.teamA, {
      teamAttack: away.attackAway ?? fallback,
      teamDefence: away.defenceAway ?? fallback,
      opponentAttack: home.attackHome ?? fallback,
      opponentDefence: home.defenceHome ?? fallback,
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

    const input: PlayerModelInput = {
      playerId: row.playerId,
      name: row.name,
      position: row.position,
      availability,
      ownership: row.ownership,
      minutesPlayed: row.minutes ?? 0,
      matchesAvailable: playedByTeam.get(row.teamId) ?? 0,
      starts: row.starts ?? 0,
      xgPer90: per90(row.expectedGoals, row.minutes),
      xaPer90: per90(row.expectedAssists, row.minutes),
      goalsPer90: per90(row.goals, row.minutes),
      assistsPer90: per90(row.assists, row.minutes),
      savesPer90: per90(row.saves, row.minutes),
      defconPer90: per90(row.defensiveContribution, row.minutes),
      bonusPer90: per90(row.bonus, row.minutes),
      fixtures: fixturesByTeam.get(row.teamId) ?? [],
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
