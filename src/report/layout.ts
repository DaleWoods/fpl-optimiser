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

.banner { padding: .75rem 1rem; border-radius: 10px; margin: .9rem 0; font-size: .92rem; }
.banner.warn { background: var(--warn-bg); color: var(--warn-fg); }
.banner.info { background: var(--surface); border: 1px solid var(--line); }

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
