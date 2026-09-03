import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { applyEnvOverrides, loadAppConfig, loadConfig, loadRules, ConfigError } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestEntry } from '../../src/ingest/index.js';
import { shouldPrimeOnBoot, startServer, type RunningServer } from '../../src/report/server.js';
import { formatFixtures, renderAccuracy, renderDashboard, renderRecommendation } from '../../src/report/views.js';
import { formatDuration, formatMoney, getStateOfPlay } from '../../src/report/state.js';
import type { SeasonAccuracy } from '../../src/model/accuracy.js';
import { player } from '../support/players.js';
import {
  defaultPlayers,
  fakeBootstrap,
  fakeEntry,
  fakeEvent,
  fakeFixture,
  fakePicks,
} from '../support/fakeApi.js';

const rules = loadRules();
const teamId = 2651633;

describe('boot-time ingest priming', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('primes when there is no data yet', () => {
    expect(shouldPrimeOnBoot(db, 180)).toBe(true);
  });

  it('does not prime again when a deploy restarts the process shortly after a real refresh', async () => {
    // A deploy is not evidence the data is stale - only the clock is. Without this, "last
    // imported" would drift to "just now" on every code push, regardless of how fresh the
    // underlying FPL data actually was.
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
    expect(shouldPrimeOnBoot(db, 180)).toBe(false);
  });

  it('primes again once the last refresh is older than the configured interval', async () => {
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
    db.prepare(
      `UPDATE ingest_run SET started_at = started_at - ? WHERE source = 'bootstrap-static'`,
    ).run(200 * 60);

    expect(shouldPrimeOnBoot(db, 180)).toBe(true);
  });
});

describe('environment overrides', () => {
  const base = loadAppConfig();

  it('redirects the database to a mounted volume, as a deployment needs', () => {
    const config = applyEnvOverrides(base, { FPL_DATABASE_PATH: '/var/data/fpl.db' });
    expect(config.database.path).toBe('/var/data/fpl.db');
  });

  it('overrides the team ID from the environment', () => {
    expect(applyEnvOverrides(base, { FPL_TEAM_ID: '99' }).teamId).toBe(99);
  });

  it('rejects a nonsense team ID rather than silently ignoring it', () => {
    expect(() => applyEnvOverrides(base, { FPL_TEAM_ID: 'not-a-number' })).toThrow(ConfigError);
    expect(() => applyEnvOverrides(base, { FPL_TEAM_ID: '-5' })).toThrow(/positive integer/);
  });

  it('leaves config untouched when nothing is set', () => {
    expect(applyEnvOverrides(base, {})).toEqual(base);
  });

  it('does not let the environment override rules or model weights', () => {
    // Rules live in version control, where a change is reviewable. Only per-environment
    // settings are overridable.
    const overridden = applyEnvOverrides(base, {
      FPL_SQUAD_BUDGET: '99999',
      FPL_MAX_PER_CLUB: '15',
    } as NodeJS.ProcessEnv);
    expect(overridden).toEqual(base);
    expect(loadRules().squad.budget).toBe(1000);
    expect(loadRules().squad.maxPerClub).toBe(3);
  });
});

describe('state of play', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  it('reports every source as stale before anything has been ingested', () => {
    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    expect(state.anyStale).toBe(true);
    expect(state.freshness.every((entry) => entry.lastSuccessAt === null)).toBe(true);
    expect(state.playerCount).toBe(0);
  });

  it('counts a file import as fresh data, not just an API pull', async () => {
    // Both routes write ingest_run rows under different source names. Counting only the API
    // ones made the dashboard say "never" for anyone who imports files.
    const { importPayload } = await import('../../src/ingest/import.js');
    await importPayload(db, rules, JSON.stringify(fakeBootstrap()));

    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    const players = state.freshness.find((entry) => entry.source === 'players & prices');
    expect(players?.lastSuccessAt).not.toBeNull();
    expect(players?.stale).toBe(false);
  });

  it('reports fresh data as fresh after an ingest', async () => {
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    const bootstrap = state.freshness.find((entry) => entry.source === 'players & prices');
    expect(bootstrap?.stale).toBe(false);
    expect(state.playerCount).toBe(60);
  });

  it('never reports "last season" as stale by age - it is a genuine one-off, not a weekly source', () => {
    // A week-old import here is not out of date, it's just untouched since it never needs to
    // be. Judging it by the same few-hours-old threshold as bootstrap-static meant it was
    // permanently flagged stale for anyone who had already done the one-off import correctly.
    const longAgo = nowSeconds() - 7 * 24 * 3600;
    db.prepare(
      `INSERT INTO ingest_run (source, started_at, finished_at, ok, from_cache, rows_written, note)
       VALUES ('element-summary', ?, ?, 1, 0, 1, NULL)`,
    ).run(longAgo, longAgo);

    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    const lastSeason = state.freshness.find((entry) => entry.source === 'last season');
    expect(lastSeason?.stale).toBe(false);
  });

  it('still reports "last season" as stale when it has never been imported at all', () => {
    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    const lastSeason = state.freshness.find((entry) => entry.source === 'last season');
    expect(lastSeason?.stale).toBe(true);
  });

  it('finds the next upcoming deadline and never a past one', async () => {
    const past = fakeEvent(1, { deadline_time: '2020-01-01T00:00:00Z', finished: true });
    const future = fakeEvent(2, { deadline_time: '2099-01-01T00:00:00Z', is_next: true });
    await ingestBootstrap(
      db,
      new StubFplApi({ bootstrap: fakeBootstrap({ events: [past, future] }) }),
      rules,
    );

    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    expect(state.nextDeadline?.eventId).toBe(2);
    expect(state.nextDeadline?.secondsUntil).toBeGreaterThan(0);
  });

  it('explains an empty squad rather than showing a blank list', async () => {
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
    await ingestEntry(
      db,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: null }) },
        history: { [teamId]: { current: [], chips: [] } },
      }),
      teamId,
      rules,
    );

    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    expect(state.squadLoaded).toBe(false);
    expect(state.squadNote).toMatch(/before the first deadline/i);
  });

  it('keeps showing the real squad when the latest refresh attempt for a new gameweek came back with no picks yet', async () => {
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap() }), rules);
    await ingestEntry(
      db,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: 1 }) },
        history: { [teamId]: { current: [], chips: [] } },
        picks: { [`${teamId}:1`]: fakePicks([1, 2, 3, 4, 5]) },
      }),
      teamId,
      rules,
    );

    // Gameweek 2 becomes current, but this refresh could not retrieve picks for it yet (no
    // `picks` entry configured makes the stub 404, exactly like the real API right around a
    // deadline). ingestEntry() still records a manager_state snapshot for it, with zero
    // squad_pick rows, more recent than the perfectly good gameweek 1 one.
    await ingestEntry(
      db,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: 2 }) },
        history: { [teamId]: { current: [], chips: [] } },
      }),
      teamId,
      rules,
    );

    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    expect(state.squadLoaded).toBe(true);
    expect(state.squad.map((p) => p.playerId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('surfaces flagged players in the squad', async () => {
    const players = defaultPlayers().map((player) =>
      player.id === 1
        ? { ...player, status: 'i', news: 'Knee injury - out until December', chance_of_playing_next_round: 0 }
        : player,
    );
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap({ players }) }), rules);
    await ingestEntry(
      db,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: 1 }) },
        history: { [teamId]: { current: [], chips: [] } },
        picks: { [`${teamId}:1`]: fakePicks([1, 2, 3, 4, 5]) },
      }),
      teamId,
      rules,
    );

    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    expect(state.flaggedInSquad.map((player) => player.playerId)).toContain(1);
    expect(state.flaggedInSquad[0]?.news).toMatch(/Knee injury/);
  });

  it('marks which recent changes affect the squad', async () => {
    const first = defaultPlayers();
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap({ players: first }) }), rules);
    const second = first.map((player) =>
      player.id === 1 ? { ...player, now_cost: player.now_cost + 1 } : player,
    );
    await ingestBootstrap(db, new StubFplApi({ bootstrap: fakeBootstrap({ players: second }) }), rules);
    await ingestEntry(
      db,
      new StubFplApi({
        entry: { [teamId]: fakeEntry(teamId, { current_event: 1 }) },
        history: { [teamId]: { current: [], chips: [] } },
        picks: { [`${teamId}:1`]: fakePicks([1, 2, 3]) },
      }),
      teamId,
      rules,
    );

    const state = getStateOfPlay(db, { teamId, staleAfterSeconds: 3600 });
    const change = state.recentChanges.find((entry) => entry.playerId === 1);
    expect(change?.inSquad).toBe(true);
  });
});

describe('formatting helpers', () => {
  it('formats money from tenths of a million', () => {
    expect(formatMoney(1000)).toBe('£100.0m');
    expect(formatMoney(45)).toBe('£4.5m');
    expect(formatMoney(null)).toBe('unknown');
  });

  it('formats durations readably', () => {
    expect(formatDuration(null)).toBe('never');
    expect(formatDuration(30)).toBe('<1m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(90000)).toBe('1d 1h');
  });
});

describe('formatFixtures', () => {
  it('shows BLANK for no fixture', () => {
    expect(formatFixtures([])).toContain('BLANK');
  });

  it('marks home and away distinctly', () => {
    expect(formatFixtures([{ opponentShort: 'LIV', isHome: true, difficulty: 2 }])).toContain('vs LIV');
    expect(formatFixtures([{ opponentShort: 'LIV', isHome: false, difficulty: 2 }])).toContain('@ LIV');
  });

  it('flags a hard fixture but not an easy one', () => {
    const hard = formatFixtures([{ opponentShort: 'LIV', isHome: false, difficulty: 5 }]);
    const easy = formatFixtures([{ opponentShort: 'HUL', isHome: true, difficulty: 2 }]);
    expect(hard).toContain('pill bad');
    expect(easy).not.toContain('pill bad');
  });

  it('joins a double gameweek with a plus', () => {
    const double = formatFixtures([
      { opponentShort: 'LIV', isHome: false, difficulty: 5 },
      { opponentShort: 'HUL', isHome: true, difficulty: 2 },
    ]);
    expect(double).toContain('@ LIV');
    expect(double).toContain('vs HUL');
    expect(double).toContain('+');
  });

  it('omits the FDR pill when the API gives no difficulty rating', () => {
    const result = formatFixtures([{ opponentShort: 'LIV', isHome: true, difficulty: null }]);
    expect(result).not.toContain('FDR');
    expect(result).not.toContain('pill');
  });
});

describe('report server', () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(): Promise<string> {
    const config = loadConfig();
    // Port 0 picks a free port; the scheduler is off so these tests never reach the network.
    server = await startServer({
      config: { ...config, app: { ...config.app, database: { path: ':memory:' } } },
      port: 0,
      ingestIntervalMinutes: 0,
    });
    return `http://127.0.0.1:${server.port}`;
  }

  it('answers the health check without touching the FPL API', async () => {
    // Render restarts a service whose health check fails. If this depended on the FPL API
    // being up, a third-party outage would put the deployment into a restart loop.
    const base = await start();
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('serves the report page', async () => {
    const base = await start();
    const response = await fetch(base);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(body).toMatch(/FPL Optimiser/);
  });

  it('serves machine-readable state', async () => {
    const base = await start();
    const response = await fetch(`${base}/state.json`);
    const body = (await response.json()) as { freshness: unknown[]; anyStale: boolean };
    expect(response.status).toBe(200);
    expect(body.freshness).toHaveLength(4);
    expect(body.anyStale).toBe(true);
  });

  it('warns on the page when the data behind it is stale', async () => {
    const base = await start();
    const body = await (await fetch(base)).text();
    expect(body).toMatch(/Some data is stale/);
  });

  it('shows the tab bar on every page, so navigation is consistent', async () => {
    const base = await start();
    for (const path of ['/', '/import', '/reset']) {
      const body = await (await fetch(`${base}${path}`)).text();
      expect(body, path).toMatch(/nav class="tabs"/);
      for (const label of ['Dashboard', 'My Team', 'Chips', 'Import Data', 'Reset']) {
        expect(body, `${path} missing ${label}`).toContain(label);
      }
    }
  });

  it('marks exactly one tab as current', async () => {
    const base = await start();
    const body = await (await fetch(`${base}/import`)).text();
    // Count only the attribute on a real element - the stylesheet contains a matching
    // selector, which is not a second active tab.
    const current = body.match(/aria-current="page">/g) ?? [];
    expect(current).toHaveLength(1);
    expect(body).toMatch(/href="\/import"[^>]*aria-current="page"/);
  });

  it('serves the import screen with a slot for each kind of data', async () => {
    const base = await start();
    const body = await (await fetch(`${base}/import`)).text();

    expect(body).toContain("This season's player data");
    expect(body).toContain('Fixtures');
    expect(body).toContain("Last season's stats");
    expect(body).toContain('Your squad');
    // Cadence is the point of splitting them up.
    expect(body).toContain('Nothing to do - automatic');
    expect(body).toContain('Every week');
  });

  it('offers a manual fetch button, so nothing ever strictly requires an upload', async () => {
    const base = await start();
    const body = await (await fetch(`${base}/import`)).text();

    expect(body).toContain('id="fetch-now"');
    expect(body).toMatch(/fetch\('\/ingest'/);
  });

  it('keeps the old /upload link working', async () => {
    const base = await start();
    const response = await fetch(`${base}/upload`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/import');
  });

  it('refuses a file dropped into the wrong slot, and says what it actually was', async () => {
    const base = await start();
    // A fixtures array pushed into the last-season slot.
    const response = await fetch(`${base}/import?slot=last-season&name=fixtures.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify([{ id: 1, event: 1, team_h: 1, team_a: 2 }]),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/looks like the fixture list/);
    expect(body.error).toMatch(/this slot expects/);
  });

  it('rejects an unknown slot rather than importing anyway', async () => {
    const base = await start();
    const response = await fetch(`${base}/import?slot=nonsense`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/Unknown import slot/);
  });

  it('404s an unknown path', async () => {
    const base = await start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('explains the league table is automatic once player data exists, with nothing to import', async () => {
    const base = await start();
    await fetch(`${base}/import?slot=this-season&name=a.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(fakeBootstrap()),
    });

    const body = await (await fetch(base)).text();
    expect(body).toMatch(/There is\s*\n?\s*nothing to import for this either/);
    expect(body).toMatch(/gameweek 1 fills this in automatically/);
  });

  it('shows no league table section at all before any data is imported', async () => {
    const base = await start();
    const body = await (await fetch(base)).text();
    expect(body).not.toContain('League table');
  });

  it('labels each reset button with the human title, not the raw scope slug', async () => {
    const base = await start();
    const body = await (await fetch(`${base}/reset`)).text();

    expect(body).toContain('Remove This season\'s player data');
    expect(body).toContain('Remove Fixtures');
    expect(body).toContain('Remove Last season\'s stats');
    expect(body).toContain('Remove Your squad');
    // The raw slug must not leak into the visible label.
    expect(body).not.toMatch(/Remove this-season\b/);
    expect(body).not.toMatch(/Remove last-season\b/);
  });

  describe('/optimise readiness gate', () => {
    async function importSlot(base: string, slot: string, body: unknown): Promise<void> {
      const response = await fetch(`${base}/import?slot=${slot}&name=${slot}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
      });
      expect(response.status, `importing ${slot}`).toBe(200);
    }

    /**
     * A minimal but genuinely feasible squad: exactly 2 GKP/5 DEF/5 MID/3 FWD spread across
     * five clubs (never more than three per club), all cheap enough to fit the budget with
     * room to spare. defaultPlayers()'s four clubs cannot build a 15 at all - three-per-club
     * caps them at 12 - so a solver failure there would be mistaken for the readiness gate
     * still being shut.
     */
    function feasibleBootstrap() {
      const teams = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        name: `Club ${i + 1}`,
        short_name: `C${i + 1}`,
      }));
      // [element_type, club] pairs, three per club, position totals exactly 2/5/5/3.
      const shape: Array<[number, number]> = [
        [1, 1], [2, 1], [2, 1], // club 1: 1 GKP, 2 DEF
        [1, 2], [2, 2], [2, 2], // club 2: 1 GKP, 2 DEF
        [2, 3], [3, 3], [3, 3], // club 3: 1 DEF, 2 MID
        [3, 4], [3, 4], [3, 4], // club 4: 3 MID
        [4, 5], [4, 5], [4, 5], // club 5: 3 FWD
      ];
      const players = shape.map(([elementType, team], index) => ({
        id: index + 1,
        web_name: `P${index + 1}`,
        team,
        element_type: elementType,
        now_cost: 40,
        minutes: 900,
        starts: 10,
      }));
      return fakeBootstrap({
        teams,
        players,
        events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-21T17:30:00Z' })],
      });
    }

    async function importReadyData(base: string): Promise<void> {
      await importSlot(base, 'this-season', feasibleBootstrap());
      await importSlot(base, 'fixtures', [fakeFixture(1, 1, 1, 2), fakeFixture(2, 1, 3, 4)]);
      await importSlot(base, 'last-season', {
        history: [{ element: 1, fixture: 500, minutes: 90 }],
        history_past: [{ season_name: '2025/26', total_points: 180, minutes: 3000 }],
      });
    }

    it('never generates a team just from visiting the page', async () => {
      const base = await start();
      const response = await fetch(`${base}/optimise`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toMatch(/Nothing is generated until you click the button/);
      expect(body).not.toMatch(/Regenerate/);
    });

    it('lists what is missing when nothing has been imported yet', async () => {
      const base = await start();
      const body = await (await fetch(`${base}/optimise`)).text();

      expect(body).toContain("This season's player data");
      expect(body).toContain("Last season's stats");
    });

    it('refuses to generate over the JSON API until the required imports are in', async () => {
      const base = await start();
      const response = await fetch(`${base}/optimise.json`);
      const body = (await response.json()) as { error: string; missing: string[] };

      expect(response.status).toBe(409);
      expect(body.error).toMatch(/Not ready to generate/);
      expect(body.missing.length).toBeGreaterThan(0);
    });

    it('blocks an explicit generate attempt with a 409 and explains why', async () => {
      const base = await start();
      const response = await fetch(`${base}/optimise?generate=1`);
      const body = await response.text();

      expect(response.status).toBe(409);
      expect(body).toMatch(/Not ready to generate yet/);
    });

    it('generates once every required import is present', async () => {
      const base = await start();
      await importReadyData(base);

      const response = await fetch(`${base}/optimise?generate=1`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toMatch(/Regenerate/);
    });

    it('serves the JSON recommendation once ready, without needing generate=1', async () => {
      const base = await start();
      await importReadyData(base);

      const response = await fetch(`${base}/optimise.json`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { mode: string };
      expect(body.mode).toBeDefined();
    });

    it('shows each starter\'s fixture and explains what confidence does and does not mean', async () => {
      const base = await start();
      await importReadyData(base);

      const body = await (await fetch(`${base}/optimise?generate=1`)).text();

      expect(body).toContain('<th>Fixture</th>');
      // Every starter has a club playing gameweek 1 in feasibleBootstrap, so each row shows a
      // fixture rather than a blank.
      expect(body).toMatch(/vs C\d|@ C\d/);
      expect(body).toMatch(/not whether this is a good pick/);
    });

    it('shows no "changed since" card the first time there is nothing to compare against', async () => {
      const base = await start();
      await importReadyData(base);

      const body = await (await fetch(`${base}/optimise?generate=1`)).text();
      expect(body).not.toMatch(/Changed since/);
    });
  });

  it('escapes third-party text before putting it in the page', () => {
    // News and player names come from the FPL API - text this app does not control, rendered
    // straight into HTML. It must be escaped, not trusted.
    const hostile = '<script>alert("xss")</script>';
    const page = renderDashboard({
      generatedAt: 1_760_000_000,
      teamId: 2651633,
      freshness: [],
      anyStale: false,
      playerCount: 1,
      snapshotCount: 1,
      nextDeadline: null,
      squadLoaded: true,
      squadNote: null,
      bank: 5,
      teamValue: 1000,
      freeTransfers: 1,
      freeTransfersSource: 'derived',
      chipsAvailable: [],
      squad: [
        {
          playerId: 1,
          name: hostile,
          team: 'ALP',
          position: 'MID',
          slot: 1,
          isCaptain: false,
          isViceCaptain: false,
          price: 55,
          status: 'i',
          chanceOfPlaying: 0,
          news: hostile,
        },
      ],
      flaggedInSquad: [],
      recentChanges: [
        { detectedAt: 1_760_000_000, playerId: 1, name: hostile, kind: 'news', note: hostile, inSquad: true },
      ],
    });

    expect(page).not.toContain('<script>alert');
    expect(page).toContain('&lt;script&gt;');
  });

  it('offers "end gameweek" once a squad is loaded, not before there is one to end', () => {
    const base = {
      generatedAt: 1_760_000_000,
      teamId: 2651633,
      freshness: [],
      anyStale: false,
      playerCount: 1,
      snapshotCount: 1,
      nextDeadline: null,
      squadNote: null,
      bank: 5,
      teamValue: 1000,
      freeTransfers: 1,
      freeTransfersSource: 'derived',
      chipsAvailable: [],
      squad: [],
      flaggedInSquad: [],
      recentChanges: [],
    };

    expect(renderDashboard({ ...base, squadLoaded: false })).not.toMatch(/End gameweek/);
    const withSquad = renderDashboard({ ...base, squadLoaded: true });
    expect(withSquad).toMatch(/End gameweek/);
    expect(withSquad).toContain('/optimise?generate=1&refresh=1');
  });
});

describe('accuracy page', () => {
  const gameweek = (overrides: Partial<SeasonAccuracy['gameweeks'][number]> = {}) => ({
    eventId: 1,
    playersScored: 40,
    meanAbsoluteError: 1.6,
    bias: 0.2,
    recommendedXiPredicted: 62.5,
    recommendedXiActual: 55,
    bestPossibleFromSquad: 71,
    yourActual: 61,
    leagueAverage: 57,
    leagueHighest: 129,
    ...overrides,
  });

  const season = (overrides: Partial<SeasonAccuracy> = {}): SeasonAccuracy => ({
    gameweeks: [gameweek()],
    overall: { playersScored: 40, meanAbsoluteError: 1.6, bias: 0.2, gameweeks: 1 },
    notes: [],
    ...overrides,
  });

  it('shows the projection and the outcome side by side for every gameweek', () => {
    // The whole point of the page. Before this, a gameweek's projected total was not on the
    // page at all - only what it went on to score - so there was nothing to learn from.
    const page = renderAccuracy(season(), null);
    expect(page).toMatch(/We projected/);
    expect(page).toMatch(/62\.5/);
    expect(page).toMatch(/It scored/);
    expect(page).toMatch(/>55</);
  });

  it('states the size and direction of the miss in words, not just a number', () => {
    const under = renderAccuracy(
      season({ gameweeks: [gameweek({ recommendedXiPredicted: 20, recommendedXiActual: 75 })] }),
      null,
    );
    expect(under).toMatch(/55\.0 too low/);

    const over = renderAccuracy(
      season({ gameweeks: [gameweek({ recommendedXiPredicted: 75, recommendedXiActual: 20 })] }),
      null,
    );
    expect(over).toMatch(/55\.0 too high/);
  });

  it('does not claim a miss for a gameweek that has not been scored yet', () => {
    const page = renderAccuracy(
      season({ gameweeks: [gameweek({ recommendedXiActual: null, bestPossibleFromSquad: null })] }),
      null,
    );
    expect(page).toMatch(/not scored yet/);
    expect(page).not.toMatch(/too (low|high)/);
  });

  it('leads with a plain-English verdict across the graded gameweeks', () => {
    const page = renderAccuracy(
      season({
        gameweeks: [
          gameweek({ eventId: 1, recommendedXiPredicted: 60, recommendedXiActual: 61 }),
          gameweek({ eventId: 2, recommendedXiPredicted: 64, recommendedXiActual: 96 }),
        ],
      }),
      null,
    );
    // 124 projected against 157 actual, over two gameweeks: 16.5 a week too low.
    expect(page).toMatch(/projected at <strong>124\.0<\/strong>/);
    expect(page).toMatch(/scored <strong>157<\/strong>/);
    expect(page).toMatch(/16\.5 points a week too low/);
  });

  it('folds the explanations away behind a summary rather than opening with prose', () => {
    const page = renderAccuracy(season(), null);
    expect(page).toMatch(/<summary>What am I looking at\?<\/summary>/);
    // The auto-sub caveat is still there for anyone who wants it - just not in the way.
    expect(page).toMatch(/auto-sub rules/);
  });

  it('says nothing at all when there is nothing graded', () => {
    const page = renderAccuracy({ gameweeks: [], overall: null, notes: ['Nothing to grade yet.'] }, null);
    expect(page).toMatch(/Nothing to grade yet\./);
    expect(page).not.toMatch(/We projected/);
  });
});

describe('priority-fix team on My Team', () => {
  const pitchPlayer = (name: string, position: string, xPts: number, club: number, price: number) => ({
    ...player({ name, position, xPts, clubId: club, price }),
    fixtures: [{ opponentShort: 'AVL', isHome: true, difficulty: 3 }],
  });

  function recommendation(planOverrides: Record<string, unknown>) {
    const starters = [
      pitchPlayer('Keeper', 'GKP', 4.2, 1, 55),
      pitchPlayer('Back One', 'DEF', 5.1, 1, 60),
      pitchPlayer('Back Two', 'DEF', 4.8, 2, 60),
      pitchPlayer('Back Three', 'DEF', 4.4, 3, 55),
      pitchPlayer('Mid One', 'MID', 8.9, 4, 145),
      pitchPlayer('Mid Two', 'MID', 6.7, 5, 100),
      pitchPlayer('Mid Three', 'MID', 6.4, 6, 105),
      pitchPlayer('Mid Four', 'MID', 5.2, 7, 75),
      pitchPlayer('Mid Five', 'MID', 5.0, 8, 80),
      pitchPlayer('Front One', 'FWD', 9.6, 2, 145),
      pitchPlayer('Front Two', 'FWD', 5.4, 9, 75),
    ];
    const bench = [
      pitchPlayer('Sub Keeper', 'GKP', 3.4, 9, 50),
      pitchPlayer('Sub One', 'DEF', 3.1, 10, 45),
      pitchPlayer('Sub Two', 'DEF', 2.9, 11, 40),
      pitchPlayer('Sub Three', 'FWD', 2.6, 12, 55),
    ];
    const eleven = {
      starters, bench, captain: starters[9]!, viceCaptain: starters[4]!,
      formation: '3-5-2', expectedPoints: 75.3,
    };
    return {
      mode: 'existing-squad', eventId: 3, eventName: 'Gameweek 3', deadlineIso: null,
      modelVersion: 'heuristic-0.15.0', generatedAt: 0,
      squad: [...starters, ...bench], eleven, totalCost: 1000, bankRemaining: 5,
      transfers: [], transferPlan: null, previousComparison: null, notes: [],
      playersConsidered: 640, lowConfidence: false,
      evidence: {
        intelCompiledAt: null, intelSources: [], intelApplied: 0, intelUnmatched: [],
        intelPriceMismatches: 0, contextNotes: [], eliteSampleSize: 0, usingPreviousSeason: 0,
        horizonGameweeks: 5, calibration: [],
      },
      priorityFixPlan: {
        moves: [
          { out: pitchPlayer('Dead One', 'DEF', 0.42, 13, 45), in: pitchPlayer('Back Two', 'DEF', 4.8, 2, 60) },
          { out: pitchPlayer('Dead Two', 'DEF', 0.61, 14, 40), in: pitchPlayer('Back Three', 'DEF', 4.4, 3, 55) },
          { out: pitchPlayer('Dead Three', 'FWD', 0.88, 15, 55), in: pitchPlayer('Front Two', 'FWD', 5.4, 9, 75) },
        ],
        unresolved: [],
        freeTransfers: 1, hitsTaken: 2, hitCost: 8,
        elevenBefore: { ...eleven, expectedPoints: 66.1 }, eleven,
        gainBeforeHit: 9.2, horizonGain: 6.4, netGain: 7.6,
        totalCost: 1005, bankRemaining: 5,
        ...planOverrides,
      },
    };
  }

  it('states the hit cost in plain points, not just a transfer count', () => {
    // The thing a list of transfer cards cannot tell you: each is costed as the only move of
    // the week, so three cards each showing a gain hide the eight points they cost together.
    const page = renderRecommendation(recommendation({}) as never);
    expect(page).toMatch(/3 transfers<\/strong>, 1 free/);
    expect(page).toMatch(/2 hits at\s+4 points each, costing you\s+8 points/);
  });

  it('says plainly when the hits cost more than the fixes gain', () => {
    const page = renderRecommendation(
      recommendation({ gainBeforeHit: 3.1, horizonGain: 1.2, netGain: -3.7 }) as never,
    );
    expect(page).toMatch(/net loss of\s+3\.7/);
    expect(page).toMatch(/not worth it/);
    expect(page).toMatch(/Spread the fixes over the next few gameweeks/);
    expect(page).not.toMatch(/worth doing/);
  });

  it('calls it worth doing when the gain clears the hit', () => {
    const page = renderRecommendation(recommendation({}) as never);
    expect(page).toMatch(/worth doing/);
    expect(page).not.toMatch(/net loss of/);
  });

  it('does not talk about hits at all when the free transfers cover it', () => {
    const page = renderRecommendation(
      recommendation({
        moves: [
          { out: pitchPlayer('Dead One', 'DEF', 0.42, 13, 45), in: pitchPlayer('Back Two', 'DEF', 4.8, 2, 60) },
        ],
        freeTransfers: 2, hitsTaken: 0, hitCost: 0,
      }) as never,
    );
    expect(page).toMatch(/all covered by your 2 free/);
    expect(page).toMatch(/<strong>no hit<\/strong>/);
  });

  it('signs the price change, so a downgrade is not read as an upgrade', () => {
    const page = renderRecommendation(
      recommendation({
        moves: [
          { out: pitchPlayer('Dead One', 'DEF', 0.42, 13, 60), in: pitchPlayer('Cheap', 'DEF', 4.8, 2, 45) },
        ],
      }) as never,
    );
    expect(page).toMatch(/&minus;£1\.5m/);
  });

  it('names any dead slot it could not fix rather than quietly dropping it', () => {
    const page = renderRecommendation(
      recommendation({ unresolved: [pitchPlayer('Stuck Keeper', 'GKP', 0.3, 16, 40)] }) as never,
    );
    expect(page).toMatch(/Stuck Keeper could not be fixed/);
  });

  it('shows nothing at all when the squad has no dead slots', () => {
    const rec = recommendation({}) as Record<string, unknown>;
    rec.priorityFixPlan = null;
    const page = renderRecommendation(rec as never);
    expect(page).not.toMatch(/Your team with every priority fix/);
  });
});
