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
  simulateAutoSubs,
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

    const result = evaluateGameweek(db, 1, rules, 2651633);
    // Eleven players on 3 points, with the captain doubled.
    expect(result.recommendedXiActual).toBe(11 * 3 + 3);
    expect(result.recommendedXiPredicted).toBeCloseTo(11 * 4 + 4, 1);
  });

  it('never grades a from-scratch build (kind=squad) as if it were the recommended XI you followed', () => {
    const squad = defaultPlayers().slice(0, 15).map((p) => ({ playerId: p.id, position: 'MID' }));
    const starters = squad.slice(0, 11).map((p) => ({ playerId: p.playerId, xPts: 4 }));

    for (const player of squad) {
      project(player.playerId, 1, 4);
      actual(player.playerId, 1, 3);
    }

    // Saved whenever no owned squad could be loaded that time - never actually followed.
    saveRecommendation(db, {
      eventId: 1,
      entryId: 2651633,
      kind: 'squad',
      modelVersion: weights.modelVersion,
      summary: 'built from scratch, no squad was loaded that time',
      detail: { starters, captainId: starters[0]!.playerId, squad },
      dataTakenAt: null,
    });

    const result = evaluateGameweek(db, 1, rules, 2651633);
    expect(result.recommendedXiActual).toBeNull();
    expect(result.recommendedXiPredicted).toBeNull();
  });

  it('never grades another team\'s stored recommendation', () => {
    const squad = defaultPlayers().slice(0, 15).map((p) => ({ playerId: p.id, position: 'MID' }));
    const starters = squad.slice(0, 11).map((p) => ({ playerId: p.playerId, xPts: 4 }));

    for (const player of squad) {
      project(player.playerId, 1, 4);
      actual(player.playerId, 1, 3);
    }

    saveRecommendation(db, {
      eventId: 1,
      entryId: 999999,
      kind: 'xi',
      modelVersion: weights.modelVersion,
      summary: 'a different team entirely',
      detail: { starters, captainId: starters[0]!.playerId, squad },
      dataTakenAt: null,
    });

    const result = evaluateGameweek(db, 1, rules, 2651633);
    expect(result.recommendedXiActual).toBeNull();
    expect(result.recommendedXiPredicted).toBeNull();
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

  describe('simulateAutoSubs', () => {
    // 1 GKP, 4 DEF, 5 MID, 1 FWD - a legal 4-5-1 starting XI, at the MID cap (max 5).
    const positionById = new Map<number, string>([
      [1, 'GKP'],
      [2, 'DEF'],
      [3, 'DEF'],
      [4, 'DEF'],
      [5, 'DEF'],
      [6, 'MID'],
      [7, 'MID'],
      [8, 'MID'],
      [9, 'MID'],
      [10, 'MID'],
      [11, 'FWD'],
      [12, 'MID'], // bench #1
      [13, 'DEF'], // bench #2
      [14, 'FWD'], // bench #3
      [15, 'GKP'], // bench #4
    ]);
    const starters = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((playerId) => ({ playerId }));
    const bench = [12, 13, 14, 15].map((playerId) => ({ playerId }));
    const played = (points: number) => ({ points, minutes: 90 });
    const blank = { points: 0, minutes: 0 };

    it('subs on the next bench player who played when a starter blanks', () => {
      const actualById = new Map<number, { points: number; minutes: number | null }>([
        [1, played(5)],
        [2, played(2)],
        [3, played(2)],
        [4, played(2)],
        [5, blank], // starting DEF blanks
        [6, played(3)],
        [7, played(3)],
        [8, played(3)],
        [9, played(3)],
        [10, played(3)],
        [11, played(4)],
        [12, blank], // bench #1 also blank
        [13, played(6)], // bench #2 played - should come on for player 5
        [14, blank],
        [15, blank],
      ]);

      const result = simulateAutoSubs(starters, bench, positionById, actualById, null, null, rules);

      expect(result.finalXi).toContain(13);
      expect(result.finalXi).not.toContain(5);
      // Every other blanked or unused bench player is irrelevant to the total.
      expect(result.total).toBe(5 + 2 + 2 + 2 + 6 + 3 + 3 + 3 + 3 + 3 + 4);
    });

    it('skips a bench player who would make the formation illegal, and uses the next one who does not', () => {
      const actualById = new Map<number, { points: number; minutes: number | null }>([
        [1, played(0)],
        [2, played(0)],
        [3, played(0)],
        [4, played(0)],
        [5, blank], // starting DEF blanks; DEF is at 4, MID already at its max of 5
        [6, played(0)],
        [7, played(0)],
        [8, played(0)],
        [9, played(0)],
        [10, played(0)],
        [11, played(0)],
        [12, played(9)], // bench #1: a MID - would push MID to 6, illegal, must be skipped
        [13, played(7)], // bench #2: a DEF - keeps the formation legal, used instead
        [14, blank],
        [15, blank],
      ]);

      const result = simulateAutoSubs(starters, bench, positionById, actualById, null, null, rules);

      expect(result.finalXi).toContain(13);
      expect(result.finalXi).not.toContain(12);
      expect(result.finalXi).not.toContain(5);
    });

    it('never replaces a blanked goalkeeper with an outfield player, even if one is available', () => {
      const actualById = new Map<number, { points: number; minutes: number | null }>([
        [1, blank], // starting GKP blanks
        [2, played(1)],
        [3, played(1)],
        [4, played(1)],
        [5, played(1)],
        [6, played(1)],
        [7, played(1)],
        [8, played(1)],
        [9, played(1)],
        [10, played(1)],
        [11, played(1)],
        [12, played(9)], // bench MID played, but must never come on for a goalkeeper
        [13, played(9)],
        [14, played(9)],
        [15, blank], // bench GKP also blanked - no legal replacement exists
      ]);

      const result = simulateAutoSubs(starters, bench, positionById, actualById, null, null, rules);

      // The goalkeeper stays put, scoring 0, rather than being replaced by an outfield player.
      expect(result.finalXi).toContain(1);
      expect(result.finalXi).not.toContain(15);
    });

    it('moves the captain\'s double to the vice-captain when the captain blanks', () => {
      const actualById = new Map<number, { points: number; minutes: number | null }>([
        [1, played(2)],
        [2, played(2)],
        [3, played(2)],
        [4, played(2)],
        [5, played(2)],
        [6, played(2)],
        [7, played(2)],
        [8, played(2)],
        [9, played(2)],
        [10, played(2)],
        [11, blank], // the captain, blanks
        [12, blank],
        [13, blank],
        [14, blank],
        [15, blank],
      ]);

      const result = simulateAutoSubs(starters, bench, positionById, actualById, 11, 10, rules);

      // Player 11 (captain, blanked) scores 0 either way; player 10 (vice) is doubled instead.
      const withoutDouble = 2 * 10 + 0;
      expect(result.total).toBe(withoutDouble + 2); // +2 for vice-captain's double
    });

    it('doubles nobody when both the captain and vice-captain blank', () => {
      const actualById = new Map<number, { points: number; minutes: number | null }>([
        [1, played(2)],
        [2, played(2)],
        [3, played(2)],
        [4, played(2)],
        [5, played(2)],
        [6, played(2)],
        [7, played(2)],
        [8, played(2)],
        [9, played(2)],
        [10, blank], // vice, blanks
        [11, blank], // captain, blanks
        [12, blank],
        [13, blank],
        [14, blank],
        [15, blank],
      ]);

      const result = simulateAutoSubs(starters, bench, positionById, actualById, 11, 10, rules);
      expect(result.total).toBe(2 * 9);
    });
  });

  it('grades a stored recommendation with real auto-subs applied, not just the 11 originally picked', () => {
    const squad = [
      { playerId: 1, position: 'GKP' },
      { playerId: 2, position: 'DEF' },
      { playerId: 3, position: 'DEF' },
      { playerId: 4, position: 'DEF' },
      { playerId: 5, position: 'MID' },
      { playerId: 6, position: 'MID' },
      { playerId: 7, position: 'MID' },
      { playerId: 8, position: 'FWD' },
      { playerId: 9, position: 'FWD' },
      { playerId: 10, position: 'FWD' },
      { playerId: 11, position: 'DEF' },
      { playerId: 12, position: 'GKP' }, // bench #1
      { playerId: 13, position: 'DEF' }, // bench #2
      { playerId: 14, position: 'MID' }, // bench #3
      { playerId: 15, position: 'FWD' }, // bench #4
    ];
    const startersDetail = squad.slice(0, 11).map((p) => ({ playerId: p.playerId, xPts: 4 }));
    const benchDetail = squad.slice(11).map((p) => ({ playerId: p.playerId, xPts: 2 }));

    for (const player of squad) {
      project(player.playerId, 1, 4);
    }
    // Player 11 (a starting DEF) blanks; bench #2 (player 13, also DEF) comes on for them.
    for (const player of squad) {
      actual(player.playerId, 1, player.playerId === 11 ? 0 : 3);
    }
    // actual() always records 90 minutes - only need to zero out player 11's, so they read as
    // having not played rather than having played and scored 0.
    db.prepare('UPDATE actual_points SET minutes = 0 WHERE player_id = 11 AND event_id = 1').run();

    saveRecommendation(db, {
      eventId: 1,
      entryId: 2651633,
      kind: 'xi',
      modelVersion: weights.modelVersion,
      summary: 'test',
      detail: {
        starters: startersDetail,
        bench: benchDetail,
        captainId: startersDetail[0]!.playerId,
        viceCaptainId: startersDetail[1]!.playerId,
        squad,
      },
      dataTakenAt: null,
    });

    const result = evaluateGameweek(db, 1, rules, 2651633);
    // Without auto-subs this would be 10*3 (11 blanks at 0) with captain doubled = 33.
    // With the bench DEF subbed on for the blank, it is 10*3 + 3, captain still doubled.
    expect(result.recommendedXiActual).toBe(10 * 3 + 3 + 3);
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

    const season = evaluateSeason(db, rules, 2651633);
    expect(season.gameweeks.map((g) => g.eventId)).toEqual([1, 2]);
    expect(season.gameweeks[0]?.yourActual).toBe(62);
    expect(season.overall?.gameweeks).toBe(2);
    expect(season.overall?.meanAbsoluteError).toBeCloseTo(0.5, 5);
  });

  it('never shows another team\'s recorded score as "you scored"', () => {
    project(1, 1, 5);
    actual(1, 1, 4);
    recordGameweekResult(db, 999999, 1, { actualPoints: 62 });

    const season = evaluateSeason(db, rules, 2651633);
    expect(season.gameweeks[0]?.yourActual).toBeNull();
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
