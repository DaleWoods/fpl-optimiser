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
| 15 | Tabbed UI with FPL-inspired styling, per-slot import screen | done |
| 16 | Per-gameweek stats CSV, and accuracy tracking against real results | done |

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
npm run fpl -- accuracy            # how close projections were to what happened
npm run fpl -- accuracy --gw 3     # ...for one gameweek, with the biggest misses
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

…or open the **Import Data** tab in the deployed app, which has a slot per kind of data:

| Slot | Cadence | Accepts |
|---|---|---|
| This season's player data | Every week | `bootstrap-static` |
| Fixtures | When games move | `fixtures` |
| Last season's stats | One time only | a season CSV, or `element-summary` files |
| Your squad | Every week | your `picks`, entry or history files |

Each slot checks what you give it, so a file dropped in the wrong place is **refused with an
explanation** rather than quietly imported as the wrong thing. Every slot shows when it was
last filled.

**Import `bootstrap-static` first.** Fixtures and player histories reference clubs and players,
so the other order silently drops rows. The CLI and the upload page both sort files
automatically, so dropping everything at once is fine.

File type is detected from the *contents*, not the filename — `download (3).json` imports
correctly.

### Stats spreadsheets

Two shapes import, and the app tells them apart by whether there is a **`gameweek` column**:

**Per-gameweek** (one row per player per gameweek) is preferred — it keeps the detail a season
total throws away, and a season who scored steadily looks nothing like one who had three hauls.
Recognised columns include `gameweek`, `web_name`, `team_name`, `minutes`, `total_points`,
`expected_goals`, `expected_assists`, `expected_goals_conceded`, `clean_sheet`,
`defensive_contribution`, `clearances_blocks_interceptions`, `recoveries`, `tackles` and
`expected_points`. Rows are rolled up into season totals automatically, so the model can use
them straight away.

**Players are matched by name and club, never by the `id` in the file.** FPL reassigns element
ids between seasons, so last season's id 1 belongs to a different player now. Trusting it would
silently attribute one player's season to another — an error that never announces itself. Where
two players share a name, club and then position are used to separate them; anything still
ambiguous is reported rather than guessed.

Prices are accepted in either unit: `6.2` and `62` both mean £6.2m.

**Season totals** (one row per player) also import. Headers are matched loosely (case, spaces
and punctuation ignored), and these aliases are accepted:

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
| This season's results | **Nothing to do — automatic** | The server fetches every player's own `element-summary` itself, once a gameweek finishes, on the same background refresh that already handles prices. This is what feeds the Accuracy tab and rolls into next season's opening-gameweek evidence. The same slot still takes a CSV too, only useful if you want a result recorded sooner than the next scheduled refresh, or you're running locally without the background scheduler on (see "Running locally instead" below). |
| `bootstrap-static` | **Every week, before the deadline** | Prices, form, injuries and news all move. Each upload also stores a snapshot, so price and form *trends* accumulate — the more often you upload, the better change detection gets. |
| `fixtures` | **Whenever games are rearranged** | European progress and cup ties move Premier League games, which is what creates the double and blank gameweeks that decide chip timing. |
| Your `picks` | **Each week once the gameweek has started** | Loads your actual 15, which turns on transfer advice and points-based chip valuation. |

## Measuring the model

`fpl accuracy` (or the **Accuracy** tab) grades past projections against what actually
happened. Every recommendation is stored with its model version when it is made, so once
results arrive the two can be joined.

Results arrive on their own: on the server's regular background refresh (every 3 hours by
default), if the most recently finished gameweek has no per-player history recorded for it yet,
the app fetches every player's own `element-summary` — the FPL API's exact per-gameweek
breakdown, straight from the source it also uses for last season's history. That one heavier
pull happens once per gameweek, not on every refresh, so it doesn't hammer the API for no
reason. Nothing needs importing for this any more.

If you'd rather not wait for the next scheduled refresh, or you're running locally without the
background scheduler on, the same **Import Data** slot as last season's history also still takes
a per-gameweek CSV (one row per player per gameweek — a community site's export, or your own
spreadsheet). The app compares the season named in the file (or, if the file doesn't say,
assumes it means now) against the season this app is configured for (`rules.season` in
`config/rules.json`), and only records actual scores when they match. A file for a season that
doesn't match is still stored as history, just not graded against.

Two numbers matter, and they answer different questions:

- **Mean absolute error** — how far a typical projection was out, in points.
- **Bias** — the direction. Positive means systematically too optimistic. This is the *fixable*
  kind of wrong: an unbiased model with high error is noisy, but a biased one is tuned
  incorrectly and the weights in `config/model.weights.json` can be adjusted for it.

It also breaks error down **by position** (so a defensive blind spot shows up separately from
an attacking one) and **by confidence**, names the players it got most wrong in both
directions, and compares three numbers per gameweek: what the recommended XI was projected to
score, what it actually scored, and what the **best XI available from that squad** would have
scored in hindsight. That last gap is what better projections were worth, in real points.

Alongside your own score, it also shows the whole game's **average** and **highest** score for
each gameweek — the same numbers the official app shows on its home screen. There is nothing to
import for these: they ride along in `bootstrap-static`, which you're already uploading weekly,
and appear automatically once a gameweek finishes and that week's upload lands.

To use it: run an optimise before the deadline, then just wait — results land on their own after
the gameweek finishes. Only players with **both** a projection and a result are scored —
counting a player who was never projected would flatter the model, and counting one with no
result would slander it.

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

## Moving to the next gameweek

There is deliberately no "current gameweek" flag stored anywhere: which gameweek is being
planned for is always derived from the FPL API's own deadlines (the next one whose deadline
hasn't passed yet), so it can never drift out of sync with reality the way a manually-tracked
flag could.

What *is* manual is telling the app "I'm ready to move on" - the **End gameweek & plan next**
button on the Dashboard (shown once a squad is loaded). It does three things in one step: pulls
fresh data live (results, prices, your actual picks) rather than waiting for the next scheduled
background refresh, generates a recommendation for the next deadline, and shows a **Changed
since Gameweek N** summary - captain and vice-captain changes, any squad member who swapped
bench and starting XI without being transferred, a bench-order change, and the suggested
transfers, all in one place. It's optional: the ordinary background refresh and a plain
**Regenerate** get you to the same recommendation on their own, just without forcing an
immediate refresh or naming what changed.

The comparison is read from the recommendation history the app already keeps for grading (see
"Measuring the model" above) - there is nothing extra to store for it, and a from-scratch squad
build never gets a comparison, since there is no existing squad for it to have evolved from.

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
| `/import` | Import screen, one slot per kind of data |
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

1. **This season's stats** (FPL API). Preferred as soon as a player has minutes on the board -
   and also preferred over last season the moment his own club has played a match and he still
   has *zero* minutes. That zero is not silence, it is evidence: a club that has played without
   him is a real signal he is currently out of the team, and it must not be overridden by last
   season's rate just because last season looked good. (This is what a summer signing stuck
   behind an established starter, or a permanent second-choice keeper, looks like in the data -
   and getting it wrong here was a real bug: a non-playing player kept getting projected off a
   start rate from a different season, at a different club, that no longer applied.)
2. **Last season's stats** (`element-summary` → `history_past`). Before a ball is kicked - i.e.
   before this player's club has played at all this season - this is the only real evidence
   there is, so it drives opening-gameweek projections. It is never rated *high* confidence — a
   summer of transfers and new managers makes last season's roles a weaker guide than the
   numbers suggest.
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

### Free transfers: gameweek 2 is always exactly 1, never 2

Per the [official rules](https://fantasy.premierleague.com/en/help/rules) ("After your first
deadline you will receive 1 free transfer each Gameweek"), free transfers do not exist as a
resource during gameweek 1 — it's unlimited, free-form squad building, with nothing to bank.
`deriveFreeTransfers()` (`src/domain/freeTransfers.ts`) skips gameweek 1's own history record
for exactly this reason: it neither consumes nor rolls over an allowance. Gameweek 3 is the
earliest a manager can ever hold 2.

### "Suggested transfers" is a ranked list of alternatives, not a plan

Each card is costed as if it were the *only* transfer made this gameweek — a standalone
alternative for one transfer slot, not a shopping list to act on all at once. Several may even
target the same replacement, which is exactly why they can't all be done together. Make at most
as many as your free transfer count; anything beyond that costs a hit.

A squad member projected below `weights.transfers.priorityFixXPtsThreshold` (`config/model.weights.json`)
is a **dead slot** — hurt, or dropped down the pecking order by a summer signing the model has
already worked out from the evidence, but who still needs a human to notice the squad has an
empty seat in it. That player's best available replacement is always shown, marked **Priority
fix**, regardless of how it ranks by raw points — burying it under flashier-but-optional
upgrades elsewhere would be actively misleading. If no single transfer can fix it within budget
(a player already at the position's price floor has nowhere cheaper to go), that's reported as
an explicit note instead of a silent gap.

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
