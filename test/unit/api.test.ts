import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client.js';
import { HttpFplApi } from '../../src/api/httpClient.js';
import { ReplayFplApi, StubFplApi } from '../../src/api/replayClient.js';
import { bootstrapSchema, elementSchema, numeric } from '../../src/api/schemas.js';
import { loadAppConfig } from '../../src/config/load.js';
import { fakeBootstrap, fakeEntry, fakePicks, fakePlayer } from '../support/fakeApi.js';

const apiConfig = () => ({
  ...loadAppConfig().api,
  // Point the cache somewhere disposable; resolveFromRoot will place it under the project.
  cacheDir: `.cache-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  minRequestIntervalMs: 100,
  retryBackoffMs: 10,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A controllable clock and sleep, so throttling and TTLs are tested without real waiting. */
function fakeClock(startMs = 1_760_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('schema coercion', () => {
  it('accepts numbers the API sends as strings', () => {
    expect(numeric().parse('4.2')).toBe(4.2);
    expect(numeric().parse(4.2)).toBe(4.2);
  });

  it('turns absent or unparseable numbers into null, never NaN', () => {
    for (const input of [null, undefined, '', 'n/a']) {
      const result = numeric().parse(input);
      expect(result).toBeNull();
      expect(Number.isNaN(result as number)).toBe(false);
    }
  });

  it('tolerates an optional field being absent entirely, not just null', () => {
    // The API drops fields between seasons. A missing key must behave like a null value,
    // otherwise a partial recording or a trimmed payload takes the whole app down.
    expect(numeric().parse(undefined)).toBeNull();

    const player = fakePlayer({ id: 1, web_name: 'X', team: 1, element_type: 3, now_cost: 60 });
    delete (player as Record<string, unknown>).defensive_contribution;
    delete (player as Record<string, unknown>).expected_goals;
    delete (player as Record<string, unknown>).news;

    const parsed = elementSchema.parse(player);
    expect(parsed.defensive_contribution).toBeNull();
    expect(parsed.expected_goals).toBeNull();
    expect(parsed.news).toBeNull();
  });

  it('parses a realistic element, coercing its string stats', () => {
    const parsed = elementSchema.parse(
      fakePlayer({ id: 7, web_name: 'Tester', team: 1, element_type: 3, now_cost: 75, form: 6.5 }),
    );
    expect(parsed.form).toBe(6.5);
    expect(parsed.now_cost).toBe(75);
    expect(parsed.selected_by_percent).toBeTypeOf('number');
  });

  it('keeps unmodelled fields rather than rejecting the payload', () => {
    const payload = fakeBootstrap();
    (payload as Record<string, unknown>).brand_new_2027_field = { anything: true };
    const parsed = bootstrapSchema.parse(payload);
    expect((parsed as Record<string, unknown>).brand_new_2027_field).toEqual({ anything: true });
  });

  it('fails loudly when a field the optimiser depends on is missing', () => {
    const player = fakePlayer({ id: 1, web_name: 'X', team: 1, element_type: 2, now_cost: 45 });
    delete (player as Record<string, unknown>).element_type;
    expect(() => elementSchema.parse(player)).toThrow();
  });

  it('fails loudly when a price is not a number', () => {
    const player = fakePlayer({ id: 1, web_name: 'X', team: 1, element_type: 2, now_cost: 45 });
    (player as Record<string, unknown>).now_cost = 'not a price';
    expect(() => elementSchema.parse(player)).toThrow();
  });
});

describe('HttpFplApi', () => {
  let cacheDirs: string[] = [];

  afterEach(() => {
    for (const dir of cacheDirs) {
      rmSync(resolve(process.cwd(), dir), { recursive: true, force: true });
    }
    cacheDirs = [];
  });

  function makeApi(
    handler: (url: string, init: { headers: Record<string, string> }) => Promise<Response>,
    overrides: Partial<ReturnType<typeof apiConfig>> = {},
  ) {
    const config = { ...apiConfig(), ...overrides };
    cacheDirs.push(config.cacheDir);
    const clock = fakeClock();
    const warnings: string[] = [];
    const api = new HttpFplApi(config, {
      fetch: handler as never,
      now: clock.now,
      sleep: clock.sleep,
      onWarning: (message) => warnings.push(message),
    });
    return { api, clock, warnings, config };
  }

  it('sends the configured descriptive User-Agent', async () => {
    const seen: Record<string, string>[] = [];
    const { api, config } = makeApi(async (_url, init) => {
      seen.push(init.headers);
      return jsonResponse(fakeBootstrap());
    });
    await api.bootstrap();
    expect(seen[0]?.['User-Agent']).toBe(config.userAgent);
    expect(seen[0]?.['User-Agent']).toMatch(/fpl-optimiser/);
  });

  it('requests the documented endpoint paths', async () => {
    const urls: string[] = [];
    const { api } = makeApi(async (url) => {
      urls.push(url);
      if (url.includes('bootstrap')) return jsonResponse(fakeBootstrap());
      if (url.includes('picks')) return jsonResponse(fakePicks([1, 2, 3]));
      if (url.includes('entry')) return jsonResponse(fakeEntry(1234567));
      return jsonResponse([]);
    });

    await api.bootstrap();
    await api.fixtures();
    await api.fixtures(3);
    await api.entry(1234567);
    await api.entryPicks(1234567, 2);

    expect(urls[0]).toBe('https://fantasy.premierleague.com/api/bootstrap-static/');
    expect(urls[1]).toBe('https://fantasy.premierleague.com/api/fixtures/');
    expect(urls[2]).toBe('https://fantasy.premierleague.com/api/fixtures/?event=3');
    expect(urls[3]).toBe('https://fantasy.premierleague.com/api/entry/1234567/');
    expect(urls[4]).toBe('https://fantasy.premierleague.com/api/entry/1234567/event/2/picks/');
  });

  it('throttles consecutive requests to the configured minimum interval', async () => {
    const startTimes: number[] = [];
    const { api, clock } = makeApi(async () => {
      startTimes.push(clock.now());
      return jsonResponse([]);
    });

    await api.fixtures(1);
    await api.fixtures(2);
    await api.fixtures(3);

    expect(startTimes).toHaveLength(3);
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(100);
    expect(startTimes[2]! - startTimes[1]!).toBeGreaterThanOrEqual(100);
  });

  it('serves a second call from cache without hitting the network', async () => {
    let calls = 0;
    const { api } = makeApi(async () => {
      calls += 1;
      return jsonResponse(fakeBootstrap());
    });

    const first = await api.bootstrap();
    const second = await api.bootstrap();

    expect(calls).toBe(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it('refetches once the cache TTL has expired', async () => {
    let calls = 0;
    const { api, clock, config } = makeApi(async () => {
      calls += 1;
      return jsonResponse(fakeBootstrap());
    });

    await api.bootstrap();
    clock.advance((config.cacheTtlSeconds.bootstrap + 1) * 1000);
    const refreshed = await api.bootstrap();

    expect(calls).toBe(2);
    expect(refreshed.fromCache).toBe(false);
  });

  it('retries server errors and succeeds when the API recovers', async () => {
    let calls = 0;
    const { api } = makeApi(async () => {
      calls += 1;
      return calls < 3 ? jsonResponse({ error: 'boom' }, 503) : jsonResponse(fakeBootstrap());
    });

    const result = await api.bootstrap();
    expect(calls).toBe(3);
    expect(result.data.elements.length).toBeGreaterThan(0);
  });

  it('retries rate limiting rather than giving up', async () => {
    let calls = 0;
    const { api } = makeApi(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 429) : jsonResponse([]);
    });
    await api.fixtures();
    expect(calls).toBe(2);
  });

  it('does not retry a 404 - asking again will not help', async () => {
    let calls = 0;
    const { api } = makeApi(async () => {
      calls += 1;
      return jsonResponse({ detail: 'Not found.' }, 404);
    });

    await expect(api.entryPicks(1234567, 1)).rejects.toThrow(ApiError);
    expect(calls).toBe(1);
  });

  it('marks a 404 so callers can treat a missing squad as expected, not broken', async () => {
    const { api } = makeApi(async () => jsonResponse({ detail: 'Not found.' }, 404));
    await api.entryPicks(1234567, 1).catch((error: ApiError) => {
      expect(error.notFound).toBe(true);
      expect(error.status).toBe(404);
    });
    expect.assertions(2);
  });

  it('falls back to stale cache with a warning when a refresh fails', async () => {
    let failNext = false;
    const { api, clock, warnings, config } = makeApi(async () => {
      if (failNext) return jsonResponse({ error: 'down' }, 503);
      return jsonResponse(fakeBootstrap());
    });

    const fresh = await api.bootstrap();
    clock.advance((config.cacheTtlSeconds.bootstrap + 60) * 1000);
    failNext = true;

    const stale = await api.bootstrap();

    expect(stale.fromCache).toBe(true);
    expect(stale.fetchedAt).toBe(fresh.fetchedAt);
    expect(warnings.join(' ')).toMatch(/cached data from/i);
    expect(warnings.join(' ')).toMatch(/caution/i);
  });

  it('reports the true age of stale data rather than pretending it is fresh', async () => {
    let failNext = false;
    const { api, clock, config } = makeApi(async () =>
      failNext ? jsonResponse({}, 500) : jsonResponse(fakeBootstrap()),
    );

    await api.bootstrap();
    const ageSeconds = (config.cacheTtlSeconds.bootstrap + 3600) * 1;
    clock.advance(ageSeconds * 1000);
    failNext = true;

    const stale = await api.bootstrap();
    const nowSeconds = Math.floor(clock.now() / 1000);
    expect(nowSeconds - stale.fetchedAt).toBeGreaterThanOrEqual(ageSeconds);
  });

  it('gives up with a clear error when there is no cache to fall back on', async () => {
    const { api } = makeApi(async () => jsonResponse({}, 503));
    await expect(api.bootstrap()).rejects.toThrow(/failed after \d+ attempts|returned 503/);
  });

  it('rejects a response whose shape the optimiser cannot rely on', async () => {
    const { api } = makeApi(async () => jsonResponse({ elements: 'not an array' }));
    await expect(api.bootstrap()).rejects.toThrow(/did not match the expected shape/);
  });
});

describe('ReplayFplApi', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'fpl-replay-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replays a recorded bootstrap payload through the live schemas', async () => {
    writeFileSync(resolve(dir, 'bootstrap-static.json'), JSON.stringify(fakeBootstrap()));
    const api = new ReplayFplApi(dir);
    const result = await api.bootstrap();
    expect(result.data.teams.length).toBeGreaterThan(0);
    expect(result.fromCache).toBe(true);
  });

  it('filters the full fixture list when no per-event recording exists', async () => {
    writeFileSync(
      resolve(dir, 'fixtures.json'),
      JSON.stringify([
        { id: 1, event: 1, team_h: 1, team_a: 2, kickoff_time: null, started: false, finished: false },
        { id: 2, event: 2, team_h: 3, team_a: 4, kickoff_time: null, started: false, finished: false },
      ]),
    );
    const api = new ReplayFplApi(dir);
    const result = await api.fixtures(2);
    expect(result.data.map((f) => f.id)).toEqual([2]);
  });

  it('treats a missing recording as a 404, matching the live client', async () => {
    const api = new ReplayFplApi(dir);
    await expect(api.entryPicks(1234567, 1)).rejects.toMatchObject({ notFound: true });
  });

  it('surfaces a recording that no longer matches the schema', async () => {
    writeFileSync(resolve(dir, 'bootstrap-static.json'), JSON.stringify({ elements: [] }));
    const api = new ReplayFplApi(dir);
    await expect(api.bootstrap()).rejects.toThrow(/did not match the expected shape/);
  });
});

describe('StubFplApi', () => {
  it('serves in-memory payloads', async () => {
    const api = new StubFplApi({ bootstrap: fakeBootstrap(), entry: { 42: fakeEntry(42) } });
    expect((await api.bootstrap()).data.elements.length).toBeGreaterThan(0);
    expect((await api.entry(42)).data.id).toBe(42);
  });

  it('404s for anything not stubbed', async () => {
    const api = new StubFplApi({});
    await expect(async () => api.entry(1)).rejects.toMatchObject({ notFound: true });
  });
});
