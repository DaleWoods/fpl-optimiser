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
