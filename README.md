# FPL Optimiser

Single-user Fantasy Premier League optimiser: ingests the official FPL API, applies the
league rules as hard constraints, projects expected points per player, and recommends a
starting XI, captain, bench order and transfer — with a plain-English reason for each.

Built to the requirements in [`docs/fpl-optimiser-spec.md`](docs/fpl-optimiser-spec.md). All
three phases of that spec are now delivered except where noted under
[What's deliberately not built](#whats-deliberately-not-built).

## Contents

- [What this is](#what-this-is) · [What's built](#whats-built) · [What's deliberately not built](#whats-deliberately-not-built) · [What's next](#whats-next)
- [Requirements](#requirements) · [Commands](#commands) · [Configuration](#configuration) · [Deploying to Render](#deploying-to-render)
- [Architecture](#architecture) — module map, data flow, the invariants that must hold
- [Importing real data by hand](#importing-real-data-by-hand) · [What to upload, and how often](#what-to-upload-and-how-often)
- [Measuring the model](#measuring-the-model) · [Chip strategy](#chip-strategy) · [Moving to the next gameweek](#moving-to-the-next-gameweek)
- [Where the evidence comes from](#where-the-evidence-comes-from) — **the reasoning behind every modelling decision**
- [What the public API cannot tell us](#what-the-public-api-cannot-tell-us)

## What this is

A single-user tool that answers one question each week: **given the squad I actually own, what
should I field, who should I captain, and is a transfer worth it?**

Two things shape every decision in it:

1. **Nothing is a black box.** Every number in a projection is a named component in a breakdown,
   every constant lives in a config file rather than in code, and every recommendation carries a
   plain-English reason. If the app tells you to captain someone, you can find out why and
   disagree with it on the evidence.
2. **It is graded against reality.** Projections are stored before the deadline and compared with
   what actually happened afterwards, and the model corrects itself from that comparison. A model
   that is never scored is a model nobody should trust. (The correction needs three graded
   gameweeks under the current `modelVersion` before it does anything, and bumping that version
   deliberately resets it — so after any scoring change it is dormant for a few weeks. The
   Accuracy page says which state it is in.)

## What's built

| Area | Where |
|---|---|
| Config loading, strict validation, self-consistent rules file | `src/config` |
| SQLite storage, migrations | `src/db` |
| FPL API client — throttled, cached, replayable | `src/api` |
| Ingestion, snapshots, change detection | `src/ingest` |
| Availability classification from status and news | `src/domain/availability.ts` |
| Rules engine as hard constraints | `src/rules/validate.ts` |
| Expected-points model | `src/model/xpts.ts`, `build.ts` |
| ILP optimiser: best XI, best squad, captain, bench order | `src/optimise/squad.ts` |
| Single-transfer recommender, with hits costed | `src/report/recommend.ts` |
| Multi-transfer squad rebuild | `src/optimise/squad.ts` |
| Priority-fix plan: every dead slot fixed at once, hits netted off | `src/report/recommend.ts` |
| Multi-gameweek horizon for transfers and captaincy | `src/model/horizon.ts` |
| Chip strategy — Wildcard, Free Hit, Bench Boost, Triple Captain | `src/optimise/chips.ts` |
| Last-season stats, curated intel, elite ownership | `src/model/intel.ts`, `src/ingest/elite.ts` |
| File import: saved API JSON, season CSV, per-gameweek CSV, my-team | `src/ingest/import.ts` |
| Real selling prices and true free-transfer count | `src/ingest/import.ts` (`importMyTeam`) |
| Accuracy tracking: projected vs actual, auto-subs replayed | `src/model/accuracy.ts` |
| **Self-calibration from measured error** | `src/model/calibration.ts` |
| **Score distribution: ceiling, haul chance, blank risk** | `src/model/distribution.ts` |
| Web report, CLI, Render blueprint | `src/report` |
| Reset scopes | `src/ingest/reset.ts` |
| CI gate before deploy | `.github/workflows/ci.yml` |

523 tests. `npm run ci` runs the typecheck, the suite and a production build.

## What's deliberately not built

These are decisions, not gaps. Each was considered and rejected for a stated reason.

| Not built | Why |
|---|---|
| Executing transfers on the FPL site | Spec decision D1. This recommends; you act. An app that can spend your money and your transfers on a projection it might have got wrong is a different risk category. |
| Per-player calibration | Nowhere near enough sample per player. It would be fitting noise and calling it learning. |
| Automatic retuning of `model.weights.json` | Those numbers are the model's *structure*. They should change deliberately, with a version bump and a commit explaining the reasoning — not drift on their own. |
| Multi-gameweek transfer planning (banking a free transfer for a bigger move) | A genuinely hard planning problem where a confident wrong answer is costly. The horizon informs single transfers instead, and a timing *note* states the trade-off without pretending to resolve it. |
| News scraping beyond the API's flags | Spec D3, deferred. Ownership is used as a proxy for the crowd's team-news reading, which is honest about what it is. |
| Predicting exact price changes | FPL's algorithm is unpublished. Net transfers are surfaced as an informational flag, never as an xPts adjustment. |
| Mini-league rival tracking | Out of scope for now. Elite ownership covers the "what does the field own" question at a coarser grain. |

## What's next

No open GitHub issues; this is the working backlog, roughly in leverage order.

| Next | Why it matters | Notes |
|---|---|---|
| **Let calibration accumulate** | The correction needs three graded gameweeks under the *current* `modelVersion` before it does anything. Nothing to build — it just needs football to happen. | Watch the "What the model has learned" table on the Accuracy page. |
| Fetch actuals from `event/{gw}/live/` | Actual points currently need ~700 throttled `element-summary` calls after each gameweek. The live endpoint returns the same thing in one request. `cacheTtlSeconds.live` already exists in config and nothing uses it. | Medium effort. Would make the calibration loop's input faster and more reliable. |
| Surface `byConfidence` on the Accuracy page | `evaluateGameweek` computes error per confidence tier and nothing renders it. Would show whether the confidence labels mean anything. | Small. |
| Calibrate the minutes model separately from the points model | Would separate "we were wrong about whether he plays" from "we were wrong about what he does when he plays" — different fixes. | Do it after the points calibration has a few gameweeks behind it, or you cannot tell which one helped. |
| Correlate goals and assists in the distribution | Currently independent, which slightly understates the top tail. Affects every candidate the same way, so it does not change rankings much. | Low priority, documented as a known approximation. |

Executed plans, kept for the reasoning rather than as pending work, are in [`docs/plans/`](docs/plans/).

## Requirements

Node.js 22 or newer. No other runtime dependencies — SQLite and the LP solver are both
bundled as npm packages.

```bash
npm install
npm test
```

Pushes to `main` run the typecheck, the test suite and a production build in GitHub Actions
before Render deploys them. `npm run ci` runs the same three checks locally.

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

## Architecture

### Layers

Nine directories, each with one job, and dependencies that only ever point downward. Nothing in
`model` knows the API exists; nothing in `optimise` knows about HTTP; nothing in `report` reaches
into SQL that `ingest` owns.

```
config/   Load and validate rules + weights. Strict: an unknown key is a typo and fails the load.
   ↓
api/      Talk to FPL. Throttled, cached, replayable. Zod schemas at the boundary.
   ↓
ingest/   API and files → SQLite. Snapshots, change detection, one run record per ingestion.
   ↓
db/       SQLite, migrations. Applied by filename, recorded, never re-run.
   ↓
domain/   Types shared everywhere. Availability and free-transfer rules — pure logic, no I/O.
   ↓
model/    Stored rows → a projected player. xPts, its breakdown, its distribution, its accuracy.
   ↓
rules/    The hard constraints, as a gate. Nothing is returned without passing them.
   ↓
optimise/ ILP: best XI, best squad, captain, bench order, multi-transfer plans.
   ↓
report/   CLI, HTTP server, HTML. Assembles a recommendation and explains it.
```

### The path a recommendation takes

```
bootstrap-static ─┐
fixtures ─────────┤
element-summary ──┼→ ingest → SQLite ─→ buildProjections()
entry / my-team ──┤                        │
uploaded files ───┘                        │  per player:
                                           │   projectMinutes()  → will he be on the pitch?
                                           │   projectPlayer()   → xPts + named breakdown
                                           │   scoreDistribution()→ ceiling, haul chance
                                           │   applyCalibration()→ correct for measured error
                                           ↓
                            applyIntel() + elite ownership
                                           ↓
                          computeHorizon() — the next 5 gameweeks
                                           ↓
             selectBestEleven() / findTransfers() / buildPriorityFixPlan()
                                           ↓
                        validate.ts — hard gate, independently
                                           ↓
                       saveProjections() ──→ graded later by accuracy.ts
                                           ↓                      │
                                    the web page                  │
                                                                  ↓
                                             computeCalibration() feeds the next projection
```

That last arrow is the only cycle in the system, and it is deliberate: the model learns from
being graded. It is also the part most easily got wrong — see
[Learning from the model's own mistakes](#learning-from-the-models-own-mistakes).

### Key invariants

Break any of these and something downstream is quietly wrong rather than loudly broken.

| Invariant | Why | Enforced by |
|---|---|---|
| Money is integer tenths of a million | Matches the API's own units. No floating-point money anywhere. £100.0m is `1000`. | Convention; `formatMoney` is the only place it becomes a string |
| An unknown config key fails the load | A rules file where a typo silently does nothing is the one failure this app cannot afford | `z.strictObject` throughout `config/schema.ts` |
| The rules file must be self-consistent | Position counts sum to squad size, formations fit, bench composition follows. A contradiction is caught at load, not in a recommendation | `validateRulesConsistency()` |
| Nothing is returned without passing the rules engine | The solver is trusted to optimise, never to be correct | `assertLegalSquad` / `validateStartingEleven`, called on every path |
| Positions are never hardcoded | `rules.json` declares the *rules* for a position; the live API declares which positions *exist*, and the two are reconciled each run | `reconcilePositions()` |
| A rate is never trusted beyond its sample | Every per-90 is shrunk by the minutes behind it — and so is the anchor it shrinks toward | `shrinkRate`, `shrinkAnchorRate` |
| `modelVersion` is bumped on any scoring change | Stored projections carry the version that made them; accuracy and calibration group by it | Manual, stated in `model.weights.json` |
| Calibration is measured against *uncalibrated* projections | Measuring a working correction against its own corrected output reverts it | `projection.xpts_uncalibrated`, and a test |
| Selling price applies to the player leaving, current price to the one arriving | Inverting it makes advice worse than the proxy it replaced | Separate calls in both transfer paths, plus a test |
| `xPts` is what gets graded | Confidence, start risk and ceiling change *selection* only. Grading an adjusted number would make the model look wrong when it was not | `selectionValue()` is separate from `xPts` |

### Testing approach

523 tests. No network and no fixtures read from disk — every input is constructed in code, so
there is no stale-recording problem. Three things worth knowing:

- **`StubFplApi`** replays canned API responses through the same Zod schemas as the live client,
  so a recording that no longer parses is a real signal rather than a stale fixture.
- **The optimiser is checked against a brute-force oracle.** Choosing 11 from 15 is 1365
  combinations, so `test/unit/optimise.test.ts` computes the exhaustively best XI directly and
  checks the ILP against it — not against itself.
- **Tests are written to fail before the fix.** Where a commit claims to fix something, the test
  was verified to fail against the previous behaviour. A test that passes either way is not
  testing the change.

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

Short answer: nothing, ever, on the deployed server. Every one of these already arrives on its
own, on the same background refresh (every few hours by default, `--ingest-interval`), plus once
immediately on a cold start — see `shouldPrimeOnBoot` in `src/report/server.ts` for exactly when
that immediate fetch does and doesn't fire. The **Import Data** tab still has a manual "Fetch
latest data now" button and file-upload slots, but they exist for two narrower reasons: forcing
a refresh sooner than the schedule, and supplying detail (a community stats export's underlying
numbers) the FPL API itself doesn't carry.

| Data | Arrives automatically when | Manual upload still useful for |
|---|---|---|
| `bootstrap-static` (prices, form, injuries) | Every background refresh | Forcing a refresh sooner |
| `fixtures` | Every background refresh | Forcing a refresh sooner |
| Last season's stats (`element-summary`) | Once, the first refresh that finds none captured yet — no gameweek needs to finish first | A CSV with underlying stats (xG, defensive contribution) the API's own `element-summary` doesn't carry |
| This season's results | Once per gameweek, the first refresh after it finishes | Recording a result sooner than the next scheduled refresh |
| Your `picks` | Every background refresh, once `FPL_TEAM_ID` is set and a gameweek has started | Loading a squad sooner than the next scheduled refresh |

Running locally without the background scheduler (`--ingest-interval 0`, or the CLI's one-shot
`fpl ingest`) is the one case where the automation genuinely isn't there - see "Running locally
instead" below for what that means for you.

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

"What it actually scored" replays FPL's own auto-sub rules against what really happened - a
starter with 0 minutes is replaced by the first bench player, in auto-sub order, who did play
and keeps the formation legal (a goalkeeper only ever comes on for a goalkeeper), and the
captain's double moves to the vice-captain if the captain blanked - rather than just summing the
11 names originally picked, which would understate it every time a starter blanked. It still
doesn't account for transfer hits or chip multipliers, so it isn't quite your final live FPL
score - that's the separate "You scored" figure alongside it, recorded from your own entry
history. That figure used to be written only when an entry-history file was uploaded by hand,
so for anyone relying on the normal automatic refresh the column stayed permanently blank and
the model's advice could never actually be compared against the outcome; the automatic refresh
now records it too.

Alongside your own score, it also shows the whole game's **average** and **highest** score for
each gameweek — the same numbers the official app shows on its home screen. There is nothing to
import for these: they ride along in `bootstrap-static`, which you're already uploading weekly,
and appear automatically once a gameweek finishes and that week's upload lands.

The page leads with a scorecard per gameweek - what was projected, what it scored, and how far
out that was in words - because a projection with no outcome beside it cannot be judged, and an
outcome with no projection beside it teaches nothing. The mean error, the bias, the per-position
breakdown and the full table are all still there, but they explain that gap rather than opening
with it, so the explanations sit behind a summary you can expand rather than in front of the
numbers.

To use it: run an optimise before the deadline, then just wait — results land on their own after
the gameweek finishes. Only players with **both** a projection and a result are scored —
counting a player who was never projected would flatter the model, and counting one with no
result would slander it.

### Learning from the model's own mistakes

Measuring accuracy and doing nothing with it is a report card, not a mechanism. Once several
gameweeks have been graded, the model derives a **correction per position** from its own error
and applies it to future projections.

The correction is a *ratio* — what actually happened over what was projected, for that position
— not a flat number of points. Half a point means something very different for a goalkeeper
projected at 3 than for a captain projected at 9, and one additive correction would be wrong for
both. It is then shrunk hard toward no correction at all by how much evidence is behind it, the
same caution every other rate in this model gets, and clamped at both ends
(`calibration.minFactor`/`maxFactor`, 0.8 to 1.25). A model that needs a bigger correction than
that has a bug to be found, not a lean to be tuned out, and silently applying one would hide it.

Three things it deliberately does not do. It does not correct per player — there is nowhere near
enough sample per player and it would be fitting noise. It does not retune the weights in
`config/model.weights.json`, which are the model's structure and should change deliberately, with
a version bump and a stated reason. And it does not carry across a `modelVersion` change: a
factor describes the mistakes of the model that made them, so a scoring change resets the
learning rather than correcting something that no longer exists.

The subtle part is what the correction is measured *against*. It is always the projection
**before** any previous correction was applied (`projection.xpts_uncalibrated`), never the
corrected output. Measured against its own corrected output, a correction that was working would
come back as a ratio of 1.0 — so it would be thrown away, the error would return the following
week, and the model would flip between corrected and uncorrected forever with no way to tell
which state any given week's advice was in. The Accuracy page still *grades* the calibrated
figure, because that is the number the page actually showed and so the honest record of what was
advised.

It is visible everywhere it acts: a "What the model has learned" table on the Accuracy page, a
line in the evidence list on My Team, and a reason on every player whose projection it moved.
Set `calibration.enabled` to `false` to switch the whole thing off and project exactly as if it
had never existed.

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

Since a chip is only usable once per half-season, the advisor looks **16 gameweeks ahead by
default** (`--horizon N` / `?horizon=N` to change it) rather than judging a decent-looking week
against nothing further out — a chip played on the best of the next handful of gameweeks can
still be a mistake if a genuinely bigger window, already visible on the fixture list, is a
couple of months away. The `/chips` page also links to a full-season look (`?horizon=30`) as a
one-click check that nothing bigger is already on the list.

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

### Ownership sets the start prior, because the crowd knows who is nailed on

Expected minutes drive appearance points and scale every other component, so getting them wrong
is far more costly than a slightly-off scoring rate — a starter who does not play returns 0, not
a bit less than projected.

The start probability shrinks the observed start count toward a prior. That prior used to be a
flat number for everybody (`minutes.priorStartProbability`, 0.35), which after a single match
swamped the evidence completely: one start in one match landed on a 51% start chance whether the
player was a nailed-on £15.5m striker or a £4.0m fringe defender. Every projection compressed
into the same narrow band, proven starters were under-rated, fringe players over-rated, and tiny
per-90 differences were left deciding captaincy and squad places. In a real gameweek 2 squad
every outfield player in the XI showed the identical `appearance +1.14`, and the defence was
full of players who were not in their club's first XI.

`minutes.ownershipPriorPivot` (30%) and `minutes.ownershipPriorMax` (0.9) fix that by setting the
prior from ownership: at or above the pivot the prior is 0.9, sliding down to the flat baseline
at zero ownership. This is the same evidence `lowOwnershipThreshold` already trusted over our own
start count — the crowd's aggregated team news, press-conference reading and injury knowledge,
available from the very first gameweek — just used as a two-sided signal rather than only as a
floor-level cap. A player two-thirds of managers own is owned *because* he is nailed on.

Ownership only ever moves **minutes** here, never the per-90 scoring rates, so this is not
"popular players score more" — it is "popular players are more likely to be on the pitch", which
is plainly true and is exactly what the low-ownership cap already asserted in the other
direction. The differential nudge still pushes xPts the opposite way at selection time.

Related, and from the same gameweek: a player with **zero minutes** while his club had already
played twice was still handed the FPL API's own `ep_next` figure at full face value (the
`hasNoHistory` fallback), got picked, started, and returned 0. That figure is now scaled by the
minutes we actually expect. Before a ball is kicked nothing changes — with no matches played the
start probability is just the prior — but once the season is underway, zero minutes is evidence,
not an absence of it. Both fixed in `heuristic-0.14.0`.

### Recent form counts for more than the season average

Within "this season's stats", the last several gameweeks are weighted more heavily than the
season-long average, not just averaged in equally — a player heating up or cooling down shows up
before the whole-season number catches up. Both windows (`recentMatches`, default 6) and blend
strengths (`recentWeight`, per stat category in `config/model.weights.json`) are tunable. The
blend itself scales down automatically when the recent window is thin: a single substitute
cameo cannot swing a rate as hard as several genuine starts at the same rate would, the same
sample-size caution the model already applies to a shrunk previous-season rate, just applied to
this season's own recent window instead of a whole season. This uses `player_fixture_history`
(the per-gameweek breakdown that already arrives automatically, see "Moving to the next
gameweek" above) - nothing new to import for it.

The season-long side of that blend gets the same sample-size shrinkage a previous-season rate
already had - a season-to-date rate from one big early game is exactly as thin a sample as a
one-cameo rate from last season, and is now dampened the same way (`attacking.priorWeightMinutes`,
900 minutes - ten matches - before a rate is even half-trusted; a 90-minute sample keeps under a
tenth of its face value). Early in a season - gameweek 2 or 3, say - this matters a lot: without
it, a single outlier game (a defender's one huge defensive-contribution haul, a striker's
hat-trick against a poor side) was trusted at full face value from the very next gameweek on,
which could plausibly rank them above a genuine elite performer on much stronger underlying
evidence. This was a real bug, not a design choice - fixed in `heuristic-0.11.0`.

That first fix (shrinking the rate at all, rather than not) was not, on its own, strong enough
for the rarest and highest-value events. A defender's one gameweek 1 goal - worth 6 points, an
event that genuinely happens once every several dozen matches for most defenders - was still
being read as roughly a tenth of a repeatable ~1-goal-per-match threat even after that shrinkage,
enough on its own to outrank a genuine elite forward for the next gameweek's captaincy.
`priorWeightMinutes` moved from 270 (three matches) to 900 (ten) in `heuristic-0.12.0` for
exactly this reason: a goal is rare and high-variance enough that one match is nowhere near
sufficient evidence of a real, repeatable rate, whoever scored it.

Raising the shared prior helped but was still not enough, because one shared number cannot
correctly describe both a striker (whose true goal rate genuinely sits close to it) and a
defender (whose true rate is close to zero) at the same time. `heuristic-0.13.0` adds
`attacking.lowThreatPriorWeightMinutes` (2700 minutes - thirty matches), applied only to goal
involvement - goals, assists, and the xG/xA behind them - for a goalkeeper or defender. This is
a genuine, well-established positional fact (defenders and goalkeepers score and assist far less
often than midfielders and forwards, structurally, not just in this early sample), the same kind
of real-world knowledge DefCon's own per-position threshold already encodes - not a thumb on the
scale for any particular player. A goalkeeper's or defender's one early goal now needs a real,
sustained run behind it before it counts for much; a midfielder's or forward's does not, because
their underlying goal threat was never the surprising part.

Those three fixes were all correct in direction and all wrong in one shared detail, which
`heuristic-0.15.0` puts right: they shrank a thin rate **toward zero**. That is only the right
anchor for a player we know nothing about. For a player with a full previous season behind him
it is plainly wrong - and by gameweek 2 or 3, with the prior now set at 900 or 2700 minutes, it
was the dominant term. A striker who scored 20-odd goals last season and one in his opening
match was being projected as if his true rate were a tenth of a goal per 90, because 90 minutes
of evidence against a 900-minute prior anchored at zero can produce nothing else. That is the
mechanism behind the systematic under-projection visible on the Accuracy page (an XI projected
at 19.7 that scored 75): every attacking rate in the squad was being pulled to near-zero at
once, so the error was not noise, it was one-directional.

The shrinkage is now properly Bayesian: a thin this-season rate is blended toward **that
player's own previous-season per-90**, and only falls back to zero when there genuinely is no
previous season to anchor to. The strong priors stay exactly as they were, and still do the job
they were added for - one gameweek is still not evidence of a repeatable rate. What changes is
what "not much evidence yet" resolves to: last season's established rate rather than an
assertion that the player cannot score at all. This cuts symmetrically and is blind to
reputation: a defender with one goal last season and one this season is anchored just as low as
before, while a proven scorer is anchored high, purely on his own record.

That fix had a flaw of its own, closed in `heuristic-0.16.0`: it took the anchor at face value
however few minutes produced it. An anchor is a rate with a sample size like any other, and
`priorWeightMinutes` does not care where it came from — so two goals in 200 minutes last season
anchored a player at 0.9 goals per 90, and that was then asserted with the weight of ten full
matches. A player who had scored three goals in his career projected like an established striker.

The anchor is now shrunk by its own minutes too (`attacking.anchorPriorWeightMinutes`, 900),
toward what an ordinary player in that position does per 90
(`attacking.positionBaselineRates`) rather than toward zero. Worked through: a forward with two
goals in 200 minutes has a raw anchor of 0.90, which becomes `(0.90×200 + 0.35×900) / 1100` =
0.46 — ordinary-for-a-forward, which is a far better guess than either his cameo or nothing at
all. A forward with 15 in 3000 minutes has a raw 0.45 that barely moves, to 0.43, because three
thousand minutes is a real sample and the shrinkage is only supposed to bite on thin ones.

### A player who might not be on the pitch is worth less than his expected points say

`optimiser.startRiskWeight` discounts a selection candidate by how likely he is to actually
start, on top of the expected minutes already inside xPts. Expected value is the wrong basis for
an XI slot: a player with a 25% chance to start is not "a quarter of a player", he is
overwhelmingly likely to return nothing at all, and the slot he occupies cannot be recovered
afterwards. Multiplying by expected minutes - which is all xPts does - treats those two as
equivalent. This is why a squad player who is clearly out of his club's first XI could keep
holding a starting place week after week on a respectable-looking projection. Like the
confidence tiers, this only affects **which** players the solver picks; the xPts shown on the
page, and the number graded on the Accuracy page, remain the undiscounted projection.

### The captaincy is not an expected-value decision

Expected points is the right basis for ten of the eleven slots, where errors average out across a
season. It is the wrong basis for the one that scores **double**, and badly wrong for the Triple
Captain chip, which trebles one pick **once a season**. Two players projected at 9.0 are not the
same bet when one is a striker with a real chance of fifteen and the other is a midfielder who
reliably returns eight to ten.

So each player gets a **distribution**, not just a mean: goal and assist counts enumerated as
Poissons around exactly the rates the points model already used, clean sheets as a coin flip,
and everything else at its expected value. From that come a **ceiling** (the 90th percentile —
a realistic good week, not a theoretical maximum), a **haul chance** (P of ten or more) and a
**blank risk**. Enumerated rather than simulated, so regenerating the page gives the same numbers
back rather than numbers that wobble.

Two honest caveats. Goals and assists are treated as independent; in reality they are mildly
positively correlated, so the top tail is slightly understated — equally, for every candidate,
which is what matters when the figure is used to rank them against each other. And the mean of
the distribution is asserted in a test to reconcile with the model's own projection, because a
distribution describing a different player from the one being recommended would make every
number derived from it decorative.

The captaincy then gets a small, bounded, upward-only nudge toward the higher ceiling
(`captain.ceilingWeight`, capped by `maxCeilingBonus`), applied to how much upside a player
carries *beyond his own mean* rather than to the raw ceiling — the raw ceiling correlates so
strongly with expected points that using it directly would just be a second, noisier vote for
what the first term already said. It can separate two near-equal candidates; it can never
justify captaining a materially worse player, and there is a test for each of those.

Triple Captain gets the same treatment — expected gain with a bounded upside bonus
(`captain.tripleCaptainUsesCeiling`), not the ceiling outright. Ranking *gameweeks* on the raw
ceiling was a mistake, caught by a failing double-gameweek test: the ceiling is a 90th percentile
of a discrete distribution, so it saturates. On the test fixture a double gameweek raised the
captain's expected gain by 93% and his ceiling by only 54%, so ranking on ceiling discarded most
of the reason a double gameweek is the one you want. Upside is a nudge that separates near-equal
weeks, never the criterion that overturns a clearly better one — the same rule as the captaincy.

The chip advice reports **both** figures — "12.4 expected, 27.0 if it goes well, 31% chance of a
double-figure haul" — because a reader shown only the ceiling would reasonably read it as a
promise.

### Waiting for a better gameweek is not free

Chip timing used to rank purely on projected gain, which treats a projection thirteen weeks out
as exactly as trustworthy as one for this week. It is not. The fixture may be rearranged, both
clubs' strength ratings will have moved, and the player the chip hinges on may be injured,
rotated or no longer in your squad. A banked chip is worth its projection multiplied by the
chance the whole plan survives to that week.

`chips.futureDiscountPerGameweek` (0.97) is that chance, crudely but honestly: four weeks out
keeps 89%, thirteen weeks keeps 67%. It is deliberately gentle — it breaks a near-tie toward
acting on what you can actually see, and a genuinely better future week still wins comfortably,
which there is a test for. Set it to 1.0 to rank purely on gain, exactly as before.

This is a different thing from `horizon.decay`, which discounts future gameweeks for transfers
because points sooner are worth more than points later. This one is about *confidence*: a
distant projection is a weaker claim. And when a later gameweek projects higher but loses on the
discount, the advice says so outright rather than silently preferring the near one — that
trade-off is the entire decision, and hiding it in a ranking would hide the reasoning.

None of this touches `xPts`, which remains what the Accuracy page grades. Ceiling informs *who
gets the armband and when a chip is played*, nothing else.

### Rotation risk, from fixture congestion rather than a guessed list of European clubs

A club playing again within `minutes.rotationRiskRestDaysThreshold` days (default 4) of its
previous fixture gets a modest, config-driven discount (`minutes.rotationRiskDiscount`, default
0.9 - a 10% reduction) applied to every one of its players' start probability that gameweek, with
a note in "why this player?" explaining why.

The FPL API carries no European fixtures at all - only the Premier League ones this app already
imports - so there is no way to know directly whether a club has a Champions League, Europa or
Conference League tie in a given week. A short gap between two of its *Premier League* fixtures
is the closest thing to a reliable signal available without maintaining a separate curated list
of "clubs currently in Europe": that gap is almost always caused by exactly that (a top-flight
club's own league fixtures do not otherwise get shuffled this tight), and unlike a curated list
it needs no upkeep, degrades to "no discount" the moment data is missing rather than silently
going stale, and catches other causes of a squeezed calendar (a cup replay, a rearranged fixture)
for free. The trade-off is that it cannot single out which players within a squad are actually
rotation risks - it discounts the whole club's players equally, when in reality a manager
protects some more than others.

### Price trend flags are informational only, never a scoring factor

A player's "why this player?" reasons can note that they are heavily transferred in or out this
gameweek - a soft, purely informational flag, never an xPts adjustment and never a gate on
selection. FPL does not publish its real price-change algorithm, so this is not a prediction of
exactly when a price will move: it ranks every player by net transfers this gameweek (in minus
out, from `bootstrap-static`) and flags the top `priceTrend.topN` (default 20) at each end, but
only once net transfers clear `priceTrend.netTransfersFloor` (default 5,000) - otherwise a quiet
gameweek's top 20 is really just noise, not a genuine signal. Worth knowing before a transfer
decision, not a reason to chase or panic-sell a player on its own.

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
| Free transfers | Only on the authenticated `my-team` endpoint | Derived from transfer history under the rollover rules, with the workings kept and any drift from the hits the API actually charged flagged as a caveat — or taken exactly, from an imported `my-team` file |
| Purchase / selling price | Not public at all | Current price as a proxy, said so in the notes — or the real figure, from an imported `my-team` file |
| Live bank balance | Public API gives the value as at the last deadline | Used as stated, labelled as such |

The first two have a route, though a genuinely awkward one, and it is **optional** — the app
works without it and says which basis it used.

`https://fantasy.premierleague.com/api/my-team/<your team id>/` returns both. Opening that URL in
a logged-in browser returns `{"detail": "Authentication credentials were not provided."}` — the
endpoint wants a bearer token, not the session cookie the browser sends on a plain navigation.
The working route is developer tools: open the site, F12 → Network, load the Transfers page, find
the `my-team` request, and save its response. That file imports.

It is deliberately **not** wired into the automatic refresh, for the same reason: every scheduled
attempt would 401 and leave a permanent error on the dashboard for no gain.

Why it is worth the upload: FPL sells a player for what you paid plus **half** of any rise. For
anyone who has gone up, current price overstates what selling them frees up — so a transfer
costed on it can be one you cannot actually make. The engine sells at the selling price and buys
at the current price, and the two are deliberately separate calls in the code, because inverting
them would make the advice worse than the proxy it replaced.

Prices only change when you transfer, so an imported file keeps applying: the automatic refresh
writes a new squad snapshot every run with no prices on it, and the last snapshot that knew a
player's price is used for as long as you still own him. Otherwise an import would last exactly
until the next background refresh, which is to say almost no time at all.

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

### "Your team with every priority fix" answers a different question

The transfer cards answer *"what is the best use of one transfer?"* That is the right question
with one free transfer and one problem. It is the wrong one when the squad has three dead
slots, because three cards each showing a gain quietly hide the fact that doing all three costs
eight points in hits — each card is priced as though it were the only move of the week — and
because reading three independent cards still leaves you guessing at what team you would end up
with.

So the priority fixes are also applied **together**, as one team you could actually field, with
the cost stated in points at the top: *"3 transfers, 1 free — 2 hits at 4 points each, costing
you 8 points"*, then the XI before, the XI after, the hit, and the net both for this gameweek
alone and across the whole horizon.

They are applied **in sequence**, not independently: each swap sees the bank and the club counts
the previous one left behind. Chosen independently, two fixes could each spend the same money,
or each be the third player from one club, and the result would be a "team" that cannot legally
be entered. The worst dead slot is fixed first, so if the money runs out it runs out on the
least broken slot rather than the most; anything left unfixable is named on the page rather than
quietly dropped.

The hit is charged against the plan as a whole and never against an individual swap — with two
free transfers and three fixes, which of the three you call "the paid one" is meaningless. And
when the net comes out negative the page says so plainly, in red, and tells you to spread the
fixes across the next few gameweeks using your free transfer each week instead. Presenting the
gains without netting the hits off them would be the easy thing to show and the wrong one; the
whole reason this section exists is that the transfer cards, read as a bundle, do exactly that.

This is an alternative to the single transfers, never something to do on top of them.

### Timing a transfer: information, not a verdict

The top suggested transfer (skipping a **Priority fix** - there is never a case for delaying a
genuinely dead slot) can carry a note comparing its target's projection this gameweek against
their own average across the rest of the horizon. Well below it means their value is weighted
toward the weeks ahead, not this one; well above it means the opposite - most of their near-term
value is sitting in this single week. Either way, the note only ever states the comparison - it
never tells you to wait or to act now. Whether buying ahead of a fixture swing beats waiting for
it to start depends on price-rise risk and whatever else needs fixing this week, and this app
does not try to weigh that for you.

This is deliberately short of full multi-gameweek transfer planning (deciding whether to bank a
free transfer now for a bigger move in two or three weeks, say) - that is a much harder planning
problem, and a wrong nudge there is actively costly. What's here uses data the horizon already
computes for every transfer, at essentially no extra risk: relevant context, not a plan.

### When one swap isn't enough: whole-squad rebuilds

Every card in "Suggested transfers" is priced as a single 1-for-1 swap - but a genuinely better
player is sometimes only affordable by trimming two or three others to fund them, and no
1-for-1 search can ever find that: every candidate it considers has to pay for itself entirely
on its own. `selectBestTransferPlan()` (`src/optimise/squad.ts`) solves this as one whole-squad
problem instead, the same integer program that already builds a squad from scratch, given the
current squad's total value (squad cost plus bank) as its budget and a real cost for every
transfer beyond the free allowance. It doesn't try combinations by trial and error - the hit
cost is folded straight into the objective (a `max(0, transfers - free)` penalty via a slack
variable), so the solver finds the provably best number of changes on its own, including "none"
when nothing beats what you already have.

This only ever appears as **"Squad rebuild worth considering"** - a distinct alternative below
the single-transfer list, never merged into it - and only when it involves more than one change
*and* beats the best single option shown above. A plan matching the top single pick, or a worse
one, is not shown at all: there is nothing to add over what is already on the page.

### Positions are never hardcoded

`config/rules.json` declares the *rules* for a position (how many in a squad, how many can
start). The live API declares which positions *exist*. On every run the two are reconciled,
and a mismatch — a renamed position, a new one, one the config has no rules for — stops the
run rather than quietly skewing a projection. The 2026/27 season reclassified 11 players, so
player positions are always read from the API, never assumed.

## Design notes

The invariants that hold this together are tabulated under
[Architecture → Key invariants](#key-invariants). Two details that live nowhere else:

**Human notes go in `$comment` keys** in the config files, and are stripped before validation.
That is what lets a strict schema and a heavily annotated config file coexist — every constant
in `config/model.weights.json` carries the reasoning for its value next to it, and the loader
still rejects a genuine typo.

**Repository layout.** `src/` is the app and `test/unit` mirrors it. `config/` holds the three
files that shape every decision (`rules.json`, `model.weights.json`, `intel.json`);
`config/local.*.json` is gitignored for local overrides. `docs/` holds the original spec, the
executed plans, and two sample API payloads kept as import fixtures.
