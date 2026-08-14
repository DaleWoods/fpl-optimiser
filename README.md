# FPL Optimiser

Single-user Fantasy Premier League optimiser: ingests the official FPL API, applies the
league rules as hard constraints, projects expected points per player, and recommends a
starting XI, captain, bench order and transfer — with a plain-English reason for each.

Built to the requirements in `docs/fpl-optimiser-spec.md`. Phase 1 (MVP) only.

## Status

| Step | Area | State |
|---|---|---|
| 1 | Project scaffold, config loading + validation | done |
| 2 | SQLite storage and migrations | done |
| 3 | FPL API client (throttled, cached, replayable) | done |
| 4 | Ingestion into storage + change detection | done |
| 4b | CLI, report page and Render blueprint | done |
| 5 | Availability classification | done |
| 6 | Rules engine (hard constraints) | done |
| 7 | Expected-points model | done |
| 8 | ILP optimiser: best XI, best squad, captain, bench | done |
| 9 | Single-transfer recommender | done |
| 10 | CLI + web report | done |
| 11 | Last-season stats, curated intel, elite ownership, justifications | done |
| 12 | File import: saved API JSON and season CSV, CLI + web upload | done |
| 13 | Chip strategy: when to play Wildcard, Free Hit, Bench Boost, Triple Captain | done |
| 14 | Reset scopes, no-cache headers on dynamic pages | done |

## Requirements

Node.js 22 or newer. No other runtime dependencies — SQLite and the LP solver are both
bundled as npm packages.

```bash
npm install
npm test
```

## Commands

```bash
npm run fpl -- ingest              # pull fresh data into local storage
npm run fpl -- ingest --summaries  # ...including per-player match history (slow)
npm run fpl -- status              # state of play: freshness, squad, flags, changes
npm run fpl -- optimise            # recommend the best team for the next gameweek
npm run fpl -- optimise --gw 1     # ...for a specific gameweek
npm run fpl -- optimise --scratch  # build a squad from scratch, ignoring the one loaded
npm run fpl -- ingest --summaries  # includes last season's totals per player
npm run fpl -- ingest --elite      # sample what top-ranked managers own (needs a played GW)
npm run fpl -- chips               # when to play each remaining chip
npm run fpl -- chips --deep        # ...including Free Hit and Wildcard (slower)
npm run fpl -- reset               # show what a reset would delete (deletes nothing)
npm run fpl -- reset --scope squad --yes   # actually clear the squad
npm run fpl -- serve               # serve the report at http://localhost:3000
npm run fpl -- help
```

`ingest --replay <dir>` reads recorded API payloads from a directory instead of calling the
FPL API — useful offline, and for reproducing a past recommendation exactly.

## Importing real data by hand

If the machine running the app cannot reach the FPL API, feed it the API's own files instead.
This is not a workaround with worse data — it is byte-identical to what `ingest` would fetch,
with no scraping and no transformation.

**Open each of these in a browser and save the page** (Ctrl+S / Cmd+S):

| URL | What it gives you |
|---|---|
| `fantasy.premierleague.com/api/bootstrap-static/` | Every player, price, position, club, status, news and season stat |
| `fantasy.premierleague.com/api/fixtures/` | Every fixture with difficulty ratings |
| `fantasy.premierleague.com/api/element-summary/<player id>/` | One player's match-by-match and previous-season history |
| `fantasy.premierleague.com/api/entry/<team id>/event/<gw>/picks/` | **Your 15 for that gameweek** (only public once the gameweek has started) |
| `fantasy.premierleague.com/api/entry/<team id>/history/` | Your chip usage and transfer history |

Then either:

```bash
npm run fpl -- import ~/Downloads/bootstrap-static.json ~/Downloads/fixtures.json
npm run fpl -- import ~/Downloads/fpl-files/     # a whole folder works too
```

…or open **`/upload`** in the deployed app and drop the files in.

**Import `bootstrap-static` first.** Fixtures and player histories reference clubs and players,
so the other order silently drops rows. The CLI and the upload page both sort files
automatically, so dropping everything at once is fine.

File type is detected from the *contents*, not the filename — `download (3).json` imports
correctly.

### Last season's stats as a CSV

A spreadsheet of a previous season also imports. Headers are matched loosely (case, spaces and
punctuation are ignored), and these aliases are accepted:

| Column | Aliases |
|---|---|
| `id` | `element`, `player_id`, `element_id` — **best**, matches exactly |
| `code` | `element_code` |
| `name` | `player_name`, `web_name`, `second_name`, `player` |
| `team` | `club`, `team_name`, `short_name` — disambiguates players who share a name |
| `season` | `season_name` (defaults to the first row's value) |
| `total_points` | `points`, `pts` |
| `minutes` | `mins` |
| `starts`, `goals_scored`, `assists`, `clean_sheets`, `goals_conceded`, `saves`, `bonus`, `bps` | `goals`, `cs`, `gc` |
| `expected_goals` | `xg` |
| `expected_assists` | `xa` |
| `expected_goals_conceded` | `xgc` |
| `defensive_contribution` | `defcon`, `cbit`, `cbirt` |
| `end_cost` | `price`, `now_cost`, `value` |

Only a way to identify the player is required; every stat column is optional. Rows that match
no player, or that match more than one, are **reported with their line number** rather than
dropped — a silently ignored row is how a season of stats goes missing unnoticed.

Re-uploading the same file updates rather than duplicates.

## What to upload, and how often

| Data | How often | Why |
|---|---|---|
| Last season's stats (`element-summary`, or a CSV) | **Once** | It never changes. Stored permanently. |
| `bootstrap-static` | **Every week, before the deadline** | Prices, form, injuries and news all move. Each upload also stores a snapshot, so price and form *trends* accumulate — the more often you upload, the better change detection gets. |
| `fixtures` | **Whenever games are rearranged** | European progress and cup ties move Premier League games, which is what creates the double and blank gameweeks that decide chip timing. |
| Your `picks` | **Each week once the gameweek has started** | Loads your actual 15, which turns on transfer advice and points-based chip valuation. |

## Chip strategy

`fpl chips` (or `/chips`) says when to play each remaining chip, valuing each one in expected
points rather than by rule of thumb:

| Chip | Valued as | Which is why it wants |
|---|---|---|
| **Bench Boost** | your four bench players' projected points | a double gameweek — everyone plays twice, so the bench is worth roughly double |
| **Triple Captain** | one further multiple of your captain's projection | a double gameweek, on a premium player |
| **Free Hit** | best XI from the whole pool minus best XI from your squad | a blank gameweek, when much of your squad has no fixture |
| **Wildcard** | the same gap, but kept permanently | a fixture swing, or a squad that has drifted |

The chip rules come from `config/rules.json`, not from assumptions: **two sets per season**, one
of each per half, the first set lost at the **GW19 deadline**, and one chip per gameweek. The
advisor warns as that deadline approaches, and tells you when two chips are competing for the
same week.

Free Hit and Wildcard need a full squad rebuild per gameweek to value, so they are only
evaluated with `--deep` (or `?deep=1`). Without a squad loaded, chip advice falls back to
fixture shape alone and says so rather than inventing a points figure.

## Starting again

`fpl reset` (or `/reset`) deletes stored data in scopes, because wiping everything is rarely
what you want:

| Scope | Removes | Keeps |
|---|---|---|
| `squad` | Your squad, bank and chip history | All player data, fixtures, last season |
| `projections` | Stored projections and past recommendations | Everything else |
| `season` | This season's players, prices, fixtures, snapshots and squad | **Last season's history**, so it never needs uploading again |
| `all` | Everything | Nothing — a clean database |

Nothing is deleted without confirmation: the CLI shows the plan and row counts unless you pass
`--yes`, and the web page requires a POST naming the scope, so a stray click or a browser
prefetch cannot wipe anything.

### If a recommendation looks like it never changes

The optimiser is **deterministic** — the same data and the same model weights always produce
the same squad. That is intentional, and it means an unchanged recommendation usually means
unchanged inputs. Check, in order:

1. **The evidence panel at the bottom of `/optimise`.** It states how many players were
   projected from last season's rates and how many curated notes applied. If it says no
   last-season history is loaded, the model is falling back to the API's own estimate and the
   extra logic has nothing to work with.
2. **Did the upload land?** The front page lists the last successful import per source.
3. **Did the deploy land?** Render redeploys on push; check the deploy finished.

All dynamic pages are served `Cache-Control: no-store`, so a stale browser cache is no longer a
possible cause.

## Deploying to Render

`render.yaml` defines a single web service that serves the report, runs a background
ingestion on a schedule, and stores its database on a mounted disk.

**The disk is not optional.** Render's filesystem is wiped on every deploy and restart. This
app derives price trends, form trends and "what changed since last check" by comparing
snapshots stored over time — without persistence that history resets constantly and change
detection can never report anything, because there is never a previous snapshot to compare
against.

That has a cost implication: **a persistent disk requires a paid instance type.** Free
instances cannot mount one, and they also spin down when idle, which would stop the scheduled
ingestion. The blueprint therefore specifies `plan: starter`. Change it if you want a
different tier — but do not move it to `free`, because the disk will not attach.

Endpoints once deployed:

| Path | Purpose |
|---|---|
| `/` | The report page, with the "pick my best team" button |
| `/optimise` | The recommendation: XI, captain, bench, transfers |
| `/chips` | Chip strategy: when to play each one, and why |
| `/reset` | Delete stored data by scope, with confirmation |
| `/optimise.json` | The same, machine-readable |
| `/state.json` | The same data, machine-readable |
| `/healthz` | Health check — deliberately independent of the FPL API |
| `POST /ingest` | Trigger an ingestion immediately |

The health check does **not** depend on the FPL API being reachable. If it did, an FPL outage
would fail the health check and put the service into a restart loop.

### Running locally instead

Deployment is optional. The app is designed to run on your own machine, which costs nothing
and keeps full snapshot history:

```bash
npm install && npm run fpl -- ingest && npm run fpl -- status
```

The only thing you lose is always-on scheduled ingestion — you run `ingest` yourself before a
deadline, which is when freshness matters most anyway.

## Configuration

All rules and model weights live in `config/`, never in code:

- **`config/rules.json`** — the FPL ruleset as hard constraints: squad make-up, budget,
  max per club, formation bounds, transfer rollover and hit costs, chip rules, scoring.
- **`config/model.weights.json`** — every tunable number in the expected-points model,
  stamped with a `modelVersion` that is recorded against each stored projection.
- **`config/app.json`** — your team ID, API politeness settings, cache TTLs, database path.

To change anything locally without touching version control, copy a file to
`config/local.<name>.json` and override the top-level keys you care about. Those files are
gitignored.

### Setting your team ID

Find the number in your FPL URL — `fantasy.premierleague.com/entry/1234567/event/1` means
your team ID is `1234567` — and set it in `config/app.json`:

```json
{ "teamId": 1234567 }
```

Commands that need your squad fail with a clear message until this is set. Nothing is
guessed.

## Where the evidence comes from

Every projection says which evidence produced it, and the recommendation page lists it under
"Evidence behind these projections". There are four sources, in order of preference:

1. **This season's stats** (FPL API). Preferred as soon as a player has minutes on the board.
2. **Last season's stats** (`element-summary` → `history_past`). Before a ball is kicked this
   is the only real evidence there is, so it drives opening-gameweek projections. It is never
   rated *high* confidence — a summer of transfers and new managers makes last season's roles
   a weaker guide than the numbers suggest.
3. **What top-ranked managers own** (`leagues-classic/314` → their squads). Overall ownership
   counts a casual pick the same as a top-1k manager's; sampling the top of the overall league
   is a much better signal. Only available once a gameweek has been played — squads are private
   before that.
4. **Curated pre-season notes** (`config/intel.json`). See below.

### Why curated notes exist

**The app cannot read the web.** It can call the FPL API and nothing else. Anything that comes
from journalism, press conferences or community consensus has to be brought in deliberately —
so it lives in `config/intel.json`, dated, sourced and reviewable, rather than being scraped or
invented.

Two hard limits on what that file may do:

- It can only make a player **less** available, never more. If the API says injured, no note
  can resurrect them.
- Its points adjustment is a nudge applied *after* the model and *before* the rules engine. It
  can never put an illegal or unavailable player into a squad.

It also expires: `staleAfterGameweek` stops the adjustments applying once the season has real
data of its own. Set `eliteConsensusWeight` to `0` to switch the whole thing off without
deleting anything.

## What the public API cannot tell us

Three things the optimiser needs are not available without an authenticated session, so none
of them are guessed. Each is recorded with an explicit source, and any advice resting on them
says what it assumed:

| Value | Why it is missing | What we do |
|---|---|---|
| Free transfers | Only on the authenticated `my-team` endpoint | Derived from transfer history under the rollover rules, with the workings kept and any drift from the hits the API actually charged flagged as a caveat |
| Purchase / selling price | Not public at all | Left null with `price_source = 'unknown'`; the transfer engine declines to reason about budget rather than invent one |
| Live bank balance | Public API gives the value as at the last deadline | Used as stated, labelled as such |

Before the season's first deadline there is no squad to load at all — the picks endpoint has
nothing to return. That is handled as an expected state, not an error: manager state is still
recorded and a note explains why the squad is empty.

### Positions are never hardcoded

`config/rules.json` declares the *rules* for a position (how many in a squad, how many can
start). The live API declares which positions *exist*. On every run the two are reconciled,
and a mismatch — a renamed position, a new one, one the config has no rules for — stops the
run rather than quietly skewing a projection. The 2026/27 season reclassified 11 players, so
player positions are always read from the API, never assumed.

## Design notes

**Money is in tenths of a million**, as integers, matching the API's `now_cost` units. £100.0m
is `1000`. No floating-point money anywhere.

**Config is strict.** An unrecognised key in a config file is treated as a typo and fails the
load. A rules file where a mistake silently does nothing is the one failure mode this app
cannot afford. Human notes go in `$comment` keys, which are stripped before validation.

**The rules file validates against itself.** Position counts must sum to the squad size, the
XI and bench must add up, formation minimums must fit and maximums must fill, the bench
composition must follow from the squad and formation. A contradiction is caught at load time,
not discovered in a recommendation.
