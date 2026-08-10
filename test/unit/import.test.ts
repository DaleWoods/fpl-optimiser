import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { num, parseCsv, pick, toTable } from '../../src/ingest/csv.js';
import { detectPayloadKind, importPayload } from '../../src/ingest/import.js';
import { ingestBootstrap } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import { defaultPlayers, fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

describe('CSV parsing', () => {
  it('handles quoted fields containing commas', () => {
    expect(parseCsv('name,club\n"Smith, John",ARS')).toEqual([
      ['name', 'club'],
      ['Smith, John', 'ARS'],
    ]);
  });

  it('handles escaped quotes', () => {
    expect(parseCsv('name\n"He said ""hi"""')).toEqual([['name'], ['He said "hi"']]);
  });

  it('handles embedded newlines inside quotes', () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'x'],
    ]);
  });

  it('handles CRLF line endings from Windows exports', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips the byte-order mark Excel adds', () => {
    // Without this the first header becomes "﻿name" and never matches anything.
    const table = toTable('﻿name,points\nHaaland,239');
    expect(table.headers[0]).toBe('name');
    expect(pick(table.rows[0]!, 'name')).toBe('Haaland');
  });

  it('matches headers regardless of case, spaces and punctuation', () => {
    const table = toTable('Total Points,Expected_Goals\n120,9.4');
    expect(pick(table.rows[0]!, 'total_points')).toBe('120');
    expect(pick(table.rows[0]!, 'expected_goals')).toBe('9.4');
  });

  it('reads numbers, and returns null rather than NaN for junk', () => {
    expect(num('12')).toBe(12);
    expect(num('£5.5')).toBe(5.5);
    expect(num('')).toBeNull();
    expect(num('n/a')).toBeNull();
    expect(num(undefined)).toBeNull();
  });

  it('ignores blank rows', () => {
    expect(parseCsv('a,b\n1,2\n\n\n3,4')).toHaveLength(3);
  });
});

describe('file type detection', () => {
  it('recognises bootstrap-static by its contents, not its name', () => {
    expect(detectPayloadKind(JSON.stringify(fakeBootstrap()))).toBe('bootstrap');
  });

  it('recognises a fixtures array', () => {
    expect(detectPayloadKind(JSON.stringify([fakeFixture(1, 1, 1, 2)]))).toBe('fixtures');
  });

  it('recognises an element-summary', () => {
    expect(detectPayloadKind(JSON.stringify({ history: [], history_past: [] }))).toBe(
      'element-summary',
    );
  });

  it('recognises a CSV', () => {
    expect(detectPayloadKind('name,points\nHaaland,239')).toBe('season-csv');
  });

  it('reports anything else as unknown rather than guessing', () => {
    expect(detectPayloadKind('{"something": "else"}')).toBe('unknown');
    expect(detectPayloadKind('{ broken json')).toBe('unknown');
  });
});

describe('importing saved API files', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('imports a saved bootstrap-static exactly as the API gave it', async () => {
    const summary = await importPayload(db, rules, JSON.stringify(fakeBootstrap()), {
      sourceLabel: 'bootstrap-static.json',
    });

    expect(summary.kind).toBe('bootstrap');
    expect(summary.detail).toMatch(/60 players, 4 clubs/);

    const players = db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number };
    expect(players.n).toBe(60);
  });

  it('imports fixtures after clubs exist', async () => {
    await importPayload(db, rules, JSON.stringify(fakeBootstrap()));
    const summary = await importPayload(
      db,
      rules,
      JSON.stringify([fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 3, 4)]),
    );

    expect(summary.kind).toBe('fixtures');
    expect(summary.rowsWritten).toBe(2);
    expect(summary.warnings).toEqual([]);
  });

  it('says plainly when fixtures arrive before the clubs they reference', async () => {
    const summary = await importPayload(db, rules, JSON.stringify([fakeFixture(1, 1, 1, 2)]));
    expect(summary.rowsWritten).toBe(0);
    expect(summary.warnings.join(' ')).toMatch(/Import bootstrap-static first/);
  });

  it('imports a player history including previous seasons', async () => {
    await importPayload(db, rules, JSON.stringify(fakeBootstrap()));
    const summary = await importPayload(
      db,
      rules,
      JSON.stringify({
        history: [{ element: 1, fixture: 500, minutes: 90, total_points: 6 }],
        history_past: [
          { season_name: '2025/26', total_points: 180, minutes: 3000, expected_goals: '12.5' },
        ],
      }),
    );

    expect(summary.kind).toBe('element-summary');
    const season = db
      .prepare('SELECT total_points AS pts FROM player_season_history WHERE player_id = 1')
      .get() as { pts: number };
    expect(season.pts).toBe(180);
  });

  it('refuses a file it cannot identify rather than importing nonsense', async () => {
    await expect(importPayload(db, rules, '{"unexpected":true}', { sourceLabel: 'mystery.json' }))
      .rejects.toThrow(/Could not tell what kind of file/);
  });
});

describe('importing a season CSV', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
  });

  const header =
    'name,team,season,total_points,minutes,starts,goals_scored,assists,clean_sheets,bonus,expected_goals,expected_assists,defensive_contribution';

  it('matches rows by player name and club', async () => {
    const csv = `${header}\nALP-MD1,ALP,2025/26,180,3000,33,15,10,8,20,13.5,9.2`;
    const summary = await importPayload(db, rules, csv, { sourceLabel: 'last-season.csv' });

    expect(summary.kind).toBe('season-csv');
    expect(summary.rowsWritten).toBe(1);

    const row = db
      .prepare(
        `SELECT h.total_points AS pts, h.expected_goals AS xg FROM player_season_history h
         JOIN player p ON p.id = h.player_id WHERE p.web_name = 'ALP-MD1'`,
      )
      .get() as { pts: number; xg: number };
    expect(row.pts).toBe(180);
    expect(row.xg).toBeCloseTo(13.5);
  });

  it('matches by FPL id when the file has one, which is the most reliable route', async () => {
    const csv = `id,season,total_points,minutes\n7,2025/26,150,2500`;
    const summary = await importPayload(db, rules, csv);
    expect(summary.rowsWritten).toBe(1);

    const row = db
      .prepare('SELECT total_points AS pts FROM player_season_history WHERE player_id = 7')
      .get() as { pts: number };
    expect(row.pts).toBe(150);
  });

  it('reports rows that match no player, with line numbers', async () => {
    const csv = `${header}\nNobody Here,XXX,2025/26,180,3000,33,15,10,8,20,13.5,9.2`;
    const summary = await importPayload(db, rules, csv);

    expect(summary.rowsWritten).toBe(0);
    expect(summary.warnings.join(' ')).toMatch(/line 2: Nobody Here/);
  });

  it('imports the good rows even when some fail', async () => {
    const csv =
      `${header}\n` +
      `ALP-MD1,ALP,2025/26,180,3000,33,15,10,8,20,13.5,9.2\n` +
      `Nobody Here,XXX,2025/26,10,100,1,0,0,0,0,0,0\n` +
      `ALP-MD2,ALP,2025/26,140,2800,30,9,7,6,15,8.1,6.4`;
    const summary = await importPayload(db, rules, csv);

    expect(summary.rowsWritten).toBe(2);
    expect(summary.warnings).toHaveLength(1);
  });

  it('is idempotent - re-uploading the same file updates rather than duplicates', async () => {
    const csv = `${header}\nALP-MD1,ALP,2025/26,180,3000,33,15,10,8,20,13.5,9.2`;
    await importPayload(db, rules, csv);
    await importPayload(db, rules, csv);

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM player_season_history')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('refuses a CSV when there are no players to match against', async () => {
    const empty = openTestDatabase();
    await expect(
      importPayload(empty, rules, `${header}\nALP-MD1,ALP,2025/26,180,3000,33,15,10,8,20,13.5,9.2`),
    ).rejects.toThrow(/Import bootstrap-static first/);
  });

  it('feeds imported history straight into projections', async () => {
    // The point of the whole exercise: uploaded data must change the recommendation.
    await importPayload(
      db,
      rules,
      JSON.stringify(
        fakeBootstrap({
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
          players: defaultPlayers().map((p) => ({ ...p, minutes: 0, starts: 0 })),
        }),
      ),
    );
    await importPayload(db, rules, JSON.stringify([fakeFixture(1, 1, 1, 2)]));

    const before = buildProjections(db, 1, rules, weights).find((p) => p.name === 'ALP-MD1')!;

    await importPayload(
      db,
      rules,
      `${header}\nALP-MD1,ALP,2025/26,240,3200,35,22,12,9,25,20.0,11.0`,
    );

    const after = buildProjections(db, 1, rules, weights).find((p) => p.name === 'ALP-MD1')!;

    expect(after.xPts).toBeGreaterThan(before.xPts);
    expect(after.reasons.join(' ')).toMatch(/Rates are from 2025\/26 \(240 points\)/);
  });
});
