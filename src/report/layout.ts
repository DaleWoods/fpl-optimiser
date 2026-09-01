/**
 * The shared page shell: one place for the design system and the tab bar, so every screen
 * looks like part of the same app rather than a set of separate pages.
 *
 * The palette borrows Fantasy Premier League's own colours - the deep purple and the bright
 * green - because this is a tool for playing that game and the association is useful. It
 * deliberately does not use any official logo or wordmark: this is a personal tool, and it
 * should be obvious that it is not an official product.
 */

export const BRAND = {
  purple: '#37003c',
  purpleLight: '#4a0050',
  green: '#00ff87',
  cyan: '#04f5ff',
  pink: '#e90052',
} as const;

export interface Tab {
  href: string;
  label: string;
  /** Matched against the current path to decide which tab is active. */
  match: string;
}

export const TABS: Tab[] = [
  { href: '/', label: 'Dashboard', match: '/' },
  { href: '/optimise', label: 'My Team', match: '/optimise' },
  { href: '/chips', label: 'Chips', match: '/chips' },
  { href: '/accuracy', label: 'Accuracy', match: '/accuracy' },
  { href: '/import', label: 'Import Data', match: '/import' },
  { href: '/reset', label: 'Reset', match: '/reset' },
];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Light and dark are both defined explicitly. The deep purple header stays constant across
 * both, because it is the one piece of branding that should not shift.
 */
export const STYLES = `
:root {
  color-scheme: light dark;
  --brand: ${BRAND.purple};
  --brand-light: ${BRAND.purpleLight};
  --accent: ${BRAND.green};
  --cyan: ${BRAND.cyan};
  --pink: ${BRAND.pink};

  --bg: #f4f4f6;
  --surface: #ffffff;
  --fg: #14161a;
  --muted: #5f6470;
  --line: #e3e4e9;
  --hi: #f0fbf5;
  --warn-bg: #fff4e5;
  --warn-fg: #7a4a00;
  --flag-bg: #fdecea;
  --flag-fg: #8c1d18;
  --ok: #0a7c42;
  --danger: #b3261e;
  --shadow: 0 1px 2px rgba(16,18,27,.06), 0 4px 16px rgba(16,18,27,.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --surface: #171a20;
    --fg: #e9eaee;
    --muted: #9aa0ad;
    --line: #272b33;
    --hi: #10241c;
    --warn-bg: #3a2a10;
    --warn-fg: #ffd591;
    --flag-bg: #3a1f1d;
    --flag-fg: #ffb4ab;
    --ok: #6ee7a8;
    --danger: #ffb4ab;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.3);
  }
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

header.top {
  background: linear-gradient(135deg, ${BRAND.purple} 0%, ${BRAND.purpleLight} 100%);
  color: #fff;
  padding: 1.1rem 1rem .1rem;
}
header.top .inner { max-width: 68rem; margin: 0 auto; }
header.top h1 {
  margin: 0; font-size: 1.25rem; font-weight: 700; letter-spacing: -.01em;
  display: flex; align-items: center; gap: .55rem;
}
header.top h1 .dot {
  width: .6rem; height: .6rem; border-radius: 50%;
  background: ${BRAND.green}; box-shadow: 0 0 0 3px rgba(0,255,135,.25);
}
header.top .sub { margin: .2rem 0 0; font-size: .85rem; opacity: .75; }

nav.tabs {
  max-width: 68rem; margin: .9rem auto 0; display: flex; gap: .15rem;
  overflow-x: auto; scrollbar-width: none;
}
nav.tabs::-webkit-scrollbar { display: none; }
nav.tabs a {
  color: rgba(255,255,255,.72); text-decoration: none; white-space: nowrap;
  padding: .55rem .9rem; border-radius: 8px 8px 0 0; font-weight: 600; font-size: .92rem;
  border-bottom: 3px solid transparent;
}
nav.tabs a:hover { color: #fff; background: rgba(255,255,255,.08); }
nav.tabs a[aria-current="page"] {
  color: #fff; border-bottom-color: ${BRAND.green}; background: rgba(255,255,255,.10);
}

main { max-width: 68rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }

h2 { font-size: 1.02rem; margin: 1.9rem 0 .6rem; letter-spacing: -.005em; }
h2:first-of-type { margin-top: .6rem; }
h3 { font-size: .98rem; margin: 0 0 .35rem; }
p { margin: .45rem 0; }
.muted { color: var(--muted); }
a { color: inherit; }

.card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
  padding: 1rem 1.1rem; box-shadow: var(--shadow); margin: .8rem 0;
}
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .8rem; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
        padding: .8rem 1rem; box-shadow: var(--shadow); }
.stat .label { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em;
               color: var(--muted); font-weight: 600; }
.stat .value { font-size: 1.35rem; font-weight: 700; margin-top: .15rem; }

.btn {
  display: inline-block; background: var(--brand); color: #fff; text-decoration: none;
  padding: .65rem 1.2rem; border-radius: 10px; font-weight: 700; border: 0; cursor: pointer;
  font-size: .95rem;
}
.btn:hover { background: var(--brand-light); }
.btn.accent { background: ${BRAND.green}; color: ${BRAND.purple}; }
.btn.accent:hover { filter: brightness(.94); }
.btn.ghost { background: transparent; color: var(--fg); border: 1px solid var(--line); }
.btn.danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
.btn:disabled { opacity: .45; cursor: default; }

table { border-collapse: collapse; width: 100%; font-size: .93rem; }
th, td { text-align: left; padding: .5rem .65rem; border-bottom: 1px solid var(--line); }
th { font-size: .76rem; text-transform: uppercase; letter-spacing: .05em;
     color: var(--muted); font-weight: 700; }
tbody tr:last-child td { border-bottom: 0; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }

.badge { display: inline-block; font-size: .68rem; font-weight: 700; padding: .05rem .4rem;
         border-radius: 4px; background: ${BRAND.green}; color: ${BRAND.purple}; }
.badge.v { background: var(--cyan); }
.pill { display: inline-block; background: var(--line); border-radius: 99px;
        padding: .12rem .6rem; font-size: .78rem; }
.pill.good { background: var(--hi); color: var(--ok); font-weight: 600; }
.pill.bad { background: var(--flag-bg); color: var(--flag-fg); font-weight: 600; }

/* Accuracy page. Comparing a projection against what actually happened is the entire point
   of that page, so the comparison is a scorecard per gameweek rather than two columns buried
   in a nine-column table - and the explanation of what each number means is folded away
   behind a summary, so the page can be read at a glance and interrogated only on demand. */
.gw-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(15.5rem, 1fr)); gap: .8rem; }
.gw-card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
           padding: .9rem 1rem; box-shadow: var(--shadow); }
.gw-card .gw-head { display: flex; align-items: center; justify-content: space-between;
                    gap: .5rem; margin-bottom: .55rem; }
.gw-card .gw-name { font-weight: 800; font-size: 1.05rem; letter-spacing: -.01em; }
.vs { display: flex; align-items: flex-end; gap: .45rem; }
.vs .side { flex: 1; min-width: 0; }
.vs .side .k { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em;
               color: var(--muted); font-weight: 700; }
.vs .side .v { font-size: 1.85rem; font-weight: 800; line-height: 1.1; letter-spacing: -.02em; }
.vs .arrow { color: var(--muted); font-size: 1.15rem; padding-bottom: .4rem; }
.gw-foot { margin-top: .7rem; padding-top: .6rem; border-top: 1px solid var(--line);
           display: grid; grid-template-columns: 1fr 1fr; gap: .5rem .7rem; }
.gw-foot .k { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em;
              color: var(--muted); font-weight: 700; }
.gw-foot .v { font-weight: 700; font-size: .95rem; }
.delta { display: inline-block; border-radius: 99px; padding: .12rem .6rem; font-size: .74rem;
         font-weight: 700; white-space: nowrap; }
.delta.close { background: var(--hi); color: var(--ok); }
.delta.off { background: var(--warn-bg); color: var(--warn-fg); }
.delta.none { background: var(--line); color: var(--muted); }

details.explain { margin: .7rem 0 1.3rem; }
details.explain summary { font-weight: 600; font-size: .9rem; cursor: pointer;
  padding: .6rem .85rem; background: var(--surface); border: 1px solid var(--line);
  border-radius: 10px; color: var(--fg); list-style: none; }
details.explain summary::-webkit-details-marker { display: none; }
details.explain summary::before { content: "▸ "; color: var(--muted); }
details.explain[open] summary::before { content: "▾ "; }
details.explain[open] summary { border-radius: 10px 10px 0 0; }
details.explain .inner { border: 1px solid var(--line); border-top: 0;
  border-radius: 0 0 10px 10px; padding: .1rem 1rem .9rem; background: var(--surface);
  font-size: .91rem; }

.banner { padding: .75rem 1rem; border-radius: 10px; margin: .9rem 0; font-size: .92rem; }
.banner.warn { background: var(--warn-bg); color: var(--warn-fg); }
.banner.info { background: var(--surface); border: 1px solid var(--line); }

/* The pitch view: a formation layout mirroring the actual FPL team page, so the squad reads at
   a glance instead of only as a table. Shirts are plain (no per-club kit colours - there is no
   licensed asset for that here), coloured by role in the squad rather than by club. */
.pitch {
  background:
    radial-gradient(ellipse at 50% 8%, rgba(255,255,255,.10), transparent 55%),
    repeating-linear-gradient(180deg, #0c8a3e 0 11%, #0a7a37 11% 22%);
  border-radius: 14px; padding: 1.1rem .6rem .8rem; position: relative; overflow: hidden;
  box-shadow: var(--shadow); border: 1px solid rgba(0,0,0,.15);
}
.pitch::before {
  content: ""; position: absolute; left: 50%; top: 6%; width: 5.5rem; height: 5.5rem;
  border: 2px solid rgba(255,255,255,.35); border-radius: 50%; transform: translateX(-50%);
}
.pitch::after {
  content: ""; position: absolute; left: 8%; right: 8%; top: 0; height: 0;
  border-top: 2px solid rgba(255,255,255,.3);
}
.pitch-row {
  display: flex; justify-content: center; align-items: flex-start; gap: .5rem;
  flex-wrap: nowrap; margin: 1.1rem 0; position: relative; z-index: 1;
  overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: .1rem;
}
.shirt-card {
  display: flex; flex-direction: column; align-items: center; width: 5.2rem; text-align: center;
  position: relative;
}
.shirt {
  width: 2.6rem; height: 2.3rem; border-radius: 6px 6px 3px 3px; background: ${BRAND.purple};
  border: 2px solid rgba(255,255,255,.55); display: flex; align-items: center;
  justify-content: center; font-size: .62rem; font-weight: 800; color: #fff;
  box-shadow: 0 2px 5px rgba(0,0,0,.25);
}
.shirt-card.bench .shirt { background: #55596a; opacity: .92; }
.shirt-card .armband {
  position: absolute; top: -.3rem; right: .35rem; width: 1.05rem; height: 1.05rem;
  border-radius: 50%; background: ${BRAND.green}; color: ${BRAND.purple}; font-size: .62rem;
  font-weight: 800; display: flex; align-items: center; justify-content: center;
  border: 2px solid var(--surface);
}
.shirt-card .armband.v { background: var(--cyan); }
.shirt-card .name {
  margin-top: .3rem; font-size: .74rem; font-weight: 700; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.55);
  max-width: 100%; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; line-height: 1.15;
}
.shirt-card .meta {
  font-size: .64rem; color: rgba(255,255,255,.88); text-shadow: 0 1px 3px rgba(0,0,0,.55);
  display: flex; gap: .3rem; justify-content: center; flex-wrap: wrap;
}
.bench-strip {
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
  padding: .8rem .6rem; margin: .6rem 0 0; box-shadow: var(--shadow);
}
.bench-strip .bench-label {
  font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  font-weight: 700; margin: 0 0 .55rem .3rem;
}
.bench-strip .pitch-row { margin: 0; }
.bench-strip .shirt-card .name, .bench-strip .shirt-card .meta { color: var(--fg); text-shadow: none; }
.bench-strip .shirt-card .meta { color: var(--muted); }
@media (max-width: 34rem) {
  .pitch-row { gap: .3rem; }
  .shirt-card { width: 3.7rem; }
  .shirt { width: 2.15rem; height: 1.9rem; }
  .shirt-card .name { font-size: .62rem; }
  .shirt-card .meta { font-size: .55rem; gap: .18rem; }
}

tr.flagged td { background: var(--flag-bg); color: var(--flag-fg); }
tr.bench td { opacity: .78; }
tr.special td { background: var(--hi); }
tr.stale td { color: var(--warn-fg); }

details summary { cursor: pointer; font-size: .85rem; color: var(--muted); }
details[open] summary { margin-bottom: .3rem; }
.parts { display: flex; flex-wrap: wrap; gap: .3rem; margin: .35rem 0; }
ul.tight { margin: .3rem 0; padding-left: 1.15rem; }
ul.tight li { margin: .15rem 0; }
`;

export interface ShellOptions {
  title: string;
  activePath: string;
  /** Small line under the app name. */
  subtitle?: string;
  body: string;
  /** Extra <script> content, already trusted (never user input). */
  script?: string;
}

export function renderShell(options: ShellOptions): string {
  const tabs = TABS.map((tab) => {
    const active =
      tab.match === '/' ? options.activePath === '/' : options.activePath.startsWith(tab.match);
    return `<a href="${tab.href}"${active ? ' aria-current="page"' : ''}>${escapeHtml(tab.label)}</a>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(options.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="top">
  <div class="inner">
    <h1><span class="dot"></span>FPL Optimiser</h1>
    ${options.subtitle ? `<p class="sub">${escapeHtml(options.subtitle)}</p>` : ''}
  </div>
  <nav class="tabs">${tabs}</nav>
</header>
<main>
${options.body}
</main>
${options.script ? `<script>${options.script}</script>` : ''}
</body>
</html>`;
}
