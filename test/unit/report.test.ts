import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { applyEnvOverrides, loadAppConfig, loadConfig, loadRules, ConfigError } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestEntry } from '../../src/ingest/index.js';
import { startServer, type RunningServer } from '../../src/report/server.js';
import { renderDashboard } from '../../src/report/views.js';
import { formatDuration, formatMoney, getStateOfPlay } from '../../src/report/state.js';
import { defaultPlayers, fakeBootstrap, fakeEntry, fakeEvent, fakePicks } from '../support/fakeApi.js';

const rules = loadRules();
const teamId = 2651633;

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
    expect(body).toContain('One time only');
    expect(body).toContain('Every week');
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
});
