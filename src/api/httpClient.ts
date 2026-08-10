import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { resolveFromRoot } from '../config/load.js';
import type { AppConfig } from '../config/schema.js';
import { ApiError, type ApiResult, type FplApi } from './client.js';
import {
  bootstrapSchema,
  elementSummarySchema,
  entryHistorySchema,
  entrySchema,
  fixturesSchema,
  picksSchema,
  type ApiElementSummary,
  type ApiEntry,
  type ApiEntryHistory,
  type ApiFixtures,
  type ApiPicks,
  type Bootstrap,
} from './schemas.js';

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface HttpFplApiDeps {
  fetch?: FetchLike;
  /** Unix milliseconds. Injectable so cache expiry is testable without waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called when serving stale cache after a failed refresh. */
  onWarning?: (message: string) => void;
}

interface CacheEntry {
  path: string;
  fetchedAt: number;
  body: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * The real FPL API client.
 *
 * Politeness, as the spec requires:
 *  - a descriptive User-Agent identifying the tool
 *  - a minimum interval between requests, enforced across every call this process makes
 *  - an on-disk cache with per-endpoint TTLs, so repeated commands do not re-hit the API
 *
 * Resilience: when a refresh fails and cached data exists, the cached copy is served with a
 * warning and its true age, rather than the command failing outright. Callers can see the age
 * via ApiResult.fetchedAt and decide whether it is fit to advise on.
 */
export class HttpFplApi implements FplApi {
  private readonly config: AppConfig['api'];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWarning: (message: string) => void;
  private readonly cacheDir: string;
  /** Serialises requests so the minimum interval holds across concurrent callers. */
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(config: AppConfig['api'], deps: HttpFplApiDeps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? defaultSleep;
    this.onWarning = deps.onWarning ?? (() => {});
    this.cacheDir = resolveFromRoot(config.cacheDir);
  }

  bootstrap(): Promise<ApiResult<Bootstrap>> {
    return this.get('bootstrap-static/', bootstrapSchema, this.config.cacheTtlSeconds.bootstrap);
  }

  fixtures(eventId?: number): Promise<ApiResult<ApiFixtures>> {
    const path = eventId === undefined ? 'fixtures/' : `fixtures/?event=${eventId}`;
    return this.get(path, fixturesSchema, this.config.cacheTtlSeconds.fixtures);
  }

  elementSummary(playerId: number): Promise<ApiResult<ApiElementSummary>> {
    return this.get(
      `element-summary/${playerId}/`,
      elementSummarySchema,
      this.config.cacheTtlSeconds.elementSummary,
    );
  }

  entry(teamId: number): Promise<ApiResult<ApiEntry>> {
    return this.get(`entry/${teamId}/`, entrySchema, this.config.cacheTtlSeconds.entry);
  }

  entryPicks(teamId: number, eventId: number): Promise<ApiResult<ApiPicks>> {
    return this.get(
      `entry/${teamId}/event/${eventId}/picks/`,
      picksSchema,
      this.config.cacheTtlSeconds.entry,
    );
  }

  entryHistory(teamId: number): Promise<ApiResult<ApiEntryHistory>> {
    return this.get(
      `entry/${teamId}/history/`,
      entryHistorySchema,
      this.config.cacheTtlSeconds.entry,
    );
  }

  // -------------------------------------------------------------------------

  private cachePath(path: string): string {
    const key = createHash('sha256').update(path).digest('hex').slice(0, 32);
    return resolve(this.cacheDir, `${key}.json`);
  }

  private readCache(path: string): CacheEntry | null {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath(path), 'utf8')) as CacheEntry;
      return typeof parsed?.fetchedAt === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeCache(path: string, body: unknown, fetchedAt: number): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const entry: CacheEntry = { path, fetchedAt, body };
      writeFileSync(this.cachePath(path), JSON.stringify(entry), 'utf8');
    } catch (cause) {
      // A cache we cannot write is a performance problem, not a correctness one.
      this.onWarning(`Could not write cache for ${path}: ${(cause as Error).message}`);
    }
  }

  /** Hold each request until minRequestIntervalMs has passed since the previous one started. */
  private async throttle(): Promise<void> {
    const wait = this.gate.then(async () => {
      const since = this.now() - this.lastRequestAt;
      const remaining = this.config.minRequestIntervalMs - since;
      if (remaining > 0) await this.sleep(remaining);
      this.lastRequestAt = this.now();
    });
    this.gate = wait.catch(() => undefined);
    return wait;
  }

  private async fetchJson(path: string): Promise<unknown> {
    const url = new URL(path, this.config.baseUrl).toString();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      await this.throttle();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            'User-Agent': this.config.userAgent,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        if (response.ok) return await response.json();

        // 4xx other than 429 will not improve by asking again.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new ApiError(
            `FPL API returned ${response.status} for ${path}`,
            path,
            response.status,
          );
        }
        lastError = new ApiError(
          `FPL API returned ${response.status} for ${path}`,
          path,
          response.status,
        );
      } catch (cause) {
        if (cause instanceof ApiError && cause.status !== undefined && cause.status !== 429) {
          throw cause;
        }
        lastError = cause;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < this.config.maxRetries) {
        await this.sleep(this.config.retryBackoffMs * 2 ** attempt);
      }
    }

    if (lastError instanceof ApiError) throw lastError;
    throw new ApiError(
      `FPL API request for ${path} failed after ${this.config.maxRetries + 1} attempts: ${
        (lastError as Error)?.message ?? 'unknown error'
      }`,
      path,
      undefined,
      { cause: lastError },
    );
  }

  private async get<T>(path: string, schema: z.ZodType<T>, ttlSeconds: number): Promise<ApiResult<T>> {
    const cached = this.readCache(path);
    const nowSec = Math.floor(this.now() / 1000);

    if (cached && nowSec - cached.fetchedAt < ttlSeconds) {
      const parsed = schema.safeParse(cached.body);
      if (parsed.success) {
        return { data: parsed.data, fetchedAt: cached.fetchedAt, fromCache: true, source: path };
      }
      // A cache written by an older schema is not a reason to fail; re-fetch instead.
      this.onWarning(`Cached copy of ${path} no longer matches the expected shape; refetching.`);
    }

    let body: unknown;
    try {
      body = await this.fetchJson(path);
    } catch (cause) {
      if (cached) {
        const parsed = schema.safeParse(cached.body);
        if (parsed.success) {
          const ageMinutes = Math.round((nowSec - cached.fetchedAt) / 60);
          this.onWarning(
            `Could not refresh ${path} (${(cause as Error).message}). Using cached data from ` +
              `${ageMinutes} minute(s) ago - treat any advice built on it with caution.`,
          );
          return { data: parsed.data, fetchedAt: cached.fetchedAt, fromCache: true, source: path };
        }
      }
      throw cause;
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      throw new ApiError(
        `FPL API response for ${path} did not match the expected shape:\n${issues}`,
        path,
      );
    }

    this.writeCache(path, body, nowSec);
    return { data: parsed.data, fetchedAt: nowSec, fromCache: false, source: path };
  }
}
