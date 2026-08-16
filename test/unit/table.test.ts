import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { computeLeagueTable, tableHasResults } from '../../src/model/table.js';
import { defaultTeams, fakeBootstrap, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();

describe('league table', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
  });

  it('is empty when no clubs are loaded', () => {
    const empty = openTestDatabase();
    expect(computeLeagueTable(empty)).toEqual([]);
  });

  it('lists every club at zero before any fixture has been played', async () => {
    await ingestFixtures(
      db,
      new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2)] }),
    );

    const table = computeLeagueTable(db);
    expect(table).toHaveLength(defaultTeams().length);
    expect(table.every((row) => row.played === 0 && row.points === 0)).toBe(true);
    expect(tableHasResults(table)).toBe(false);
  });

  it('ignores fixtures that have not finished, even with scores attached', async () => {
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          fakeFixture(1, 1, 1, 2, { team_h_score: 3, team_a_score: 0, finished: false }),
        ],
      }),
    );

    const table = computeLeagueTable(db);
    expect(tableHasResults(table)).toBe(false);
    expect(table.every((row) => row.played === 0)).toBe(true);
  });

  it('scores wins, draws and losses correctly from finished results', async () => {
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          // Alpha (1) beats Beta (2) 3-0.
          fakeFixture(1, 1, 1, 2, { team_h_score: 3, team_a_score: 0, finished: true }),
          // Gamma (3) draws with Delta (4) 1-1.
          fakeFixture(2, 1, 3, 4, { team_h_score: 1, team_a_score: 1, finished: true }),
        ],
      }),
    );

    const table = computeLeagueTable(db);
    expect(tableHasResults(table)).toBe(true);

    const alpha = table.find((row) => row.short === 'ALP')!;
    expect(alpha).toMatchObject({
      played: 1, won: 1, drawn: 0, lost: 0,
      goalsFor: 3, goalsAgainst: 0, goalDifference: 3, points: 3, ppg: 3,
    });

    const beta = table.find((row) => row.short === 'BET')!;
    expect(beta).toMatchObject({
      played: 1, won: 0, drawn: 0, lost: 1,
      goalsFor: 0, goalsAgainst: 3, goalDifference: -3, points: 0, ppg: 0,
    });

    const gamma = table.find((row) => row.short === 'GAM')!;
    expect(gamma).toMatchObject({ played: 1, won: 0, drawn: 1, lost: 0, points: 1, ppg: 1 });

    const delta = table.find((row) => row.short === 'DEL')!;
    expect(delta).toMatchObject({ played: 1, won: 0, drawn: 1, lost: 0, points: 1, ppg: 1 });
  });

  it('sorts by points, then goal difference, then goals for', async () => {
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          fakeFixture(1, 1, 1, 2, { team_h_score: 3, team_a_score: 0, finished: true }),
          fakeFixture(2, 1, 3, 4, { team_h_score: 1, team_a_score: 1, finished: true }),
        ],
      }),
    );

    const table = computeLeagueTable(db);
    expect(table[0]!.short).toBe('ALP');
    expect(table[0]!.position).toBe(1);
    // Gamma and Delta are level on points and GD; both drew 1-1, so goals for ties them too -
    // the final tiebreak is name, and Delta Town sorts after Gamma City.
    const midTable = table.slice(1, 3).map((row) => row.short);
    expect(midTable).toEqual(['DEL', 'GAM']);
    expect(table[3]!.short).toBe('BET');
  });

  it('accumulates across multiple gameweeks for the same club', async () => {
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [
          fakeFixture(1, 1, 1, 2, { team_h_score: 2, team_a_score: 1, finished: true }),
          fakeFixture(2, 2, 2, 1, { team_h_score: 0, team_a_score: 0, finished: true }),
        ],
      }),
    );

    const table = computeLeagueTable(db);
    const alpha = table.find((row) => row.short === 'ALP')!;
    expect(alpha).toMatchObject({ played: 2, won: 1, drawn: 1, lost: 0, points: 4, ppg: 2 });
  });
});
