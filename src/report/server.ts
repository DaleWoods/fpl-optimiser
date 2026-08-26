import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';
import { HttpFplApi } from '../api/httpClient.js';
import type { Config } from '../config/schema.js';
import { nowSeconds, openDatabase } from '../db/index.js';
import { ingestAll, importPayload } from '../ingest/index.js';
import { lastSuccessfulRun } from '../ingest/run.js';
import { planReset, resetData, RESET_PLANS, type ResetScope } from '../ingest/reset.js';
import { adviseChips } from '../optimise/chips.js';
import { GlpkSolver } from '../optimise/glpkSolver.js';
import { escapeHtml } from './layout.js';
import { checkReadiness, loadSquadForChips, recommend, resolveTargetEvent } from './recommend.js';
import { getStateOfPlay } from './state.js';
import { evaluateGameweek, evaluateSeason } from '../model/accuracy.js';
import { computeLeagueTable } from '../model/table.js';
import {
  renderAccuracy,
  renderChips,
  renderGenerate,
  renderDashboard,
  renderError,
  renderImport,
  renderRecommendation,
  renderReset,
  type ImportSlot,
} from './views.js';
import { IMPORT_SLOTS, buildImportSlots } from './importSlots.js';

export interface ServerOptions {
  config: Config;
  port: number;
  /** Minutes between background ingestions. 0 disables the scheduler. */
  ingestIntervalMinutes: number;
}

/**
 * Every page here is computed from live data, so none of it may be cached.
 *
 * Without this a browser happily serves a previous /optimise from its own cache when you
 * navigate back to it - so a genuinely updated recommendation looks like it never changed.
 */
const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
} as const;

const HTML = { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } as const;
const JSON_HEADERS = { 'Content-Type': 'application/json', ...NO_STORE } as const;

function readBody(request: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`File is larger than ${Math.round(limitBytes / 1024 / 1024)}MB`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * A minimal report server. No framework and no client-side JavaScript beyond the upload page,
 * which needs it to read files: this is a single-user status page, and every dependency added
 * here is one more thing to keep patched.
 */
export interface RunningServer {
  /** The port actually bound. Differs from the requested port when 0 was passed. */
  port: number;
  close: () => Promise<void>;
}

/**
 * Whether the boot-time ingest should run immediately, rather than waiting for the first
 * scheduled interval.
 *
 * Render restarts this process on every deploy, not just on a genuinely fresh disk - so this
 * has to tell "the data is actually stale" apart from "the process just happens to have
 * restarted", or "last imported" drifts to "just now" on every code push regardless of how
 * fresh the underlying FPL data really is.
 *
 * Exported separately from startServer so this decision is testable on its own: it only needs
 * what is already on disk, not a running server or a real FPL API call.
 */
export function shouldPrimeOnBoot(db: Database, ingestIntervalMinutes: number): boolean {
  const last = lastSuccessfulRun(db, 'bootstrap-static');
  if (last === null) return true;
  return nowSeconds() - last.startedAt >= ingestIntervalMinutes * 60;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const { config } = options;
  const db: Database = openDatabase({ path: config.app.database.path });

  let ingesting = false;
  let lastIngestError: string | null = null;

  const runIngest = async (): Promise<void> => {
    if (ingesting) return;
    ingesting = true;
    try {
      const api = new HttpFplApi(config.app.api, {
        onWarning: (message) => console.warn(`[ingest] warning: ${message}`),
      });
      await ingestAll(db, api, config.rules, {
        teamId: config.app.teamId,
        onProgress: (message) => console.log(`[ingest] ${message}`),
      });
      lastIngestError = null;
    } catch (cause) {
      lastIngestError = (cause as Error).message;
      console.error(`[ingest] failed: ${lastIngestError}`);
    } finally {
      ingesting = false;
    }
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname === '/reset' && request.method !== 'POST') {
      const plans = (Object.keys(RESET_PLANS) as ResetScope[]).map((scope) => {
        const plan = planReset(db, scope);
        return {
          scope,
          title: plan.title,
          rows: plan.totalRows,
          description: plan.description,
          keeps: plan.keeps,
        };
      });
      response.writeHead(200, HTML);
      response.end(renderReset(plans));
      return;
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      // POST only, and never from a plain link: a GET here could be triggered by a browser
      // prefetching, which must never delete anything.
      const scope = (url.searchParams.get('scope') ?? '') as ResetScope;
      if (!(scope in RESET_PLANS)) {
        response.writeHead(400, JSON_HEADERS);
        response.end(
          JSON.stringify({
            error: `Unknown scope '${scope}'. Choose one of: ${Object.keys(RESET_PLANS).join(', ')}.`,
          }),
        );
        return;
      }
      const result = resetData(db, scope);
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify(result));
      return;
    }

    // /upload was the old single drop-zone; keep it working as a redirect.
    if (url.pathname === '/upload' && request.method !== 'POST') {
      response.writeHead(302, { Location: '/import', ...NO_STORE });
      response.end();
      return;
    }

    if (url.pathname === '/import' && request.method !== 'POST') {
      response.writeHead(200, HTML);
      response.end(renderImport(buildImportSlots(db)));
      return;
    }

    if ((url.pathname === '/import' || url.pathname === '/upload') && request.method === 'POST') {
      const name = url.searchParams.get('name') ?? 'upload';
      const slotId = url.searchParams.get('slot');
      const slot = slotId ? IMPORT_SLOTS.find((entry) => entry.id === slotId) : undefined;

      if (slotId && !slot) {
        response.writeHead(400, JSON_HEADERS);
        response.end(
          JSON.stringify({
            error: `Unknown import slot '${slotId}'. Expected one of: ${IMPORT_SLOTS.map((e) => e.id).join(', ')}.`,
          }),
        );
        return;
      }

      try {
        // bootstrap-static is a few MB; allow headroom but not unlimited.
        const text = await readBody(request, 32 * 1024 * 1024);
        const summary = await importPayload(db, config.rules, text, {
          sourceLabel: name,
          teamId: config.app.teamId,
          ...(slot ? { expectedKinds: slot.accepts } : {}),
        });
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(summary));
      } catch (cause) {
        response.writeHead(400, JSON_HEADERS);
        response.end(JSON.stringify({ error: (cause as Error).message }));
      }
      return;
    }

    if (url.pathname === '/accuracy' || url.pathname === '/accuracy.json') {
      const season = evaluateSeason(db, config.rules, config.app.teamId);
      const lastGraded = season.gameweeks.at(-1);
      const latest = lastGraded
        ? evaluateGameweek(db, lastGraded.eventId, config.rules, config.app.teamId)
        : null;

      if (url.pathname === '/accuracy.json') {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify({ season, latest }, null, 2));
        return;
      }
      response.writeHead(200, HTML);
      response.end(renderAccuracy(season, latest));
      return;
    }

    if (url.pathname === '/chips' || url.pathname === '/chips.json') {
      try {
        const event = resolveTargetEvent(db);
        if (!event) throw new Error('No gameweeks stored yet. Import fixtures first.');

        const horizonParam = url.searchParams.get('horizon');
        const { squad, chipsUsed } = loadSquadForChips(
          db, config.app.teamId, config.rules, config.weights, event.id,
        );
        const advice = await adviseChips(db, config.rules, config.weights, event.id, {
          horizon: horizonParam ? Number(horizonParam) : undefined,
          squad,
          chipsUsed,
          evaluateRebuilds: url.searchParams.get('deep') === '1',
          solver: new GlpkSolver(),
        });

        if (url.pathname === '/chips.json') {
          response.writeHead(200, JSON_HEADERS);
          response.end(JSON.stringify(advice, null, 2));
          return;
        }
        response.writeHead(200, HTML);
        response.end(renderChips(advice, event.id));
      } catch (cause) {
        response.writeHead(409, HTML);
        response.end(
          renderError('Cannot advise on chips yet', (cause as Error).message, '/chips'),
        );
      }
      return;
    }

    if (url.pathname === '/optimise' || url.pathname === '/optimise.json') {
      const gwParam = url.searchParams.get('gw');
      const wantsGenerate = url.searchParams.get('generate') === '1';
      const wantsRefresh = url.searchParams.get('refresh') === '1';

      // "End gameweek" is a generate with a live refresh first, so a squad going into the new
      // gameweek and the results that just finished are both as current as possible before
      // regenerating - rather than waiting for the next scheduled background ingest. runIngest
      // never throws (it catches and records lastIngestError itself), so a refresh failure falls
      // through to generating from whatever data is already on disk rather than blocking it.
      if (wantsGenerate && wantsRefresh) await runIngest();

      const readiness = checkReadiness(db);
      const event = resolveTargetEvent(db);
      const squadLoaded =
        (db.prepare('SELECT COUNT(*) AS n FROM squad_pick').get() as { n: number }).n > 0;

      // A JSON caller asked explicitly, so gate on readiness alone; the page never generates
      // without the button - visiting or refreshing the tab must not silently build a team.
      if (url.pathname === '/optimise.json') {
        if (!readiness.ready) {
          response.writeHead(409, JSON_HEADERS);
          response.end(
            JSON.stringify({ error: 'Not ready to generate', missing: readiness.missing, checks: readiness.checks }, null, 2),
          );
          return;
        }
      } else if (!wantsGenerate || !readiness.ready) {
        response.writeHead(readiness.ready || !wantsGenerate ? 200 : 409, HTML);
        response.end(
          renderGenerate({
            readiness,
            eventName: event?.name ?? null,
            squadLoaded,
            blockedAttempt: wantsGenerate && !readiness.ready,
          }),
        );
        return;
      }

      try {
        const result = await recommend(db, config.rules, config.weights, {
          teamId: config.app.teamId,
          eventId: gwParam ? Number(gwParam) : undefined,
          fromScratch: url.searchParams.get('scratch') === '1',
          extraNotes:
            wantsRefresh && lastIngestError
              ? [`The pre-generate refresh failed (${lastIngestError}) - this used whatever data was already on disk.`]
              : undefined,
        });

        if (url.pathname === '/optimise.json') {
          response.writeHead(200, JSON_HEADERS);
          response.end(JSON.stringify(result, null, 2));
          return;
        }

        response.writeHead(200, HTML);
        response.end(renderRecommendation(result));
      } catch (cause) {
        response.writeHead(409, HTML);
        response.end(
          renderError('Cannot recommend yet', (cause as Error).message, '/optimise'),
        );
      }
      return;
    }

    // Health check: must stay cheap and must not depend on the FPL API being up.
    if (url.pathname === '/healthz') {
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify({ ok: true, ingesting, lastIngestError }));
      return;
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      void runIngest();
      response.writeHead(202, JSON_HEADERS);
      response.end(JSON.stringify({ started: true }));
      return;
    }

    const state = getStateOfPlay(db, {
      teamId: config.app.teamId,
      staleAfterSeconds: config.app.staleness.warnAfterSeconds,
    });

    if (url.pathname === '/state.json') {
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify(state, null, 2));
      return;
    }

    if (url.pathname !== '/') {
      response.writeHead(404, { 'Content-Type': 'text/plain', ...NO_STORE });
      response.end('Not found');
      return;
    }

    response.writeHead(200, HTML);
    response.end(renderDashboard({ ...state, leagueTable: computeLeagueTable(db) }));
  };

  const server = createServer((request, response) => {
    void handler(request, response).catch((cause: unknown) => {
      console.error(`request failed: ${(cause as Error).message}`);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end('Internal error');
      }
    });
  });

  let timer: NodeJS.Timeout | undefined;
  if (options.ingestIntervalMinutes > 0) {
    const intervalMs = options.ingestIntervalMinutes * 60 * 1000;
    timer = setInterval(() => void runIngest(), intervalMs);
    // Do not hold the process open on the timer alone.
    timer.unref();

    // Prime on boot, so a fresh deployment has data without waiting for the first interval -
    // but only when the data actually needs it. Render restarts this process on every deploy,
    // not just on a genuinely fresh disk, so priming unconditionally made "last imported" drift
    // to "just now" on every code push, which has nothing to do with how fresh the underlying
    // FPL data actually is and is actively misleading on a day with several deploys.
    if (shouldPrimeOnBoot(db, options.ingestIntervalMinutes)) void runIngest();
  }

  return new Promise((resolve) => {
    server.listen(options.port, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      console.log(`fpl-optimiser listening on port ${port}`);
      if (options.ingestIntervalMinutes > 0) {
        console.log(`background ingest every ${options.ingestIntervalMinutes} minute(s)`);
      }
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            if (timer) clearInterval(timer);
            server.close(() => {
              db.close();
              done();
            });
          }),
      });
    });
  });
}
