import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';
import { HttpFplApi } from '../api/httpClient.js';
import type { Config } from '../config/schema.js';
import { openDatabase } from '../db/index.js';
import { ingestAll } from '../ingest/index.js';
import { formatDuration, formatMoney, getStateOfPlay, type StateOfPlay } from './state.js';

export interface ServerOptions {
  config: Config;
  port: number;
  /** Minutes between background ingestions. 0 disables the scheduler. */
  ingestIntervalMinutes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Exported so escaping can be tested directly against crafted state. */
export function renderPage(state: StateOfPlay): string {
  const staleBanner = state.anyStale
    ? `<div class="banner warn">Some data is stale. A recommendation built on it may be wrong.</div>`
    : '';

  const deadline = state.nextDeadline
    ? `${escapeHtml(state.nextDeadline.name ?? `GW${state.nextDeadline.eventId}`)} &middot; ${escapeHtml(
        state.nextDeadline.deadlineIso ?? 'unknown',
      )} <span class="muted">(in ${formatDuration(state.nextDeadline.secondsUntil)})</span>`
    : 'unknown';

  const freshnessRows = state.freshness
    .map(
      (entry) => `<tr class="${entry.stale ? 'stale' : ''}">
        <td>${escapeHtml(entry.source)}</td>
        <td>${entry.lastSuccessAt === null ? 'never' : `${formatDuration(entry.ageSeconds)} ago`}</td>
      </tr>`,
    )
    .join('');

  const squadRows = state.squad
    .map((player) => {
      const role = player.isCaptain ? 'C' : player.isViceCaptain ? 'V' : '';
      const flagged = player.status !== null && player.status !== 'a';
      return `<tr class="${flagged ? 'flagged' : ''}${player.slot > 11 ? ' bench' : ''}">
        <td>${player.slot}</td>
        <td>${escapeHtml(player.position)}</td>
        <td>${escapeHtml(player.name)} ${role ? `<span class="badge">${role}</span>` : ''}</td>
        <td>${escapeHtml(player.team)}</td>
        <td>${formatMoney(player.price)}</td>
        <td>${flagged ? escapeHtml(player.news || `status '${player.status}'`) : ''}</td>
      </tr>`;
    })
    .join('');

  const changeRows = state.recentChanges
    .slice(0, 25)
    .map(
      (change) => `<tr class="${change.inSquad ? 'flagged' : ''}">
        <td>${escapeHtml(change.name)}</td>
        <td>${escapeHtml(change.kind)}</td>
        <td>${escapeHtml(change.note)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FPL Optimiser</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e2e2e2;
          --warn-bg:#fff4e5; --warn-fg:#7a4a00; --flag:#fdecea; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2c2f36;
            --warn-bg:#3a2a10; --warn-fg:#ffd591; --flag:#3a1f1d; }
  }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 62rem; margin: 0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  h2 { font-size:1.05rem; margin:2rem 0 .5rem; }
  .muted { color:var(--muted); }
  .banner { padding:.75rem 1rem; border-radius:8px; margin:1rem 0; }
  .warn { background:var(--warn-bg); color:var(--warn-fg); }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--line); }
  th { font-weight:600; font-size:.85rem; color:var(--muted); }
  tr.flagged td { background:var(--flag); }
  tr.bench td:first-child { color:var(--muted); }
  tr.stale td { color:var(--warn-fg); }
  .badge { font-size:.7rem; border:1px solid var(--line); border-radius:4px; padding:0 .3rem; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:1rem; margin:1rem 0; }
  .card { border:1px solid var(--line); border-radius:8px; padding:.75rem 1rem; }
  .card .value { font-size:1.2rem; font-weight:600; }
  .scroll { overflow-x:auto; }
</style>
</head>
<body>
<main>
  <h1>FPL Optimiser</h1>
  <p class="muted">Team ${state.teamId ?? 'not configured'} &middot; generated ${escapeHtml(
    new Date(state.generatedAt * 1000).toISOString(),
  )}</p>

  ${staleBanner}

  <p><strong>Next deadline:</strong> ${deadline}</p>

  <div class="grid">
    <div class="card"><div class="muted">Bank</div><div class="value">${formatMoney(state.bank)}</div></div>
    <div class="card"><div class="muted">Squad value</div><div class="value">${formatMoney(state.teamValue)}</div></div>
    <div class="card"><div class="muted">Free transfers</div><div class="value">${
      state.freeTransfers ?? 'unknown'
    }</div><div class="muted">${escapeHtml(state.freeTransfersSource ?? '')}</div></div>
    <div class="card"><div class="muted">Players tracked</div><div class="value">${state.playerCount}</div></div>
    <div class="card"><div class="muted">Snapshots</div><div class="value">${state.snapshotCount}</div></div>
  </div>

  <h2>Data freshness</h2>
  <div class="scroll"><table><thead><tr><th>Source</th><th>Last successful pull</th></tr></thead>
  <tbody>${freshnessRows}</tbody></table></div>

  <h2>Squad</h2>
  ${
    state.squadLoaded
      ? `<div class="scroll"><table>
          <thead><tr><th>#</th><th>Pos</th><th>Player</th><th>Club</th><th>Price</th><th>Note</th></tr></thead>
          <tbody>${squadRows}</tbody></table></div>`
      : `<p class="muted">${escapeHtml(state.squadNote ?? 'No squad loaded.')}</p>`
  }

  <h2>Recent changes</h2>
  ${
    state.recentChanges.length > 0
      ? `<div class="scroll"><table>
          <thead><tr><th>Player</th><th>Kind</th><th>Change</th></tr></thead>
          <tbody>${changeRows}</tbody></table></div>`
      : '<p class="muted">Nothing recorded yet. Changes appear once there are two snapshots to compare.</p>'
  }
</main>
</body>
</html>`;
}

/**
 * A minimal report server. No framework and no client-side JavaScript: this is a single-user
 * status page, and every dependency added here is one more thing to keep patched.
 */
export interface RunningServer {
  /** The port actually bound. Differs from the requested port when 0 was passed. */
  port: number;
  close: () => Promise<void>;
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

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    // Health check: must stay cheap and must not depend on the FPL API being up.
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ingesting, lastIngestError }));
      return;
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      void runIngest();
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ started: true }));
      return;
    }

    const state = getStateOfPlay(db, {
      teamId: config.app.teamId,
      staleAfterSeconds: config.app.staleness.warnAfterSeconds,
    });

    if (url.pathname === '/state.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(state, null, 2));
      return;
    }

    if (url.pathname !== '/') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderPage(state));
  };

  const server = createServer(handler);

  let timer: NodeJS.Timeout | undefined;
  if (options.ingestIntervalMinutes > 0) {
    const intervalMs = options.ingestIntervalMinutes * 60 * 1000;
    timer = setInterval(() => void runIngest(), intervalMs);
    // Do not hold the process open on the timer alone.
    timer.unref();
    // Prime on boot, so a fresh deployment has data without waiting for the first interval.
    void runIngest();
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
