import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { ApiError, type ApiResult, type FplApi } from './client.js';
import {
  bootstrapSchema,
  elementSummarySchema,
  entryHistorySchema,
  entrySchema,
  fixturesSchema,
  leagueStandingsSchema,
  picksSchema,
  type ApiElementSummary,
  type ApiEntry,
  type ApiEntryHistory,
  type ApiFixtures,
  type ApiLeagueStandings,
  type ApiPicks,
  type Bootstrap,
} from './schemas.js';

/**
 * Reads recorded API payloads from a directory instead of the network.
 *
 * This is how the app is developed and tested without touching the FPL servers, and how a
 * recorded payload can be replayed to reproduce a past recommendation exactly. It runs the
 * same schemas as the live client, so a recording that no longer parses is a real signal.
 *
 * Expected filenames:
 *   bootstrap-static.json
 *   fixtures.json, fixtures-event-{gw}.json
 *   element-summary-{playerId}.json
 *   entry-{teamId}.json
 *   entry-{teamId}-event-{gw}-picks.json
 *   entry-{teamId}-history.json
 */
export class ReplayFplApi implements FplApi {
  private readonly dir: string;
  private readonly fetchedAt: number;

  constructor(dir: string, options: { fetchedAt?: number } = {}) {
    this.dir = dir;
    this.fetchedAt = options.fetchedAt ?? Math.floor(Date.now() / 1000);
  }

  bootstrap(): Promise<ApiResult<Bootstrap>> {
    return this.read('bootstrap-static.json', bootstrapSchema, 'bootstrap-static/');
  }

  fixtures(eventId?: number): Promise<ApiResult<ApiFixtures>> {
    const file = eventId === undefined ? 'fixtures.json' : `fixtures-event-${eventId}.json`;
    const path = eventId === undefined ? 'fixtures/' : `fixtures/?event=${eventId}`;
    // Fall back to the full fixture list, filtered, when no per-event recording exists.
    if (eventId !== undefined && !existsSync(resolve(this.dir, file))) {
      return this.read('fixtures.json', fixturesSchema, path).then((result) => ({
        ...result,
        data: result.data.filter((fixture) => fixture.event === eventId),
      }));
    }
    return this.read(file, fixturesSchema, path);
  }

  elementSummary(playerId: number): Promise<ApiResult<ApiElementSummary>> {
    return this.read(
      `element-summary-${playerId}.json`,
      elementSummarySchema,
      `element-summary/${playerId}/`,
    );
  }

  entry(teamId: number): Promise<ApiResult<ApiEntry>> {
    return this.read(`entry-${teamId}.json`, entrySchema, `entry/${teamId}/`);
  }

  entryPicks(teamId: number, eventId: number): Promise<ApiResult<ApiPicks>> {
    return this.read(
      `entry-${teamId}-event-${eventId}-picks.json`,
      picksSchema,
      `entry/${teamId}/event/${eventId}/picks/`,
    );
  }

  entryHistory(teamId: number): Promise<ApiResult<ApiEntryHistory>> {
    return this.read(
      `entry-${teamId}-history.json`,
      entryHistorySchema,
      `entry/${teamId}/history/`,
    );
  }

  leagueStandings(leagueId: number, page = 1): Promise<ApiResult<ApiLeagueStandings>> {
    return this.read(
      `league-${leagueId}-page-${page}.json`,
      leagueStandingsSchema,
      `leagues-classic/${leagueId}/standings/`,
    );
  }

  private async read<T>(file: string, schema: z.ZodType<T>, path: string): Promise<ApiResult<T>> {
    const full = resolve(this.dir, file);
    if (!existsSync(full)) {
      // Mirrors the live client: a missing recording behaves like a 404, so callers that
      // legitimately expect one (picks before the first deadline) handle both the same way.
      throw new ApiError(`No recorded response at ${full}`, path, 404);
    }

    let body: unknown;
    try {
      body = JSON.parse(readFileSync(full, 'utf8'));
    } catch (cause) {
      throw new ApiError(`Recorded response ${full} is not valid JSON`, path, undefined, { cause });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      throw new ApiError(`Recorded response ${full} did not match the expected shape:\n${issues}`, path);
    }

    return { data: parsed.data, fetchedAt: this.fetchedAt, fromCache: true, source: path };
  }
}

/**
 * An in-memory FplApi backed by plain objects. Handy in unit tests that want to construct one
 * odd payload without writing files.
 */
export class StubFplApi implements FplApi {
  constructor(
    private readonly payloads: {
      bootstrap?: unknown;
      fixtures?: unknown;
      elementSummary?: Record<number, unknown>;
      entry?: Record<number, unknown>;
      picks?: Record<string, unknown>;
      history?: Record<number, unknown>;
      leagues?: Record<string, unknown>;
    },
    private readonly fetchedAt: number = Math.floor(Date.now() / 1000),
  ) {}

  private wrap<T>(schema: z.ZodType<T>, body: unknown, path: string): Promise<ApiResult<T>> {
    if (body === undefined) throw new ApiError(`No stub configured for ${path}`, path, 404);
    return Promise.resolve({
      data: schema.parse(body),
      fetchedAt: this.fetchedAt,
      fromCache: false,
      source: path,
    });
  }

  bootstrap() {
    return this.wrap(bootstrapSchema, this.payloads.bootstrap, 'bootstrap-static/');
  }

  fixtures(eventId?: number) {
    return this.wrap(fixturesSchema, this.payloads.fixtures ?? [], 'fixtures/').then((result) =>
      eventId === undefined
        ? result
        : { ...result, data: result.data.filter((f) => f.event === eventId) },
    );
  }

  elementSummary(playerId: number) {
    return this.wrap(
      elementSummarySchema,
      this.payloads.elementSummary?.[playerId],
      `element-summary/${playerId}/`,
    );
  }

  entry(teamId: number) {
    return this.wrap(entrySchema, this.payloads.entry?.[teamId], `entry/${teamId}/`);
  }

  entryPicks(teamId: number, eventId: number) {
    return this.wrap(
      picksSchema,
      this.payloads.picks?.[`${teamId}:${eventId}`],
      `entry/${teamId}/event/${eventId}/picks/`,
    );
  }

  entryHistory(teamId: number) {
    return this.wrap(entryHistorySchema, this.payloads.history?.[teamId], `entry/${teamId}/history/`);
  }

  leagueStandings(leagueId: number, page = 1) {
    return this.wrap(
      leagueStandingsSchema,
      this.payloads.leagues?.[`${leagueId}:${page}`],
      `leagues-classic/${leagueId}/standings/`,
    );
  }
}
