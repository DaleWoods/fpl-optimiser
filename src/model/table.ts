import type { Database } from 'better-sqlite3';

/**
 * The current league table, computed from imported fixture results.
 *
 * No separate upload is needed: the fixtures file already carries scores once matches finish,
 * so the table updates the moment a fresh fixtures file lands. Pre-season it is simply empty.
 * The table feeds back into projections as a bounded adjustment to club strength
 * (weights.teamStrength.tableWeight), so a club's actual form counts alongside the API's own
 * strength ratings.
 */

export interface LeagueTableRow {
  position: number;
  teamId: number;
  name: string;
  short: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  /** Points per game - the number the strength blend actually uses. */
  ppg: number;
}

export function computeLeagueTable(db: Database): LeagueTableRow[] {
  const teams = db.prepare('SELECT id, name, short_name AS short FROM team').all() as {
    id: number;
    name: string;
    short: string;
  }[];
  if (teams.length === 0) return [];

  const rows = new Map<number, LeagueTableRow>(
    teams.map((team) => [
      team.id,
      {
        position: 0,
        teamId: team.id,
        name: team.name,
        short: team.short,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0,
        ppg: 0,
      },
    ]),
  );

  const results = db
    .prepare(
      `SELECT team_h AS h, team_a AS a, team_h_score AS hs, team_a_score AS "as"
       FROM fixture
       WHERE finished = 1 AND team_h_score IS NOT NULL AND team_a_score IS NOT NULL`,
    )
    .all() as { h: number; a: number; hs: number; as: number }[];

  for (const result of results) {
    const home = rows.get(result.h);
    const away = rows.get(result.a);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.goalsFor += result.hs;
    home.goalsAgainst += result.as;
    away.goalsFor += result.as;
    away.goalsAgainst += result.hs;

    if (result.hs > result.as) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else if (result.hs < result.as) {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
    }
  }

  const table = [...rows.values()];
  for (const row of table) {
    row.goalDifference = row.goalsFor - row.goalsAgainst;
    row.ppg = row.played > 0 ? Math.round((row.points / row.played) * 100) / 100 : 0;
  }

  table.sort(
    (a, b) =>
      b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor ||
      a.name.localeCompare(b.name),
  );
  table.forEach((row, index) => {
    row.position = index + 1;
  });

  return table;
}

/** True when at least one result has been played - i.e. the table means something. */
export function tableHasResults(table: LeagueTableRow[]): boolean {
  return table.some((row) => row.played > 0);
}

/** A club's attacking and defensive output per match, and what it was measured from. */
export interface TeamForm {
  teamId: number;
  matches: number;
  forPerMatch: number;
  againstPerMatch: number;
  /** 'xg' whenever underlying numbers exist; 'goals' until element-summary catches up. */
  basis: 'xg' | 'goals';
}

/**
 * What each club's recent matches say about it, separately for attack and defence.
 *
 * The form adjustment used to run on points per game, which is the most luck-exposed metric in
 * the game: three narrow wins and three heavy defeats produce the same nine points as six
 * comfortable ones, and a defence that has conceded nothing off five expected goals against
 * reads, on points alone, as the best in the league. It was also a single number, so it moved a
 * club's attack and defence ratings together - a side scoring freely while leaking badly could
 * not be described at all.
 *
 * Expected goals fix both. They stabilise far faster than results, which is exactly the reason
 * the player model already prefers them (attacking.xgWeight); this applies the same belief to
 * clubs, where it had never been applied.
 *
 * Goals are the fallback, not an equal option. Results land the moment a match finishes, while
 * expected goals arrive with the per-player histories a little later, so there is a window each
 * week where results are all there is. Falling back keeps the attack/defence split - which is an
 * improvement on points per game regardless of metric - rather than going blind until the
 * underlying numbers catch up. Each basis is compared against its own league average, since the
 * two are not on the same scale.
 */
export function computeTeamForm(db: Database): Map<number, TeamForm> {
  // xG for sums across a club's players, because each player's xG is their own shots. xG against
  // takes the maximum: expected_goals_conceded is a whole-team figure recorded against every
  // player on the pitch, so summing it would multiply one match's xGA by eleven.
  const expected = db
    .prepare(
      `SELECT teamId, COUNT(*) AS matches,
              AVG(xgFor) AS forPerMatch, AVG(xgAgainst) AS againstPerMatch
       FROM (
         SELECT p.team_id AS teamId, h.fixture_id AS fixtureId,
                SUM(COALESCE(h.expected_goals, 0)) AS xgFor,
                MAX(COALESCE(h.expected_goals_conceded, 0)) AS xgAgainst
         FROM player_fixture_history h
         JOIN player p ON p.id = h.player_id
         WHERE h.event_id IS NOT NULL
         GROUP BY p.team_id, h.fixture_id
       )
       GROUP BY teamId`,
    )
    .all() as { teamId: number; matches: number; forPerMatch: number; againstPerMatch: number }[];

  const scored = db
    .prepare(
      `SELECT teamId, COUNT(*) AS matches,
              AVG(scoredFor) AS forPerMatch, AVG(scoredAgainst) AS againstPerMatch
       FROM (
         SELECT team_h AS teamId, team_h_score AS scoredFor, team_a_score AS scoredAgainst
         FROM fixture WHERE finished = 1 AND team_h_score IS NOT NULL AND team_a_score IS NOT NULL
         UNION ALL
         SELECT team_a AS teamId, team_a_score AS scoredFor, team_h_score AS scoredAgainst
         FROM fixture WHERE finished = 1 AND team_h_score IS NOT NULL AND team_a_score IS NOT NULL
       )
       GROUP BY teamId`,
    )
    .all() as { teamId: number; matches: number; forPerMatch: number; againstPerMatch: number }[];

  const form = new Map<number, TeamForm>();
  for (const row of scored) {
    if (row.matches > 0) form.set(row.teamId, { ...row, basis: 'goals' });
  }
  // Expected goals win wherever they exist.
  for (const row of expected) {
    if (row.matches > 0 && row.forPerMatch + row.againstPerMatch > 0) {
      form.set(row.teamId, { ...row, basis: 'xg' });
    }
  }
  return form;
}
