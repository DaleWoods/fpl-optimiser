import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';
import { HttpFplApi } from '../api/httpClient.js';
import type { Config } from '../config/schema.js';
import { openDatabase } from '../db/index.js';
import { ingestAll, importPayload } from '../ingest/index.js';
import { recommend, type Recommendation } from './recommend.js';
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
  .button { display:inline-block; background:#37003c; color:#fff; text-decoration:none;
            padding:.6rem 1.1rem; border-radius:8px; font-weight:600; }
  .button:hover { background:#4a0050; }
  .rec { border:1px solid var(--line); border-radius:8px; padding:1rem; margin:.75rem 0; }
  .rec h3 { margin:0 0 .3rem; font-size:1rem; }
  .pill { display:inline-block; background:var(--line); border-radius:99px;
          padding:.1rem .6rem; font-size:.8rem; margin-right:.4rem; }
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

  <p><a class="button" href="/optimise">Pick my best team for ${escapeHtml(
    state.nextDeadline?.name ?? 'the next gameweek',
  )}</a>
  &nbsp;<a href="/upload">Import data&nbsp;&rarr;</a></p>

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

function playerRow(player: {
  position: string;
  name: string;
  clubShort: string;
  price: number;
  xPts: number;
  confidence: string;
  breakdown: Record<string, number>;
  reasons: string[];
}, marker = ''): string {
  // The justification: the components that make up the projection, then the narrative behind it.
  const parts = Object.entries(player.breakdown)
    .filter(([, value]) => Math.abs(value) >= 0.01)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(
      ([name, value]) =>
        `<span class="pill">${escapeHtml(name)} ${value >= 0 ? '+' : ''}${value.toFixed(2)}</span>`,
    )
    .join(' ');

  const reasons = player.reasons
    .map((reason) => `<li>${escapeHtml(reason)}</li>`)
    .join('');

  return `<tr>
    <td>${escapeHtml(player.position)}</td>
    <td>${escapeHtml(player.name)} ${marker}</td>
    <td>${escapeHtml(player.clubShort)}</td>
    <td>${formatMoney(player.price)}</td>
    <td>${player.xPts.toFixed(2)}</td>
    <td class="muted">${escapeHtml(player.confidence)}</td>
  </tr>
  <tr class="why"><td></td><td colspan="5">
    <details><summary class="muted">why?</summary>
      <div class="parts">${parts}</div>
      ${reasons ? `<ul>${reasons}</ul>` : ''}
    </details>
  </td></tr>`;
}

export function renderRecommendation(rec: Recommendation): string {
  const head = `<thead><tr><th>Pos</th><th>Player</th><th>Club</th><th>Price</th><th>xPts</th><th>Confidence</th></tr></thead>`;

  const starters = rec.eleven.starters
    .map((player) =>
      playerRow(
        player,
        player.playerId === rec.eleven.captain.playerId
          ? '<span class="badge">C</span>'
          : player.playerId === rec.eleven.viceCaptain.playerId
            ? '<span class="badge">V</span>'
            : '',
      ),
    )
    .join('');

  const bench = rec.eleven.bench
    .map((player, index) => playerRow(player, `<span class="muted">${index + 1}</span>`))
    .join('');

  const transfers =
    rec.transfers.length > 0
      ? rec.transfers
          .map(
            (transfer) => `<div class="rec">
              <h3>${escapeHtml(transfer.out.name)} &rarr; ${escapeHtml(transfer.in.name)}
                <span class="pill">${transfer.netGain >= 0 ? '+' : ''}${transfer.netGain.toFixed(2)} pts</span></h3>
              <p class="muted">${escapeHtml(transfer.reason)}</p>
            </div>`,
          )
          .join('')
      : '';

  const notes = rec.notes
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recommendation - ${escapeHtml(rec.eventName ?? `GW${rec.eventId}`)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e2e2e2;
          --warn-bg:#fff4e5; --warn-fg:#7a4a00; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2c2f36;
            --warn-bg:#3a2a10; --warn-fg:#ffd591; }
  }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:62rem; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  h2 { font-size:1.05rem; margin:2rem 0 .5rem; }
  .muted { color:var(--muted); }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--line); }
  th { font-weight:600; font-size:.85rem; color:var(--muted); }
  .badge { font-size:.7rem; border:1px solid var(--line); border-radius:4px; padding:0 .3rem; }
  .banner { padding:.75rem 1rem; border-radius:8px; margin:1rem 0;
            background:var(--warn-bg); color:var(--warn-fg); }
  .rec { border:1px solid var(--line); border-radius:8px; padding:1rem; margin:.75rem 0; }
  .rec h3 { margin:0 0 .3rem; font-size:1rem; }
  .pill { display:inline-block; background:var(--line); border-radius:99px;
          padding:.1rem .6rem; font-size:.8rem; }
  .scroll { overflow-x:auto; }
  a { color:inherit; }
  tr.why td { border-bottom:1px solid var(--line); padding-top:0; }
  tr.why summary { cursor:pointer; font-size:.85rem; }
  tr.why ul { margin:.4rem 0 .2rem; padding-left:1.1rem; font-size:.88rem; }
  .parts { margin:.4rem 0; display:flex; flex-wrap:wrap; gap:.3rem; }
  .pill { display:inline-block; background:var(--line); border-radius:99px;
          padding:.1rem .55rem; font-size:.78rem; }
</style></head>
<body><main>
  <p><a href="/">&larr; back</a></p>
  <h1>${escapeHtml(rec.eventName ?? `Gameweek ${rec.eventId}`)}</h1>
  <p class="muted">
    Deadline ${escapeHtml(rec.deadlineIso ?? 'unknown')} &middot;
    model ${escapeHtml(rec.modelVersion)} &middot;
    ${rec.playersConsidered} players considered
  </p>

  ${
    rec.mode === 'build-squad'
      ? `<div class="banner">This is a squad built from scratch within the budget, because no
          existing squad is loaded.</div>`
      : ''
  }
  ${rec.lowConfidence ? `<div class="banner">Most projections are low confidence - see the notes below.</div>` : ''}

  <p>
    <strong>Formation ${escapeHtml(rec.eleven.formation)}</strong> &middot;
    projected <strong>${rec.eleven.expectedPoints.toFixed(1)} points</strong> &middot;
    squad cost ${formatMoney(rec.totalCost)} &middot;
    ${formatMoney(rec.bankRemaining)} left
  </p>
  <p>Captain <strong>${escapeHtml(rec.eleven.captain.name)}</strong>,
     vice <strong>${escapeHtml(rec.eleven.viceCaptain.name)}</strong>.</p>

  <h2>Starting XI</h2>
  <div class="scroll"><table>${head}<tbody>${starters}</tbody></table></div>

  <h2>Bench <span class="muted">(in auto-sub order)</span></h2>
  <div class="scroll"><table>${head}<tbody>${bench}</tbody></table></div>

  ${rec.transfers.length > 0 ? `<h2>Suggested transfers</h2>${transfers}` : ''}

  <h2>Evidence behind these projections</h2>
  <ul>
    <li>${rec.playersConsidered} players considered, model ${escapeHtml(rec.modelVersion)}</li>
    ${
      rec.evidence.usingPreviousSeason > 0
        ? `<li>${rec.evidence.usingPreviousSeason} player(s) projected from last season's rates,
            because this season has no minutes yet</li>`
        : ''
    }
    ${
      rec.evidence.intelCompiledAt
        ? `<li>Curated pre-season notes compiled ${escapeHtml(rec.evidence.intelCompiledAt)},
            ${rec.evidence.intelApplied} adjustment(s) applied</li>`
        : ''
    }
    <li>${
      rec.evidence.eliteSampleSize > 0
        ? `Elite-manager ownership sampled for ${rec.evidence.eliteSampleSize} players`
        : 'Elite-manager ownership: not available yet - squads stay private until a gameweek starts'
    }</li>
    ${rec.evidence.contextNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}
  </ul>

  ${
    rec.evidence.intelSources.length > 0
      ? `<h2>Sources for the curated notes</h2><ul>${rec.evidence.intelSources
          .map((src) => `<li><a href="${escapeHtml(src)}" rel="noreferrer noopener">${escapeHtml(src)}</a></li>`)
          .join('')}</ul>`
      : ''
  }

  ${notes ? `<h2>Notes</h2><ul>${notes}</ul>` : ''}
</main></body></html>`;
}

const UPLOAD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Import data</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e2e2e2; --ok:#0a7c42; --err:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2c2f36; --ok:#6ee7a8; --err:#ffb4ab; }
  }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg);
         font:15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:48rem; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  h2 { font-size:1.05rem; margin:1.8rem 0 .4rem; }
  .muted { color:var(--muted); }
  code { background:var(--line); padding:.1rem .35rem; border-radius:4px; font-size:.9em; }
  ol { padding-left:1.2rem; }
  li { margin:.4rem 0; }
  .drop { border:2px dashed var(--line); border-radius:10px; padding:2rem 1rem; text-align:center;
          margin:1.5rem 0; }
  .drop.over { border-color:var(--ok); }
  .button { display:inline-block; background:#37003c; color:#fff; border:0; cursor:pointer;
            padding:.6rem 1.1rem; border-radius:8px; font-weight:600; font-size:1rem; }
  #log { margin-top:1rem; }
  .row { padding:.5rem .7rem; border:1px solid var(--line); border-radius:8px; margin:.4rem 0; }
  .ok { border-left:4px solid var(--ok); }
  .err { border-left:4px solid var(--err); }
  .warn { color:var(--muted); font-size:.9em; margin-top:.2rem; }
  a { color:inherit; }
</style></head>
<body><main>
<p><a href="/">&larr; back</a></p>
<h1>Import real FPL data</h1>
<p class="muted">Drop in files saved from the FPL API and the app will use them for every
projection. The file type is detected from the contents, so filenames do not matter.</p>

<h2>Where to get the files</h2>
<ol>
  <li>Open <code>https://fantasy.premierleague.com/api/bootstrap-static/</code> in your browser
      and save the page (Ctrl+S / Cmd+S). That is every player, price, position and stat.</li>
  <li>Do the same for <code>https://fantasy.premierleague.com/api/fixtures/</code> - fixtures
      and difficulty ratings.</li>
  <li>Optionally <code>https://fantasy.premierleague.com/api/element-summary/&lt;player id&gt;/</code>
      for one player's match-by-match and previous-season history.</li>
  <li>A CSV of last season's stats works too. See the README for the accepted columns.</li>
</ol>
<p class="muted">Import bootstrap-static first: fixtures and player histories reference clubs
and players, so the other order drops rows. Dropping everything at once is fine - they are
ordered automatically.</p>

<div class="drop" id="drop">
  <p>Drop files here, or</p>
  <input type="file" id="file" multiple accept=".json,.csv" hidden>
  <button class="button" id="choose">Choose files</button>
</div>

<div id="log"></div>

<script>
const drop = document.getElementById('drop');
const input = document.getElementById('file');
const log = document.getElementById('log');
document.getElementById('choose').onclick = () => input.click();
input.onchange = () => send([...input.files]);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); send([...e.dataTransfer.files]); };

function line(cls, html) {
  const el = document.createElement('div');
  el.className = 'row ' + cls;
  el.innerHTML = html;
  log.appendChild(el);
  return el;
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function send(files) {
  // bootstrap first, then fixtures, then the rest: later files reference earlier ones.
  const rank = f => /bootstrap/i.test(f.name) ? 0 : /fixture/i.test(f.name) ? 1 : 2;
  files.sort((a, b) => rank(a) - rank(b));

  for (const file of files) {
    const row = line('', 'Uploading ' + esc(file.name) + '...');
    try {
      const text = await file.text();
      const res = await fetch('/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text,
      });
      const body = await res.json();
      if (!res.ok) {
        row.className = 'row err';
        row.innerHTML = '<strong>' + esc(file.name) + '</strong><br>' + esc(body.error || res.statusText);
        continue;
      }
      row.className = 'row ok';
      row.innerHTML = '<strong>' + esc(file.name) + '</strong> &middot; ' + esc(body.kind) +
        '<br>' + esc(body.detail) +
        (body.warnings || []).map(w => '<div class="warn">! ' + esc(w) + '</div>').join('');
    } catch (err) {
      row.className = 'row err';
      row.innerHTML = '<strong>' + esc(file.name) + '</strong><br>' + esc(err.message);
    }
  }
  line('', '<a href="/optimise">Build my team from this data &rarr;</a>');
}
</script>
</main></body></html>`;

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

    if (url.pathname === '/upload' && request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(UPLOAD_PAGE);
      return;
    }

    if (url.pathname === '/upload' && request.method === 'POST') {
      const name = url.searchParams.get('name') ?? 'upload';
      try {
        // bootstrap-static is a few MB; allow headroom but not unlimited.
        const text = await readBody(request, 32 * 1024 * 1024);
        const summary = await importPayload(db, config.rules, text, { sourceLabel: name });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(summary));
      } catch (cause) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: (cause as Error).message }));
      }
      return;
    }

    if (url.pathname === '/optimise' || url.pathname === '/optimise.json') {
      const gwParam = url.searchParams.get('gw');
      try {
        const result = await recommend(db, config.rules, config.weights, {
          teamId: config.app.teamId,
          eventId: gwParam ? Number(gwParam) : undefined,
          fromScratch: url.searchParams.get('scratch') === '1',
        });

        if (url.pathname === '/optimise.json') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(result, null, 2));
          return;
        }

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(renderRecommendation(result));
      } catch (cause) {
        const message = (cause as Error).message;
        response.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>Cannot recommend yet</title>` +
            `<body style="font:15px system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">` +
            `<p><a href="/">&larr; back</a></p><h1>Cannot recommend yet</h1>` +
            `<pre style="white-space:pre-wrap">${escapeHtml(message)}</pre></body>`,
        );
      }
      return;
    }

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
