import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase, nowSeconds } from '../../src/db/index.js';
import { importPayload } from '../../src/ingest/import.js';
import { importGameweekCsv, isGameweekTable, normalisePrice } from '../../src/ingest/gameweekCsv.js';
import { toTable } from '../../src/ingest/csv.js';
import { ingestBootstrap } from '../../src/ingest/index.js';
import {
  bestElevenByActual,
  evaluateGameweek,
  evaluateSeason,
  previousRecommendationDetail,
  recordGameweekResult,
  saveRecommendation,
} from '../../src/model/accuracy.js';
import { fakeBootstrap, fakeEvent, defaultPlayers } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

/** A per-gameweek CSV in the same shape as a real stats export. */
function gameweekCsv(
  rows: { name: string; team: string; gw: number; points: number; minutes?: number }[],
  options: { season?: string } = {},
): string {
  const seasonColumn = options.season !== undefined ? ',season' : '';
  const header =
    'id,element_type,web_name,team_name,opponent_team_name,was_home,now_cost,selected_by_percent,' +
    'gameweek,minutes,expected_goals,goals,expected_assists,assists,expected_goals_conceded,' +
    `goals_conceded,clean_sheet,defensive_contribution,expected_points,total_points${seasonColumn}`;
  const body = rows
    .map(
      (r, i) =>
        `${i + 1},3,${r.name},${r.team},Other,True,6.2,10.0,${r.gw},${r.minutes ?? 90},` +
        `0.3,0,0.2,0,1.1,1,0,4,3.5,${r.points}` +
        (options.season !== undefined ? `,${options.season}` : ''),
    )
    .join('\n');
  return `${header}\n${body}`;
}

describe('per-gameweek CSV detection and units', () => {
  it('tells per-gameweek rows from season totals by the gameweek column', () => {
    expect(isGameweekTable(toTable('name,gameweek,total_points\nA,1,6'))).toBe(true);
    expect(isGameweekTable(toTable('name,total_points\nA,180'))).toBe(false);
  });

  it('normalises prices whether they arrive in millions or tenths', () => {
    // Real exports use both. £6.2m and 62 are the same price.
    expect(normalisePrice(6.2)).toBe(62);
    expect(normalisePrice(62)).toBe(62);
    expect(normalisePrice(14.5)).toBe(145);
    expect(normalisePrice(null)).toBeNull();
  });
});

describe('importing a per-gameweek CSV', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
  });

  it('stores one row per player per gameweek', async () => {
    const csv = gameweekCsv([
      { name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 6 },
      { name: 'ALP-MD1', team: 'Alpha FC', gw: 2, points: 2 },
      { name: 'ALP-MD2', team: 'Alpha FC', gw: 1, points: 9 },
    ]);
    const summary = await importPayload(db, rules, csv, { sourceLabel: 'stats.csv' });

    expect(summary.detail).toMatch(/3 gameweek row\(s\)/);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM player_gameweek_stat').get() as { n: number };
    expect(rows.n).toBe(3);
  });

  it('rolls the gameweeks up into season totals the model can use', async () => {
    const csv = gameweekCsv([
      { name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 6, minutes: 90 },
      { name: 'ALP-MD1', team: 'Alpha FC', gw: 2, points: 4, minutes: 80 },
    ]);
    await importPayload(db, rules, csv);

    const total = db
      .prepare(
        `SELECT h.total_points AS pts, h.minutes AS mins, h.starts
         FROM player_season_history h JOIN player p ON p.id = h.player_id
         WHERE p.web_name = 'ALP-MD1'`,
      )
      .get() as { pts: number; mins: number; starts: number };

    expect(total.pts).toBe(10);
    expect(total.mins).toBe(170);
    expect(total.starts).toBe(2);
  });

  it('does NOT match on the file\'s player ids, which move between seasons', async () => {
    // The CSV's id column counts from 1. If it were trusted, these rows would be attributed to
    // whichever players happen to hold ids 1 and 2 this season - silently, and wrongly.
    const csv = gameweekCsv([{ name: 'ALP-FW1', team: 'Alpha FC', gw: 1, points: 12 }]);
    await importPayload(db, rules, csv);

    const row = db
      .prepare(
        `SELECT p.web_name AS name FROM player_gameweek_stat s
         JOIN player p ON p.id = s.player_id`,
      )
      .get() as { name: string };

    expect(row.name).toBe('ALP-FW1');
  });

  it('reports names that match nobody rather than dropping them silently', async () => {
    const csv = gameweekCsv([
      { name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 6 },
      { name: 'Departed Player', team: 'Old Club', gw: 1, points: 3 },
    ]);
    const summary = await importPayload(db, rules, csv);

    expect(summary.warnings.join(' ')).toMatch(/Departed Player/);
    expect(summary.warnings.join(' ')).toMatch(/left the league/);
  });

  it('records actual points only when the file is marked as the current season', async () => {
    const csv = gameweekCsv([{ name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 7 }]);

    await importGameweekCsv(db, csv, { currentSeason: false });
    expect((db.prepare('SELECT COUNT(*) AS n FROM actual_points').get() as { n: number }).n).toBe(0);

    await importGameweekCsv(db, csv, { currentSeason: true });
    const actual = db.prepare('SELECT points FROM actual_points').get() as { points: number };
    expect(actual.points).toBe(7);
  });

  describe('auto-detecting the current season (via importPayload, no explicit flag)', () => {
    it('treats a file naming this app\'s configured season as current, and records actuals', async () => {
      const csv = gameweekCsv([{ name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 8 }], {
        season: rules.season,
      });
      const summary = await importPayload(db, rules, csv);

      const actual = db.prepare('SELECT points FROM actual_points').get() as
        | { points: number }
        | undefined;
      expect(actual?.points).toBe(8);
      expect(summary.detail).toMatch(/actual score\(s\) were recorded/);
    });

    it('treats a file with no season column at all as current, since there is nothing to say otherwise', async () => {
      // This is the common case: a plain weekly results CSV, exactly what "how do I add this
      // week's results" means in practice - nobody bothers naming the season on a file that is
      // obviously about right now.
      const csv = gameweekCsv([{ name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 9 }]);
      await importPayload(db, rules, csv);

      const actual = db.prepare('SELECT points FROM actual_points').get() as
        | { points: number }
        | undefined;
      expect(actual?.points).toBe(9);
    });

    it('treats a named season that does not match as history, and does not record actuals', async () => {
      const csv = gameweekCsv([{ name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 5 }], {
        season: '2024/25',
      });
      const summary = await importPayload(db, rules, csv);

      expect((db.prepare('SELECT COUNT(*) AS n FROM actual_points').get() as { n: number }).n).toBe(0);
      // The row itself is still stored as history, just not graded against.
      const stat = db.prepare('SELECT total_points FROM player_gameweek_stat').get() as {
        total_points: number;
      };
      expect(stat.total_points).toBe(5);
      expect(summary.detail).toMatch(/Read as history, not this season/);
    });

    it('matches the season regardless of how it is punctuated', async () => {
      // rules.season is "2026/27"; a real export might spell it "2026-27" or "26/27".
      const csv = gameweekCsv([{ name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 6 }], {
        season: rules.season.replace('/', '-'),
      });
      await importPayload(db, rules, csv);

      const actual = db.prepare('SELECT points FROM actual_points').get() as
        | { points: number }
        | undefined;
      expect(actual?.points).toBe(6);
    });
  });

  it('is idempotent across re-imports', async () => {
    const csv = gameweekCsv([{ name: 'ALP-MD1', team: 'Alpha FC', gw: 1, points: 6 }]);
    await importPayload(db, rules, csv);
    await importPayload(db, rules, csv);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM player_gameweek_stat').get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('best XI in hindsight', () => {
  it('picks the highest-scoring legal XI and doubles the best scorer', () => {
    const squad = [
      ...Array.from({ length: 2 }, (_, i) => ({ playerId: i + 1, position: 'GKP' })),
      ...Array.from({ length: 5 }, (_, i) => ({ playerId: i + 10, position: 'DEF' })),
      ...Array.from({ length: 5 }, (_, i) => ({ playerId: i + 20, position: 'MID' })),
      ...Array.from({ length: 3 }, (_, i) => ({ playerId: i + 30, position: 'FWD' })),
    ];
    const actual = new Map(squad.map((p) => [p.playerId, 2]));
    actual.set(20, 20); // one big haul

    const best = bestElevenByActual(squad, actual, rules)!;
    // 11 players: the 20-pointer plus ten 2s, and the captain doubles the 20.
    expect(best).toBe(20 + 10 * 2 + 20);
  });

  it('returns null when too few players have a recorded result', () => {
    const squad = [{ playerId: 1, position: 'GKP' }];
    expect(bestElevenByActual(squad, new Map([[1, 5]]), rules)).toBeNull();
  });
});

describe('grading the model', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
  });

  function project(playerId: number, eventId: number, xPts: number, confidence = 'high'): void {
    db.prepare(
      `INSERT INTO projection (player_id, event_id, model_version, created_at, xpts, xpts_raw,
                               availability_probability, expected_minutes, fixture_count,
                               confidence, breakdown_json)
       VALUES (?, ?, ?, ?, ?, ?, 1, 80, 1, ?, '{}')`,
    ).run(playerId, eventId, weights.modelVersion, nowSeconds(), xPts, xPts, confidence);
  }

  function actual(playerId: number, eventId: number, points: number): void {
    db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, ?, ?, 90, 'manual', ?)`,
    ).run(playerId, eventId, points, nowSeconds());
  }

  it('measures how far out the projections were', () => {
    project(1, 1, 5);
    actual(1, 1, 3); // over by 2
    project(2, 1, 4);
    actual(2, 1, 6); // under by 2

    const result = evaluateGameweek(db, 1, rules);

    expect(result.playersScored).toBe(2);
    expect(result.meanAbsoluteError).toBeCloseTo(2, 5);
    // Errors cancel, so the model is not systematically biased here.
    expect(result.bias).toBeCloseTo(0, 5);
  });

  it('detects a systematically optimistic model, which is the fixable kind of wrong', () => {
    for (let id = 1; id <= 5; id += 1) {
      project(id, 1, 8);
      actual(id, 1, 4);
    }
    const result = evaluateGameweek(db, 1, rules);
    expect(result.bias).toBeCloseTo(4, 5);
    expect(result.meanAbsoluteError).toBeCloseTo(4, 5);
  });

  it('names the players it got most wrong, in both directions', () => {
    project(1, 1, 12);
    actual(1, 1, 1); // wildly over-rated
    project(2, 1, 2);
    actual(2, 1, 16); // wildly under-rated
    project(3, 1, 4);
    actual(3, 1, 4);

    const result = evaluateGameweek(db, 1, rules);
    expect(result.overRated[0]?.playerId).toBe(1);
    expect(result.underRated[0]?.playerId).toBe(2);
  });

  it('breaks the error down by position, so a blind spot is visible', () => {
    project(1, 1, 5); // GKP in the fake bootstrap
    actual(1, 1, 5);
    project(3, 1, 9); // DEF
    actual(3, 1, 2);

    const result = evaluateGameweek(db, 1, rules);
    const positions = result.byPosition.map((row) => row.position);
    expect(positions.length).toBeGreaterThan(1);
  });

  it('scores only players that have both a projection and a result', () => {
    project(1, 1, 5);
    actual(1, 1, 5);
    project(2, 1, 5); // no result recorded
    actual(3, 1, 9); // no projection made

    expect(evaluateGameweek(db, 1, rules).playersScored).toBe(1);
  });

  it('grades a stored recommendation against what the XI actually scored', () => {
    const squad = defaultPlayers().slice(0, 15).map((p) => ({ playerId: p.id, position: 'MID' }));
    const starters = squad.slice(0, 11).map((p) => ({ playerId: p.playerId, xPts: 4 }));

    for (const player of squad) {
      project(player.playerId, 1, 4);
      actual(player.playerId, 1, 3);
    }

    saveRecommendation(db, {
      eventId: 1,
      entryId: 2651633,
      kind: 'xi',
      modelVersion: weights.modelVersion,
      summary: 'test',
      detail: { starters, captainId: starters[0]!.playerId, squad },
      dataTakenAt: null,
    });

    const result = evaluateGameweek(db, 1, rules);
    // Eleven players on 3 points, with the captain doubled.
    expect(result.recommendedXiActual).toBe(11 * 3 + 3);
    expect(result.recommendedXiPredicted).toBeCloseTo(11 * 4 + 4, 1);
  });

  describe('previousRecommendationDetail', () => {
    const starters = (ids: number[]) => ids.map((playerId) => ({ playerId, name: `P${playerId}`, xPts: 4 }));

    it('is null when nothing was recommended for an earlier gameweek', () => {
      expect(previousRecommendationDetail(db, 1)).toBeNull();
    });

    it('finds the most recent recommendation for a gameweek before the one asked about', () => {
      saveRecommendation(db, {
        eventId: 1,
        entryId: 2651633,
        kind: 'xi',
        modelVersion: weights.modelVersion,
        summary: 'gw1',
        detail: { starters: starters([1, 2, 3]), bench: starters([4]), captainId: 1, viceCaptainId: 2 },
        dataTakenAt: null,
      });

      const detail = previousRecommendationDetail(db, 2, 2651633);
      expect(detail?.eventId).toBe(1);
      expect(detail?.captainId).toBe(1);
      expect(detail?.starters.map((p) => p.playerId)).toEqual([1, 2, 3]);
    });

    it('ignores a later re-generation for the SAME gameweek as the one asked about', () => {
      saveRecommendation(db, {
        eventId: 2,
        entryId: 2651633,
        kind: 'xi',
        modelVersion: weights.modelVersion,
        summary: 'regenerated for gw2 itself',
        detail: { starters: starters([9]), bench: [], captainId: 9, viceCaptainId: 9 },
        dataTakenAt: null,
      });

      // Asking "what came before gameweek 2" must not return gameweek 2's own recommendation.
      expect(previousRecommendationDetail(db, 2, 2651633)).toBeNull();
    });

    it('prefers the latest recommendation when a gameweek was regenerated more than once', () => {
      saveRecommendation(db, {
        eventId: 1,
        entryId: 2651633,
        kind: 'xi',
        modelVersion: weights.modelVersion,
        summary: 'first pass',
        detail: { starters: starters([1]), bench: [], captainId: 1, viceCaptainId: 1 },
        dataTakenAt: null,
      });
      saveRecommendation(db, {
        eventId: 1,
        entryId: 2651633,
        kind: 'xi',
        modelVersion: weights.modelVersion,
        summary: 'regenerated after a late team-news update',
        detail: { starters: starters([2]), bench: [], captainId: 2, viceCaptainId: 2 },
        dataTakenAt: null,
      });

      expect(previousRecommendationDetail(db, 2, 2651633)?.captainId).toBe(2);
    });

    it('never uses a from-scratch build (kind=squad) as the baseline for "what changed"', () => {
      // Saved whenever no owned squad could be loaded that time - see recommend()'s
      // build-squad path. It was never really "your squad", so diffing against it would
      // invent changes for players you never owned.
      saveRecommendation(db, {
        eventId: 1,
        entryId: 2651633,
        kind: 'squad',
        modelVersion: weights.modelVersion,
        summary: 'built from scratch, no squad was loaded that time',
        detail: { starters: starters([99]), bench: [], captainId: 99, viceCaptainId: 99 },
        dataTakenAt: null,
      });

      expect(previousRecommendationDetail(db, 2, 2651633)).toBeNull();
    });

    it('never mixes in another team\'s recommendation history', () => {
      saveRecommendation(db, {
        eventId: 1,
        entryId: 999999,
        kind: 'xi',
        modelVersion: weights.modelVersion,
        summary: 'a different team entirely',
        detail: { starters: starters([42]), bench: [], captainId: 42, viceCaptainId: 42 },
        dataTakenAt: null,
      });

      expect(previousRecommendationDetail(db, 2, 2651633)).toBeNull();
    });
  });

  it('surfaces the league average and highest score straight from bootstrap-static, once the gameweek finishes', async () => {
    project(1, 1, 5);
    actual(1, 1, 5);

    // Before the gameweek finishes, the API reports highest_score as null (average_entry_score
    // sits at 0 rather than null, which is how the FPL API itself behaves pre-gameweek).
    expect(evaluateGameweek(db, 1, rules).leagueAverage).toBe(0);
    expect(evaluateGameweek(db, 1, rules).leagueHighest).toBeNull();

    // A later bootstrap-static import - the same weekly one already imported for player data -
    // updates the event row once the gameweek finishes. There is nothing separate to upload.
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [
            fakeEvent(1, { finished: true, average_entry_score: 47, highest_score: 95 }),
            fakeEvent(2),
            fakeEvent(3),
          ],
        }),
      }),
      rules,
    );

    const result = evaluateGameweek(db, 1, rules);
    expect(result.leagueAverage).toBe(47);
    expect(result.leagueHighest).toBe(95);
  });

  it('explains what is missing rather than reporting a meaningless zero', () => {
    const empty = evaluateGameweek(db, 7, rules);
    expect(empty.playersScored).toBe(0);
    expect(empty.notes.join(' ')).toMatch(/No projections stored/);
  });

  it('summarises the season and records your own score alongside', () => {
    project(1, 1, 5);
    actual(1, 1, 4);
    project(1, 2, 6);
    actual(1, 2, 6);
    recordGameweekResult(db, 2651633, 1, { actualPoints: 62 });
    recordGameweekResult(db, 2651633, 2, { actualPoints: 71 });

    const season = evaluateSeason(db, rules);
    expect(season.gameweeks.map((g) => g.eventId)).toEqual([1, 2]);
    expect(season.gameweeks[0]?.yourActual).toBe(62);
    expect(season.overall?.gameweeks).toBe(2);
    expect(season.overall?.meanAbsoluteError).toBeCloseTo(0.5, 5);
  });

  it('carries the league average and highest through into the season summary', async () => {
    project(1, 1, 5);
    actual(1, 1, 4);
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [
            fakeEvent(1, { finished: true, average_entry_score: 47, highest_score: 95 }),
            fakeEvent(2),
            fakeEvent(3),
          ],
        }),
      }),
      rules,
    );

    const season = evaluateSeason(db, rules);
    expect(season.gameweeks[0]?.leagueAverage).toBe(47);
    expect(season.gameweeks[0]?.leagueHighest).toBe(95);
  });

  it('says plainly when there is nothing to grade yet', () => {
    const season = evaluateSeason(db, rules);
    expect(season.gameweeks).toHaveLength(0);
    expect(season.notes.join(' ')).toMatch(/Nothing to grade yet/);
  });
});
