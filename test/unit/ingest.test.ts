import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { deriveFreeTransfers } from '../../src/domain/freeTransfers.js';
import {
  ingestAll,
  ingestBootstrap,
  ingestEntry,
  ingestFixtures,
  ingestPlayerSummaries,
  lastSuccessfulRun,
} from '../../src/ingest/index.js';
import {
  defaultPlayers,
  defaultTeams,
  fakeBootstrap,
  fakeElementSummary,
  fakeEntry,
  fakeEvent,
  fakeFixture,
  fakePicks,
  fakePlayer,
} from '../support/fakeApi.js';

const rules = loadRules();

describe('bootstrap ingestion', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('stores positions, teams, events, players and a snapshot', async () => {
    const api = new StubFplApi({ bootstrap: fakeBootstrap() });
    const result = await ingestBootstrap(db, api, rules);

    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    expect(count('position')).toBe(4);
    expect(count('team')).toBe(4);
    expect(count('event')).toBe(3);
    expect(count('player')).toBe(60);
    expect(count('snapshot')).toBe(1);
    expect(count('player_snapshot')).toBe(60);
    expect(result.snapshotId).toBeGreaterThan(0);
  });

  it('takes each player position from the API, never from config', async () => {
    // A player the API classifies as a midfielder must land as a midfielder even though the
    // name suggests otherwise - the 2026/27 season reclassified 11 players.
    const players = [
      ...defaultPlayers(),
      { id: 999, web_name: 'ALP-DF-reclassified', team: 1, element_type: 3, now_cost: 55 },
    ];
    const api = new StubFplApi({ bootstrap: fakeBootstrap({ players }) });
    await ingestBootstrap(db, api, rules);

    const row = db
      .prepare(
        `SELECT p.short_name AS position FROM player pl
         JOIN position p ON p.id = pl.position_id WHERE pl.id = 999`,
      )
      .get() as { position: string };
    expect(row.position).toBe('MID');
  });

  it('refuses to ingest when the API has a position config has no rules for', async () => {
    const bootstrap = fakeBootstrap();
    bootstrap.element_types = [
      ...bootstrap.element_types,
      {
        id: 5,
        singular_name_short: 'WNG',
        singular_name: 'Winger',
        plural_name: 'Wingers',
        squad_select: 2,
        squad_min_play: 0,
        squad_max_play: 3,
        element_count: 40,
      },
    ];
    const api = new StubFplApi({ bootstrap });
    await expect(ingestBootstrap(db, api, rules)).rejects.toThrow(/no rules for/);
  });

  it('records the failed attempt so staleness stays answerable', async () => {
    const bootstrap = fakeBootstrap();
    bootstrap.element_types = bootstrap.element_types.slice(0, 3);
    const api = new StubFplApi({ bootstrap });

    await expect(ingestBootstrap(db, api, rules)).rejects.toThrow();

    const run = db
      .prepare("SELECT ok, note FROM ingest_run WHERE source = 'bootstrap-static'")
      .get() as { ok: number; note: string };
    expect(run.ok).toBe(0);
    expect(run.note).toMatch(/no longer returns/);
    expect(lastSuccessfulRun(db, 'bootstrap-static')).toBeNull();
  });

  it('upserts reference data but appends snapshots, so history accumulates', async () => {
    const api = new StubFplApi({ bootstrap: fakeBootstrap() });
    await ingestBootstrap(db, api, rules);
    await ingestBootstrap(db, api, rules);

    const players = (db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n;
    const snapshots = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
    expect(players).toBe(60);
    expect(snapshots).toBe(2);
  });
});

describe('change detection', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  async function ingestTwice(second: Parameters<typeof fakePlayer>[0]) {
    const first = defaultPlayers();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap({ players: first }) }), rules);

    const changed = first.map((player) => (player.id === second.id ? second : player));
    await ingestBootstrap(
      db,
      new StubFplApi({ bootstrap: fakeBootstrap({ players: changed }) }),
      rules,
    );

    return db
      .prepare('SELECT kind, before_value AS before, after_value AS after, note FROM change_log ORDER BY id')
      .all() as { kind: string; before: string | null; after: string | null; note: string }[];
  }

  it('detects a price rise and describes it in pounds', async () => {
    const base = defaultPlayers()[0]!;
    const changes = await ingestTwice({ ...base, now_cost: base.now_cost + 1 });
    const price = changes.find((change) => change.kind === 'price');
    expect(price).toBeDefined();
    expect(price!.note).toMatch(/Price rose from £4\.5m to £4\.6m/);
  });

  it('detects a price fall', async () => {
    const base = defaultPlayers()[0]!;
    const changes = await ingestTwice({ ...base, now_cost: base.now_cost - 1 });
    expect(changes.find((c) => c.kind === 'price')?.note).toMatch(/Price fell/);
  });

  it('detects a player becoming injured', async () => {
    const base = defaultPlayers()[0]!;
    const changes = await ingestTwice({ ...base, status: 'i', news: 'Hamstring injury - 50% chance' });
    expect(changes.find((c) => c.kind === 'status')?.after).toBe('i');
    expect(changes.find((c) => c.kind === 'news')?.note).toMatch(/Hamstring injury/);
  });

  it('detects a chance-of-playing change, including when it becomes unstated', async () => {
    const base = defaultPlayers()[0]!;
    const changes = await ingestTwice({ ...base, chance_of_playing_next_round: 25 });
    const chance = changes.find((c) => c.kind === 'chance');
    expect(chance?.before).toBeNull();
    expect(chance?.after).toBe('25');
    expect(chance?.note).toMatch(/from unstated to 25/);
  });

  it('reports nothing when nothing moved', async () => {
    const base = defaultPlayers()[0]!;
    const changes = await ingestTwice(base);
    expect(changes).toHaveLength(0);
  });

  it('does not report changes for a player seen for the first time', async () => {
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
    const extra = [
      ...defaultPlayers(),
      { id: 500, web_name: 'New Signing', team: 1, element_type: 4, now_cost: 90 },
    ];
    await ingestBootstrap(
      db,
      new StubFplApi({ bootstrap: fakeBootstrap({ players: extra }) }),
      rules,
    );
    const changes = db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number };
    expect(changes.n).toBe(0);
  });
});

describe('fixtures ingestion', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
  });

  it('stores fixtures with their difficulty ratings', async () => {
    const api = new StubFplApi({
      fixtures: [
        fakeFixture(1, 1, 1, 2, { team_h_difficulty: 2, team_a_difficulty: 5 }),
        fakeFixture(2, 1, 3, 4),
      ],
    });
    const result = await ingestFixtures(db, api);
    expect(result.rowsWritten).toBe(2);

    const row = db.prepare('SELECT team_h_difficulty AS d FROM fixture WHERE id = 1').get() as {
      d: number;
    };
    expect(row.d).toBe(2);
  });

  it('skips a fixture referencing a team we have never ingested, without losing the rest', async () => {
    const api = new StubFplApi({
      fixtures: [fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 1, 99)],
    });
    const result = await ingestFixtures(db, api);
    expect(result.rowsWritten).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('stores an unscheduled fixture with a null gameweek', async () => {
    const api = new StubFplApi({ fixtures: [fakeFixture(1, null, 1, 2)] });
    await ingestFixtures(db, api);
    const row = db.prepare('SELECT event_id FROM fixture WHERE id = 1').get() as {
      event_id: number | null;
    };
    expect(row.event_id).toBeNull();
  });

  it('updates a fixture in place when it is re-ingested with a result', async () => {
    await ingestFixtures(db, new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 2)] }));
    await ingestFixtures(
      db,
      new StubFplApi({
        fixtures: [fakeFixture(1, 1, 1, 2, { finished: true, team_h_score: 2, team_a_score: 1 })],
      }),
    );

    const rows = db.prepare('SELECT COUNT(*) AS n FROM fixture').get() as { n: number };
    const row = db.prepare('SELECT finished, team_h_score AS h FROM fixture WHERE id = 1').get() as {
      finished: number;
      h: number;
    };
    expect(rows.n).toBe(1);
    expect(row.finished).toBe(1);
    expect(row.h).toBe(2);
  });
});

describe('player summary ingestion', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
  });

  it('stores per-match history', async () => {
    const api = new StubFplApi({
      elementSummary: {
        1: fakeElementSummary(1, [{ minutes: 90, total_points: 6 }, { minutes: 65, total_points: 2 }]),
      },
    });
    const result = await ingestPlayerSummaries(db, api, { playerIds: [1] });
    expect(result.rowsWritten).toBe(2);

    const rows = db
      .prepare('SELECT minutes, total_points AS pts FROM player_fixture_history WHERE player_id = 1 ORDER BY fixture_id')
      .all() as { minutes: number; pts: number }[];
    expect(rows).toEqual([
      { minutes: 90, pts: 6 },
      { minutes: 65, pts: 2 },
    ]);
  });

  it('keeps going when one player fails, and reports which', async () => {
    const api = new StubFplApi({
      elementSummary: {
        1: fakeElementSummary(1, [{ minutes: 90 }]),
        3: fakeElementSummary(3, [{ minutes: 45 }]),
      },
    });
    const result = await ingestPlayerSummaries(db, api, { playerIds: [1, 2, 3] });

    expect(result.playersIngested).toBe(2);
    expect(result.playersFailed).toBe(1);
    expect(result.failures[0]?.playerId).toBe(2);
  });

  it('coerces the string-typed expected-goals fields the API sends', async () => {
    const api = new StubFplApi({
      elementSummary: { 1: fakeElementSummary(1, [{ expected_goals: '0.47' }]) },
    });
    await ingestPlayerSummaries(db, api, { playerIds: [1] });
    const row = db
      .prepare('SELECT expected_goals AS xg FROM player_fixture_history WHERE player_id = 1')
      .get() as { xg: number };
    expect(row.xg).toBeCloseTo(0.47);
  });

  it('is idempotent - re-ingesting the same match updates rather than duplicates', async () => {
    const api = new StubFplApi({ elementSummary: { 1: fakeElementSummary(1, [{ minutes: 90 }]) } });
    await ingestPlayerSummaries(db, api, { playerIds: [1] });
    await ingestPlayerSummaries(db, api, { playerIds: [1] });
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM player_fixture_history WHERE player_id = 1')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('entry ingestion', () => {
  let db: Database;
  const teamId = 2651633;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
  });

  it('loads a squad and stores all 15 picks', async () => {
    const squad = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const api = new StubFplApi({
      entry: { [teamId]: fakeEntry(teamId, { current_event: 3 }) },
      history: {
        [teamId]: {
          current: [
            { event: 1, points: 60, total_points: 60, bank: 5, value: 1000, event_transfers: 0, event_transfers_cost: 0, points_on_bench: 3 },
            { event: 2, points: 55, total_points: 115, bank: 5, value: 1001, event_transfers: 0, event_transfers_cost: 0, points_on_bench: 2 },
          ],
          chips: [],
        },
      },
      picks: { [`${teamId}:3`]: fakePicks(squad) },
    });

    const result = await ingestEntry(db, api, teamId, rules);

    expect(result.picksLoaded).toBe(true);
    expect(result.picksEvent).toBe(3);
    const picks = db
      .prepare('SELECT COUNT(*) AS n FROM squad_pick WHERE manager_state_id = ?')
      .get(result.managerStateId) as { n: number };
    expect(picks.n).toBe(15);
  });

  it('records captain and vice from the picks', async () => {
    const api = new StubFplApi({
      entry: { [teamId]: fakeEntry(teamId, { current_event: 1 }) },
      history: { [teamId]: { current: [], chips: [] } },
      picks: { [`${teamId}:1`]: fakePicks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) },
    });
    const result = await ingestEntry(db, api, teamId, rules);
    const captain = db
      .prepare('SELECT player_id AS id FROM squad_pick WHERE manager_state_id = ? AND is_captain = 1')
      .get(result.managerStateId) as { id: number };
    expect(captain.id).toBe(1);
  });

  it('handles pre-season, when no gameweek has started and no squad exists', async () => {
    // This is the state a brand new season is in: current_event is null and the picks
    // endpoint has nothing to return. That is expected, not a failure.
    const api = new StubFplApi({
      entry: { [teamId]: fakeEntry(teamId, { current_event: null }) },
      history: { [teamId]: { current: [], chips: [] } },
    });

    const result = await ingestEntry(db, api, teamId, rules);

    expect(result.picksLoaded).toBe(false);
    expect(result.picksEvent).toBeNull();
    expect(result.managerStateId).toBeGreaterThan(0);
    expect(result.notes.join(' ')).toMatch(/no squad to load/i);
  });

  it('survives a 404 on the picks endpoint without losing manager state', async () => {
    const api = new StubFplApi({
      entry: { [teamId]: fakeEntry(teamId, { current_event: 5 }) },
      history: { [teamId]: { current: [], chips: [] } },
      // No picks stubbed: the endpoint 404s.
    });

    const result = await ingestEntry(db, api, teamId, rules);

    expect(result.picksLoaded).toBe(false);
    expect(result.notes.join(' ')).toMatch(/No squad recorded for gameweek 5/);
    const state = db.prepare('SELECT COUNT(*) AS n FROM manager_state').get() as { n: number };
    expect(state.n).toBe(1);
  });

  it('never invents a selling price it cannot know', async () => {
    const api = new StubFplApi({
      entry: { [teamId]: fakeEntry(teamId, { current_event: 1 }) },
      history: { [teamId]: { current: [], chips: [] } },
      picks: { [`${teamId}:1`]: fakePicks([1, 2, 3]) },
    });
    const result = await ingestEntry(db, api, teamId, rules);

    const rows = db
      .prepare('SELECT selling_price, purchase_price, price_source FROM squad_pick WHERE manager_state_id = ?')
      .all(result.managerStateId) as {
      selling_price: number | null;
      purchase_price: number | null;
      price_source: string;
    }[];

    for (const row of rows) {
      expect(row.selling_price).toBeNull();
      expect(row.purchase_price).toBeNull();
      expect(row.price_source).toBe('unknown');
    }
    expect(result.notes.join(' ')).toMatch(/selling prices are not available/i);
  });

  it('marks chips as available until the history says they were used', async () => {
    const api = new StubFplApi({
      entry: { [teamId]: fakeEntry(teamId, { current_event: 4 }) },
      history: {
        [teamId]: {
          current: [
            { event: 1, points: 50, total_points: 50, bank: 0, value: 1000, event_transfers: 0, event_transfers_cost: 0, points_on_bench: 0 },
          ],
          chips: [{ name: 'wildcard', event: 1, time: '2026-08-21T10:00:00Z' }],
        },
      },
      picks: { [`${teamId}:4`]: fakePicks([1, 2, 3]) },
    });

    const result = await ingestEntry(db, api, teamId, rules);
    const row = db
      .prepare('SELECT chips_available_json AS available, chips_used_json AS used FROM manager_state WHERE id = ?')
      .get(result.managerStateId) as { available: string; used: string };

    expect(JSON.parse(row.available)).not.toContain('wildcard');
    expect(JSON.parse(row.available)).toContain('freehit');
    expect(JSON.parse(row.used)).toEqual([{ name: 'wildcard', event: 1 }]);
  });

  it('flags squad players missing from the local database', async () => {
    const api = new StubFplApi({
      entry: { [teamId]: fakeEntry(teamId, { current_event: 1 }) },
      history: { [teamId]: { current: [], chips: [] } },
      picks: { [`${teamId}:1`]: fakePicks([1, 2, 9999]) },
    });
    const result = await ingestEntry(db, api, teamId, rules);
    expect(result.notes.join(' ')).toMatch(/1 squad player\(s\) are not in the local database/);
  });
});

describe('free transfer derivation', () => {
  it('gives the weekly allowance before any gameweek has been played', () => {
    const result = deriveFreeTransfers([], rules);
    expect(result.freeTransfers).toBe(1);
    expect(result.caveats.join(' ')).toMatch(/unlimited/i);
  });

  it('rolls an unused transfer over', () => {
    const result = deriveFreeTransfers(
      [{ event: 1, transfersMade: 0, transfersCost: 0 }],
      rules,
    );
    expect(result.freeTransfers).toBe(2);
  });

  it('caps banked transfers at the configured maximum', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      event: index + 1,
      transfersMade: 0,
      transfersCost: 0,
    }));
    expect(deriveFreeTransfers(history, rules).freeTransfers).toBe(5);
  });

  it('resets to the weekly allowance after the bank is spent', () => {
    const result = deriveFreeTransfers(
      [
        { event: 1, transfersMade: 0, transfersCost: 0 },
        { event: 2, transfersMade: 2, transfersCost: 0 },
      ],
      rules,
    );
    expect(result.freeTransfers).toBe(1);
  });

  it('never drops below zero when a hit is taken', () => {
    const result = deriveFreeTransfers(
      [{ event: 1, transfersMade: 4, transfersCost: 12 }],
      rules,
    );
    expect(result.freeTransfers).toBe(1);
  });

  it('keeps banked transfers through a wildcard, per the 2026/27 rules', () => {
    const result = deriveFreeTransfers(
      [
        { event: 1, transfersMade: 0, transfersCost: 0 },
        { event: 2, transfersMade: 0, transfersCost: 0 },
        { event: 3, transfersMade: 11, transfersCost: 0, chip: 'wildcard' },
      ],
      rules,
    );
    expect(result.freeTransfers).toBe(4);
  });

  it('keeps banked transfers through a free hit', () => {
    const result = deriveFreeTransfers(
      [
        { event: 1, transfersMade: 0, transfersCost: 0 },
        { event: 2, transfersMade: 15, transfersCost: 0, chip: 'freehit' },
      ],
      rules,
    );
    expect(result.freeTransfers).toBe(3);
  });

  it('shows its workings, so derived advice can be audited', () => {
    const result = deriveFreeTransfers(
      [
        { event: 1, transfersMade: 0, transfersCost: 0 },
        { event: 2, transfersMade: 1, transfersCost: 0 },
      ],
      rules,
    );
    expect(result.workings).toHaveLength(2);
    expect(result.workings[0]).toMatch(/GW1/);
    expect(result.freeTransfers).toBe(2);
  });

  it('flags a mismatch against the hit the API actually charged', () => {
    // We think one transfer was free; the API says it cost 4 points. Our count has drifted.
    const result = deriveFreeTransfers(
      [{ event: 1, transfersMade: 1, transfersCost: 4 }],
      rules,
    );
    expect(result.confident).toBe(false);
    expect(result.caveats.join(' ')).toMatch(/derived a hit of 0 points but the API reports 4/);
  });
});

describe('full ingestion', () => {
  it('runs every stage in dependency order', async () => {
    const db = openTestDatabase();
    const teamId = 2651633;
    const api = new StubFplApi({
      bootstrap: fakeBootstrap({ events: [fakeEvent(1, { is_next: true })] }),
      fixtures: [fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 3, 4)],
      elementSummary: { 1: fakeElementSummary(1, [{ minutes: 90 }]) },
      entry: { [teamId]: fakeEntry(teamId, { current_event: null }) },
      history: { [teamId]: { current: [], chips: [] } },
    });

    const messages: string[] = [];
    const result = await ingestAll(db, api, rules, {
      teamId,
      includePlayerSummaries: true,
      playerIds: [1],
      onProgress: (message) => messages.push(message),
    });

    expect(result.bootstrap.snapshotId).toBeGreaterThan(0);
    expect(result.fixtures.rowsWritten).toBe(2);
    expect(result.summaries?.rowsWritten).toBe(1);
    expect(result.entry?.picksLoaded).toBe(false);
    expect(messages.join('\n')).toMatch(/bootstrap-static/);

    for (const source of ['bootstrap-static', 'fixtures', 'element-summary', 'entry']) {
      expect(lastSuccessfulRun(db, source)).not.toBeNull();
    }
  });

  it('skips per-player history when not asked for it', async () => {
    const db = openTestDatabase();
    const api = new StubFplApi({ bootstrap: fakeBootstrap(), fixtures: [] });
    const result = await ingestAll(db, api, rules, {});
    expect(result.summaries).toBeNull();
    expect(result.entry).toBeNull();
  });
});
