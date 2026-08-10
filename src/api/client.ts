import type {
  ApiElementSummary,
  ApiEntry,
  ApiEntryHistory,
  ApiFixtures,
  ApiLeagueStandings,
  ApiPicks,
  Bootstrap,
} from './schemas.js';

/** What came back, and how fresh it is. Staleness is surfaced, never hidden. */
export interface ApiResult<T> {
  data: T;
  /** Unix seconds when this payload was actually retrieved from the API. */
  fetchedAt: number;
  fromCache: boolean;
  /** The resource path, for logging and cache inspection. */
  source: string;
}

/**
 * The whole surface the app uses. Two implementations:
 *  - HttpFplApi   - the real API, throttled and cached
 *  - ReplayFplApi - recorded JSON from disk, for tests and offline work
 *
 * Everything above this interface is testable without a network.
 */
export interface FplApi {
  bootstrap(): Promise<ApiResult<Bootstrap>>;
  fixtures(eventId?: number): Promise<ApiResult<ApiFixtures>>;
  elementSummary(playerId: number): Promise<ApiResult<ApiElementSummary>>;
  entry(teamId: number): Promise<ApiResult<ApiEntry>>;
  entryPicks(teamId: number, eventId: number): Promise<ApiResult<ApiPicks>>;
  entryHistory(teamId: number): Promise<ApiResult<ApiEntryHistory>>;
  /** Classic league standings. League 314 is the overall league, i.e. everyone. */
  leagueStandings(leagueId: number, page?: number): Promise<ApiResult<ApiLeagueStandings>>;
}

export class ApiError extends Error {
  readonly status: number | undefined;
  readonly path: string;
  /** 404 on a picks endpoint before the first deadline is expected, not a fault. */
  readonly notFound: boolean;

  constructor(message: string, path: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApiError';
    this.path = path;
    this.status = status;
    this.notFound = status === 404;
  }
}
