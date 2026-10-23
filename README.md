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
| **Wildcard** | how many of your 15 are beaten in *every* week of the run, plus the hits a one-at-a-time rebuild would cost | a squad that has drifted far enough that transfers cannot catch up |

The chip rules come from `config/rules.json`, not from assumptions: **two sets per season**, one
of each per half, the first set lost at the **GW19 deadline**, and one chip per gameweek. The
advisor warns as that deadline approaches, and tells you when two chips are competing for the
same week.

Free Hit needs a full squad rebuild per gameweek to value, so it is only evaluated with
`--deep` (or `?deep=1`) — the blank week it wants may be months out. Without a squad loaded,
chip advice falls back to fixture shape alone and says so rather than inventing a points figure.

#### The Wildcard is not a one-week chip, and was being valued as one

Free Hit buys a single gameweek's XI and hands the squad back. A Wildcard **keeps** it. Valuing
both on the same number — the pool gap in one gameweek — asks a question only one of them cares
about, and it sent the Wildcard to the blank gameweek every time, because that is where the pool
gap is always widest. That is a Free Hit's argument.

Three things changed.

**It is valued on how many of your fifteen the best affordable squad BEATS**, not on how many it
swaps. The optimal squad differs from almost any real one in eight or nine places, so a count of
differences would advise a Wildcard every week of the season. Players are paired by position and
by rank within it, and a pair counts only when the gap clears `chips.wildcardBeatenMargin` (0.5).
Below `chips.wildcardMinTransfers` (4) the chip is worth nothing: ordinary transfers get there
for less than a chip costs to spend, and the page says so in those words.

**The count has to hold across every week of the run, not the best week.** Gating on the best
week was tried and it recommended a Wildcard for a squad that was already the optimal fifteen —
no squad is optimal for a blank gameweek, so the worst week of any horizon always shows a pile of
beaten players. A squad behind in every single week is behind; a squad behind in one awkward week
has an awkward week.

**Half the value is arithmetic rather than forecast.** Everything else on the chips page is a
projection. Reaching the same squad through ordinary transfers costs four points for every move
beyond the free transfer, and that is certain whatever the projections turn out to be worth — so
it is added to the gain and stated in the reason alongside the other cost of going slowly, which
is the weeks you spend behind while you get there.

Two consequences follow. The Wildcard recommends the **earliest** week rather than the
best-scoring one: you keep the squad, so waiting does not buy a better rebuild, it forfeits the
gap for every week you wait. And it is exempt from the "no standout week" downgrade every other
chip gets — for a one-week bet, weeks that cannot be told apart mean nothing was found, but for a
Wildcard every week agreeing is the *strongest* form of the finding, not the weakest.

It also had to be reachable. The web chips page only ever ran rebuilds with `?deep=1`, so both
cards showed *"use `fpl chips --deep`"* — a terminal instruction on a web page — and the Wildcard
advice was never visible at all. The page now rebuilds the **first five gameweeks** by default,
which is bounded work and is the window that answers a Wildcard anyway.

#### "Play your Wildcard" now comes with the fifteen

A chip advisor that says *rebuild* and leaves you to work out the rebuild has answered half the
question. The chips page could recommend a Wildcard and the transfer cards could tell you which
single move was best, and between them neither ever showed the squad a Wildcard produces — the
two are not the same thing and never were. Each transfer card is costed **as if it were the only
move of the week**; a Wildcard is all fifteen at once, free.

The team page now carries **"If you played your Wildcard"**: the eleven and bench it would give
you, who goes, who comes in, what it gains this week and over the run, and what the same moves
would cost in hits done one at a time. The Wildcard card on the chips page links to it.

It is the same solve the multi-transfer plan already ran, with the two constraints a Wildcard
lifts — every transfer free, no cap on how many — so it reuses tested machinery rather than
adding a second opinion beside it.

**Budget was the part most likely to be silently wrong.** The only thing resembling this before
was `?scratch=1`, which is linked from nowhere and builds within `rules.squad.budget` — somebody
else's 100.0m. A Wildcard spends what *your* fifteen would sell for plus the bank, which is
usually neither 100.0m nor the same two weeks running. Reverting that one line in a test run
produced a 99.9m squad on a 96.1m budget: a team you cannot buy, recommended in full detail. The
same selling-price caveat as everywhere else applies — the public API does not publish them, so
current price stands in until a my-team file is uploaded, and that overstates what selling a
risen player frees up.

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

### The one that actually worked: copy the bytes, not the database

Three strategies failed in a row, and the log that explained why was the one showing **230 GB of
scratch free**:

```
[db] Only 0 MB free and the database is 931 MB. Compacting it.
[db] Scratch at /tmp has 230553 MB free.
[db] Whole-file copy failed (disk I/O error), salvaging the rows that matter instead.
[db] Could not compact: disk I/O error.
```

Space was never the constraint. Both routes died instantly on *reading* the source, which rules
out everything except the file itself.

A database left behind by repeated crashes has a **hot journal** beside it, and SQLite must roll
that back before it will read the file at all. Rollback is a **write**. On a volume with nothing
left there is nowhere to put it - so opening the original failed whatever flags were passed,
`readonly: true` included. Every strategy that began by opening it was dead before it started,
and I wrote three of them.

The fix is to stop asking a database engine to do a filesystem's job. `copyFileSync` moves the
bytes - and the `-wal`, `-shm` and `-journal` sidecars with them - to scratch. Nothing is
interpreted, nothing is recovered, nothing is written to the starved volume. Once the copy is
somewhere with room, SQLite rolls the journal back *there*, and pruning, compacting and verifying
all proceed normally against a database it can actually open. Only then is the original deleted
and the small result moved back.

The ordering is the entire fix, so a test asserts it directly against the source text: the raw
copy must come before any `new BetterSqlite3`, and neither route may reach for the original path.
It fails if that order is reversed.

### Why it broke during the weeks nobody was using it

The most reasonable question asked of this app: *"I had not touched it for ages, and now it is
broken. What changed?"*

**Nothing changed.** It writes history every few hours whether anyone is looking or not, so the
volume fills during exactly the weeks nobody visits. Being left alone did not protect it; being
left alone is what did it. Reconstructed from the Dashboard's own figures: 342 snapshots at the
measured 0.94 MB each is 321 MB of the 931 MB, accumulated at ~5.7 a day over two months. The
remainder is most likely `projection`, which had no primary key and appended ~650 rows on every
page generation - the new **Database size** panel names it exactly rather than leaving it to
inference.

The real fault is not the growth. It is that **there was no warning**. The app went from working
to `disk I/O error` with nothing in between: no banner, no number on a page, nothing until the
first symptom was total failure, mid-season, with a gameweek ungraded. A tool that runs
unattended has to be able to say "I am most of the way full" long before it says "I am full".

The Dashboard now says so, with a runway measured from the app's own history rather than
assumed - the oldest and newest kept snapshot bracket a known span, and the database has grown
over it:

> **The database is running out of room.** 800 MB used, 200 MB free — about **12 days** left at
> the current rate. Free up space on the Import Data tab before it runs out: once it does, the
> app cannot start at all.

That last clause is deliberate. "Low disk space" does not convey "the application will not boot",
and the gap between those two readings is what cost a fortnight of a season.

### Salvage: rebuilding a small database instead of copying a big one

`VACUUM INTO` is exact and well tested, and it still could not run here, because it copies the
file **whole** - so it needs more scratch than the database itself. Scratch on a hosted container
is ephemeral and modest, and a 931 MB copy simply would not fit:

```
[db] Only 0 MB free and the database is 931 MB. Compacting it.
[db] Copying the database out, read-only, to somewhere with room.
[db] Could not compact: disk I/O error.
```

So there is now a second route that needs about **35 MB** instead, because it never copies the
bulk. It creates a fresh database from the migrations, attaches the old one, and selects across -
keeping everything irreplaceable (stored recommendations and projections are the record of what
this app advised and cannot be fetched again from anywhere) while leaving behind the
`player_snapshot.raw_json` payload nothing reads, superseded snapshots, and replaced projection
runs. A side benefit: the new file takes its schema from the migrations, so a database that
missed one while it was broken comes back current.

The whole-file copy is still tried first when there is room for it. Salvage is the fallback.

**Two lessons from building it, both about tests rather than code.**

The salvage tests passed first time, and were worthless: scratch in a test is roomy, so every one
of them took the `VACUUM INTO` path and the salvage route never executed. A `preferSalvage` flag
now forces it, and with the route actually running the tests **failed immediately**.

What they caught was a genuine bug. `pragma_table_xinfo('src.player')` puts the schema in the
table-name argument, where it matches nothing - and an unknown table is not an error to a pragma,
it is an empty result. So the column intersection came out empty, every table was skipped, and
salvage produced a **perfectly valid, perfectly empty database**. The guard that checks the
replacement contains players before deleting the original rejected it. Without that guard this
would have swapped a blank database in over a working one and deleted the only copy - precisely
the disaster it was written for, caught on its first real outing.

### The deadlock: a repair that could not run because the app had not started

The recovery above was correct and still never completed, for two reasons that only show up on
a real host.

**It wrote to the volume it was rescuing.** The first version opened the database read-write and
pruned it *before* copying. Pruning needs a write transaction, a write transaction needs
somewhere to put its journal, and on a volume with zero bytes free there is nowhere - so the
repair died at precisely the moment it was needed. `VACUUM INTO` only *reads* its source, and
works from a read-only connection, so the copy now comes out first and every delete happens to
the copy, on a disk with room. Not one byte is written to the starved volume until the original
is deleted.

**It ran before the port was bound.** Render kills a process that has not bound a port within a
few minutes. Opening the database can fail outright on a starved volume, and repairing one means
copying a near-gigabyte file - neither finishes inside that window. So the process died before
it listened, the host killed it for not listening, and it restarted into the same race for ever:

```
SqliteError: disk I/O error   at ensureMigrationTable ... at startServer
==> Instance restarted
==> Port scan timeout reached, no open ports detected
```

The port is now bound **first**, by the CLI, with a holding page that says it is starting up and
refreshes itself. `startServer` takes over that same already-listening socket rather than binding
its own, so the process never stops listening and there is no deadline to lose. A visitor during
a repair gets an honest "this is taking a few minutes" page instead of a refused connection.

Two smaller faults found on the way, both in error handling, which is where they hurt most:
the compaction logged only its *successes*, so the previous failure left the log showing it
starting and then nothing; and the cleanup inside its `catch` could itself throw, which would
replace a clear message with a second crash during boot.

### A 1 GB disk is ~29x more than this needs

Worth stating plainly, because the obvious response to a full disk is to buy a bigger one and
that would have been the wrong call here. Costed out, a **whole season** is about:

| | |
|---|---|
| `player_fixture_history` | 20.3 MB |
| `projection` (pruned) | 5.6 MB |
| `player_snapshot` (pruned, payload gone) | 2.1 MB |
| everything else | ~7 MB |
| **total** | **~35 MB** |

The volume was not too small. It was full of a column nothing reads, and the app could not clear
it because of a bind in how SQLite reclaims space.

**`VACUUM` cannot run on the disk it needs to free.** It builds a complete second copy beside the
original before swapping, so it wants roughly twice the file size free - and a 1 GB database that
has filled a 1 GB volume will never have that. Pruning frees pages *inside* the file, which is
enough to let the app write again, but the file on disk stays the size it grew to for ever.

The way out is that the second copy does not have to live on the same volume. `VACUUM INTO`
writes a consistent database to any path, and after pruning that copy is small, so it goes to
scratch space outside the volume, the bloated original is deleted, and the small copy is moved
back. This runs automatically at start-up, **before the database is opened**, and only when the
volume is genuinely starved - under 50 MB free. `fpl reclaim --force` does it on demand.

The order is the whole design, because there is a moment when the only copy is the scratch one.
The replacement is opened and must pass `integrity_check`, contain the tables the app cannot run
without, and **contain players** before anything is deleted - that last one matters because
`integrity_check` passes happily on a structurally valid empty file, and swapping a blank
database in while deleting the real one is the worst outcome this feature could possibly have.
If any check fails the original is left exactly as it was: a full disk is recoverable, a database
destroyed while recovering one is not. That guard is exported and tested directly rather than
only through the paths that happen to reach it.

### The column that caused it, and the check that never ran

Two faults, one of them mine from the previous fix.

**`freeDiskBytes` never worked.** It called `require('node:fs')` inside an ES module, where
`require` is not defined at all - so it threw on every call, the `catch` swallowed it, and it
returned `null` for ever. Its only caller reads `null` as "cannot tell" and skips, so the
boot-time prune written specifically to catch a filling disk **never ran a single time**. A
silent failure inside error handling, which is the worst place for one: nothing is watching the
thing that is meant to be watching.

**`player_snapshot.raw_json` is never read.** Grep the repository for a `SELECT` of it and there
is none - every query uses the parsed columns beside it. It is a verbatim copy of the API payload
written for ~700 players every three hours, and measured, it is where the volume went:

| | before | after |
|---|---|---|
| one snapshot | 0.94 MB | **0.05 MB** |
| per day | 7.5 MB | **0.44 MB** |

Seventeen times smaller. It is now written empty on `player_snapshot` only - the small bounded
tables (team, position, event, season history) keep theirs, where a verbatim record of what the
API said costs a few hundred rows once and is how a schema change gets diagnosed. Pruning also
empties it on the snapshots it keeps, so an existing database shrinks rather than merely stopping
its growth.

**Pruning can now run on a full volume.** The bind that made this unrecoverable: SQLite cannot
delete a row without somewhere to write its undo journal, so the one operation that frees space
is the one a lack of space forbids. After an ordinary prune fails for want of room, it retries
with `journal_mode = MEMORY`, which removes that requirement. A genuine trade - a crash midway
leaves the database inconsistent, which is why it is not how this normally runs - and it is only
reached when the alternative is an application that cannot start.

### "Stale" was hiding the reason, which was in the database all along

A source failed on every refresh for a week and the Dashboard said **stale** - the same word it
uses for data nobody has got round to refreshing. Those call for opposite responses: one wants a
button pressed, the other wants a fault fixed, and pressing the button at a failing source
achieves nothing silently.

The reason was recorded in `ingest_run.note` every single time. The freshness table just never
asked for it - it queried `lastSuccessfulRun` only, so a failure was invisible by construction.
It now also reads the last run *if that run failed and nothing has succeeded since*, shows the
error against the source, and changes the banner: **"X failed to refresh. Pressing refresh again
will not help until the reason is fixed."**

Two faults underneath it, both of which made a failure look like success:

- **One broken step took down every step after it.** Order in `ingestAll` is a dependency, not a
  chain of command: bootstrap genuinely must succeed, since everything after references the
  players and gameweeks it writes, but the later steps are independent. Per-player results
  failing meant the squad refresh after it never ran - so the Dashboard reported the *squad*
  stale and pointed at a button that would die in the same place. Each independent step now
  records its own failure and the refresh carries on.
- **Every player failing counted as a successful import.** Per-player failures are collected
  rather than thrown, which is right - one departed player 404ing must not cost the other 700
  histories. All of them failing is not that. It is an outage, and reporting it as success left
  the Dashboard saying "updated just now" while nothing had been written and the gameweek stayed
  ungraded with no error anywhere to explain it.

### A gameweek that finished while the app was down never came back

Gameweek 6 finished during the crash loop above and then would not grade, however many times
the refresh was pressed. The trigger that fetches per-player results asked the wrong question,
in two separate ways, and both were live:

```js
// before
const latestFinished = /* the single most recent finished gameweek */;
const notYetCaptured = COUNT(player_fixture_history WHERE event_id = latestFinished) === 0;
```

- **Wrong table.** Grading needs `actual_points`; this checked `player_fixture_history`. A
  gameweek whose match history arrived but never became results - a crash, a restart, a full
  disk in between those two steps - looked captured from then on, and nothing retried.
- **Wrong scope.** Only the most recent finished gameweek was ever examined. Anything that
  finished while the app was down was written off the moment a later one arrived.

It now asks the question the Accuracy page asks - *which finished gameweeks cannot be graded?* -
across every finished gameweek, not just the newest.

The cheap half of the repair matters as much. `syncActualPointsFromFixtureHistory` turns stored
history into gradeable results with one idempotent statement and no network requests at all, and
it used to run only *inside* the 700-request fetch it was buried in. It now runs on every
refresh, so the common case - history on disk, results missing because something died between
the two steps - costs nothing to fix.

A standing lesson from this one and the crash loop before it: **recovery triggered by an event
only works if you were running when the event happened.** Anything that has to survive an outage
has to be driven by what the data looks like now, not by what just happened.

### A crash loop cannot be fixed from a page the crashed process never served

The disk-full fix above was right about the cause and wrong about the cure. It put the recovery
behind a button on the Import Data tab - and the next failure was not an import erroring, it was
the process dying in `openDatabase` before the server ever listened:

```
SqliteError: disk I/O error
  at Database.pragma (.../better-sqlite3/lib/methods/pragma.js)
  at openDatabase (dist/db/index.js)
  at startServer (dist/report/server.js)
```

`journal_mode = WAL` rewrites the database header, so it is the first thing a full disk refuses.
The service then restarted, failed identically, and looped - with the one screen offering to free
space unreachable the entire time. **Recovery that lives inside the app has to run before the app
needs the disk, or it may as well not exist.**

Three changes, in the order they now happen:

1. **Boot prunes when the volume is tight.** Under 100 MB free, the app prunes immediately and
   says so in the log, rather than waiting for the next refresh to discover it the hard way.
2. **A failed open frees disposable files and retries once.** Only for a space failure - any
   other fault is made no better by deleting a warm cache, and a bad day should not also cost a
   few hundred needless API calls. If freeing nothing was possible, it does **not** retry: an
   open that cannot succeed is how a crash loop becomes a faster crash loop.
3. **`journal_mode` is no longer allowed to be fatal.** It and `synchronous` are performance
   settings; without them SQLite falls back to a rollback journal and everything still works,
   slightly slower. Losing the whole app because it could not go faster is the wrong trade.
   `migrate()` is deliberately *not* caught - a half-applied schema is a correctness problem, and
   carrying on with one corrupts data rather than merely slowing it down.

The decision in (2) is a separate exported function rather than an `if` buried in the opener,
because it is a policy with real consequences and because a full disk cannot be conjured up in a
unit test while a policy can be called directly. Worth being plain about the limit of that: the
`journal_mode` fallback in (3) is defence in depth that **is not covered by a test**, since
reproducing it needs a genuinely full filesystem rather than a read-only one.

### The database was eating its own disk

Imports started failing with **"disk I/O error"**, which reads like failing hardware. It is
SQLite's wording for a full disk, and the 1 GB Render volume had filled.

This app writes history on purpose - snapshots are how a price change is detected, stored
projections are how it grades itself afterwards - and nothing ever deleted any of it. Measured:
one snapshot of 700 players costs **0.94 MB**, almost all of it `raw_json`, a verbatim copy of
fields already parsed into columns beside it. At the configured three-hourly refresh that is
~7.5 MB a day, ~0.44 GB over a season. Separately, `projection` has no primary key, so every
team generation appended ~650 more rows with their own breakdown JSON, forever.

History is now kept deliberately rather than indefinitely, and the retention rule is the
interesting part because the obvious one is wrong. "Delete anything older than a week" frees
plenty of disk and silently destroys the baseline the Accuracy benchmark depends on - it scores
FPL's own `ep_next` against this model using the last snapshot *before* each deadline, and
nothing would have failed loudly; the comparison would just have stopped having an answer. So
what survives is what something actually reads:

- the newest snapshots, for price-change detection and current prices;
- **the last snapshot before each gameweek deadline**, for the benchmark;
- the most recent projection run per player per gameweek per model version - grading already
  selects `MAX(created_at)`, so earlier runs are read by nothing, while a run under a *different*
  scoring version is kept, because those are not duplicates.

Pruning runs automatically after every refresh, so the cost is paid where the growth happens.

**Recovering a disk that is already full** needed one more thing. On a genuinely full disk SQLite
cannot delete a row either - a `DELETE` still writes to its journal first - so a recovery that
starts with the database can fail with the same error it was called to clear. The manual "Free up
space" button therefore unlinks the HTTP response cache first, which needs no free space at all
and is safe by nature since every file in it is a copy of something the API will serve again.
`VACUUM` is attempted last and allowed to fail: deleting rows already frees pages *inside* the
file for reuse, which is what unblocks writing, while shrinking the file needs room for a second
copy. The automatic prune deliberately leaves the cache alone - it is not a recovery, and
throwing away a warm cache every few hours would slow every refresh and hammer the FPL API.

A full disk is now also reported as a full disk, with what to do about it, rather than as
"disk I/O error".

### The armband tiebreak could not break ties

The benchmark answered the question it was built for, and the answer split cleanly in two.

**The projections are fine.** Over 3,820 graded projections this model's typical miss is 1.26,
against 1.36 for FPL's own `ep_next` and 1.39 for points-per-game - 8% and 9% closer. The work in
here is buying something.

**The armband was giving away 13.3 points a week**, against the best captain in the same squad,
over three gameweeks. That is larger than everything else on the page combined, and it is a
different failure from bad projections.

The cause was a fault in the upside term, not a judgement call. `maxCeilingBonus` was 0.6, and
measured across the shapes that actually compete for the armband it turned an **eight-point**
spread of genuine upside into a **0.15-point** spread of bonus - with both premium forwards, the
exact players the term exists to identify, pinned at the same capped value. A tiebreak that
returns the same number for all of its own candidates is dead weight, the same class of fault as
a comparison sitting behind a `||` that never fires.

The cap is now **1.25** - the model's own measured typical miss. That sizing is the point: a
difference in expected points smaller than a typical miss is not evidence of anything, so upside
is allowed to decide inside roughly that band and nowhere beyond it. It remains powerless against
a clearly higher projection, which is the property the low cap was protecting.

Worth stating plainly: this was **not** tuned to produce a particular captain. Re-running the
gameweek-4 decision through the fixed term still picks the same player it picked then. The fault
being repaired is that the term did nothing, not that it gave an answer somebody disliked. Only
the captaincy changes, so `modelVersion` does not move and calibration keeps accumulating.

### Captain shortlist

Naming one captain gives a reader no way to disagree usefully, which is why the same question
kept coming back. The shortlist shows the top five candidates ranked by exactly the value the
optimiser maximised - so it is the decision it made, not a second opinion beside it - with the
average week, the good week, and the chance of a double-figure haul side by side. For a doubled
pick the last of those is closer to what is being bought than the average is.

### Managers worth watching

A specific rival can now be tracked (`app.rivalTeamIds`), and it is deliberately not a list of
his players. Copied wholesale that is cargo-culting; ignored entirely it throws away the one
signal you have about someone ahead of you. So the page shows the **disagreement** between his
squad and this model, in three groups:

- **You have missed these** - he owns them, the model rates them, you do not own them. The model
  already agrees, so these are the only ones worth acting on quickly.
- **His call, not ours** - he owns them, the model does not rate them. Either he knows something
  the model does not or he got lucky, and those look identical for several weeks.
- **Yours, not his** - so the comparison runs both ways instead of only flattering him.

The split is the whole value: without it the two kinds of difference blur, and copying the second
group is copying his variance as much as his judgement. Squads are only public once a gameweek
has started, the same API blind spot that applies to your own team, and a rival who cannot be
read never takes the rest of the refresh down with them.

### The first live backtest found a flaw in the backtest

Running it on real data produced a footnote that mattered more than the result:
*"7 of the recommended XI have no recorded result, so the actual total is understated."*

A player with no recorded result scores **zero** in a replay. Meanwhile "what you played" was
being taken from the real FPL total, which knows about those players perfectly well. So every gap
in the results import landed **entirely on the replayed side** of the comparison, and the model
was being charged for data this database happens not to have.

Two corrections, both of which change what the number means:

- **Your own XI is now scored from the same results map**, from the picks stored for that
  gameweek. Your real FPL total is kept for context, but it is not the thing being compared
  against - it includes hits and chips and suffers none of the missing-result problem.
- **A gameweek with large gaps is left out and named** rather than scored against them. Below
  90% squad coverage the replay is measuring how complete the import is, not how good a policy
  is, and reporting that as model quality would be worse than reporting nothing.

Both are verified to fail when removed: disabling the coverage gate, or pairing against the
external total, each breaks a test that exists for exactly that reason.

### Replaying the season in points

Every figure on the Accuracy page measures **error** - how far a projection was from an outcome.
None of them is the objective. The objective is points, and the assumption that a smaller error
produces more of them had never been checked. It is not obviously true: mean absolute error
rewards correctly predicting the several hundred players who score 0-2, which has no bearing at
all on choosing eleven.

So each gameweek is now replayed from the squad actually held, and four ways of picking an XI and
a captain are scored in points: **this model**, **what you played**, **FPL's own `ep_next`**, and
**last week again** - the cost of not deciding. Scored with real auto-substitution and
vice-captain rules, so these are points that would have counted.

Two deliberate limits. Transfers are out of scope: simulating one changes the squad, and from the
next gameweek onward nothing is comparable to anything. And the result carries a **paired
bootstrap 95% interval** rather than a bare number, because a handful of weekly differences is a
small, lumpy sample and a point estimate invites acting on noise. When the interval spans zero
the page says *"nothing is established either way"* in those words.

It also reports the **smallest weekly edge the sample could detect at all** - usually larger than
the effect being argued about, which is the useful part. There is no point debating a two-point
change when the instrument cannot see below nine.

**The leak that would have made all of it fiction.** Pinning the snapshot is not enough. The
model also reads per-player match history and finished results, and neither is tied to a
snapshot - so a replay of gameweek 3 was reading gameweeks 4, 5 and 6, scoring itself on
knowledge it could not have had. `asOfEventId` now cuts off recent form and both routes of club
strength, and three tests fail if that cutoff is removed.

The wiring is guarded separately from the behaviour, because they fail differently: forgetting to
*pass* the cutoff leaves every other backtest test green while the numbers quietly become
fiction, so the call site is asserted directly.

**A second leak, found by stating the property properly.** The guards above each checked one
query. The invariant is stronger than that and worth writing down as one thing: *hiding
gameweeks 3 onward must produce exactly what a database that has never seen gameweek 3 onward
produces.* Testing it that way immediately caught the start-rate denominator - how many matches
a club has played - which was counting every finished fixture regardless of cutoff. A replay of
gameweek 3 read a snapshot in which a nailed-on starter had 2 starts and divided it by the
club's 8 finished matches, collapsing his start rate from 2/2 to 2/8. Measured on the test case,
expected minutes came out at 37.3 instead of 49.3: a 24% understatement, applied to every player
in every replayed week. The backtest had been scoring a model that believed its own starters
were rotation risks.

#### Widening the sample

With five gameweeks the smallest detectable edge was 15.8 points a week - larger than any effect
worth arguing about, which makes the instrument close to useless however correct it is. Two
things were capping it, and neither was missing results.

**Squads were only ever stored for the week they were showing.** The replay cannot score a week
without knowing the fifteen held, so the sample was the weeks somebody happened to be running
this app. But a manager's picks go public the moment a gameweek starts and stay public, so every
completed week of the season could have been fetched at any time. The refresh now walks them and
stores the ones not already held - one request per missing gameweek, none once caught up.

**Snapshots only exist for weeks somebody was running this app**, so the season before
installation was unreplayable however complete the results were. It does not have to be:
every counting stat a snapshot carries - minutes, starts, goals, assists, saves, bonus, expected
goals, expected assists, defensive contribution - is a running total of per-match rows the API
backfills in full, so summing the matches before a deadline reconstructs the figure *exactly*,
and a test pins that exactness against a real snapshot rather than settling for close. Price
likewise: each match row records what the player cost that week.

Three fields cannot be recovered, and inventing them would be worse than not replaying the week:

- **`ep_next`**, FPL's own forecast. Not derivable from anything. Rebuilt weeks cannot score
  that benchmark, so it is scored over the weeks it exists for and the table shows a **Weeks**
  column saying how many. A benchmark averaged over a different set of weeks than its rival is
  not a benchmark.
- **Status and news**, the injury flags. Today's would be lookahead of the worst kind, so
  everyone reads as fit. This *handicaps* the replayed model - it will start someone who was
  doubtful - which is the right direction for a bias that cannot be removed.
- **Ownership**, the loudest lookahead in the dataset, because it rises *after* a player
  returns. Null, so the start-probability prior falls back to neutral and the differential
  bonus does not apply.

Each week records which basis it used, and the page says in plain words what the rebuilt weeks
could not see.

### Measuring against something, at last

Four graded gameweeks produced a typical miss of 1.31 points per player and no way to know
whether that was good. Every figure on the Accuracy page was self-referential: with nothing to
beat, "the model is 1.31 out" and "the model is useless" look identical, and the page could not
answer the only question that matters - is any of this better than not doing it?

So the same players, over the same gameweeks, are now scored three ways:

- **This model** - what the app projected before the deadline.
- **FPL's own number** - `ep_next`, the expected-points figure the API publishes for free. This
  is the benchmark that counts: it is what you get by doing nothing, and any week the model
  loses to it is a week this app made decisions worse.
- **Points per game so far** - the "just pick whoever has been scoring" heuristic this model is
  supposed to improve on.

Both baselines are read from the last snapshot taken *before* each deadline, never after, so they
are what was genuinely knowable at the time. A player is scored only when all three have an
answer for him - nobody wins by declining the hard cases. The page leads with the verdict, and
the verdict is allowed to be **"this model is losing"**; the tests set the model up to lose and
assert that it is reported as losing, because a comparison that can only flatter is worse than
none.

### Grading the armband on its own

Averaged into an eleven-player total, a catastrophic captaincy and a merely dull one look the
same. That hid the largest decision on the page: one pick, doubled, which moves a week further
than anything else the model does.

Each gameweek's captain is now graded against **the best captain available from the same 15** -
not the best in the league, since the squad is the only part the model controlled that week - and
the season total is shown as points given away. One subtlety worth stating because getting it
wrong doubles every number on the page: the armband adds *one extra copy* of the captain's score,
so what a bad pick gave away is the difference between the two single scores, not twice it.

This separates two failures that need completely different fixes: **picking bad players**, and
**picking fine players then doubling the wrong one**. Guessing between those wastes weeks.

### When the captaincy is a bet on one match

Choosing between two players who are playing *each other* is not the same kind of decision as
choosing between two players in different games, and the model had no way to say so.

The arithmetic is fine and deliberately unchanged. Expectation is linear, so correlation does not
affect which of two candidates projects higher, and the fixture model is already internally
consistent about the match itself: a home player's expected goals conceded is computed from
exactly the same attack-versus-defence terms as the away player's expected goals, so both sides
of one fixture imply a single scoreline. There is no bug to fix in the total.

What is missing is what the decision *is*. Two players in one match are two sides of a single
bet, and the parts of their returns that conflict - a clean sheet for one needs the other kept
quiet - cannot both land. The optimiser maximises a sum of means, and a sum of means is blind to
how correlated its terms are, so it will happily put a third of your week on one fixture and
never mention it.

So the captaincy line now says when the two candidates are playing each other, and how much of
the XI rides on that match with the armband doubled. It is a statement, not an adjustment: no
projection moves, and the model still picks on expected points. The reader is the one who knows
whether they want the week decided by one game.

### The news sources are a reading list, not a feed

`config/intel.json` gains `newsSources` - BBC Sport, ESPN, TNT Sports, FourFourTwo, Goal and
NewsNow - each with what it is actually worth checking for, surfaced on the Import Data page
beside a note saying plainly that **the app does not read them**.

That refusal is the point, not a missing feature. Football news is a judgement call: a scraper
cannot tell "we'll see how he trains" from a confirmed absence, and turning headlines into
automatic xPts nudges is precisely the do-what-the-pundits-said behaviour this model exists to
avoid. What a human reading these can do is write a dated, sourced line into the intel file,
which is auditable and expires on its own.

The page also now says when those notes are about to expire or already have. They stop being
applied after `staleAfterGameweek`, and until now that happened silently - the model quietly fell
back to the API's own flags with nothing on screen to say so.

### Two teams, not three scores

The gameweek scorecard kept producing the same question: *we said 46.7, it got 34, your score 45
- how can there be three scores?* There are not three. There are **two teams**, and the card was
running both through one undifferentiated grid of numbers, so they read as three attempts to say
the same thing.

This page exists to grade the app, which means it has to show what the app's own XI did. That is
only the same team you played if you followed every piece of advice exactly, and you generally
will not have. So each card now puts the two under headings that name whose team it was:

- **The team we told you to play** - *we guessed* 46.7, *it really scored* 34. The gap between
  those is the app's error, and the tag at the top of the card is that gap and nothing else.
- **The team you actually played** - *you scored* 45. Your real FPL total, hits and chips
  included.

Then the line that gives the card a point: **"You beat our XI by 11."** Three unrelated numbers
became two labelled teams and one comparison.

**A ceiling the same row disproves is now withheld.** "Best you could have done" is computed from
the 15 stored with that gameweek's advice - which is *last week's* 15 whenever the team was
generated before the deadline, because the public API only returns picks for a gameweek that has
already started. Make a transfer and the stored squad is not the one you fielded, and the figure
can land *below* what you actually scored. That is impossible for a genuine ceiling, and printing
it anyway costs the reader's trust in every other number on the page. It moves into the full
table and shows `n/a` whenever the row contradicts it.

### Looking at the team is not rebuilding it

Generation stays explicit - a team is only worth acting on when it is built from all the evidence
at once. That rule was being applied to *looking* as well: leaving My Team and coming back threw
the page away and demanded the button again, which then produced the same answer from the same
data. Clicking past a gate that never says no is how you learn to ignore it.

The question that actually matters is whether the team on screen was built from the data
currently on disk, which is a question about the inputs. So `cached_recommendation` stores the
last generated page next to a fingerprint of every input the projections read, and a plain visit
serves it back with the age it was built at. A new import moves the fingerprint, the stored page
stops matching, and the button comes back - now saying *why* ("new data has arrived since your
last team was built") rather than repeating the first-run explanation.

The fingerprint is counts **and** maximum timestamps, per table. A timestamp alone misses a
deletion, since clearing a squad leaves the surviving rows untouched; a count alone misses a
same-size overwrite, which is exactly what re-importing a bootstrap file is.

### Fewer words, and the same word for the same thing

The app had four names for one idea - *projected*, *xPts*, *expected points*, *we projected* -
and used "we" and "it" for itself in adjacent labels without ever saying what "it" was. On the
Accuracy page that made a scorecard genuinely unreadable: `We projected 46.7 -> It scored 34`
next to `You scored 45` invited the reading that two of those three were your team.

The subject is now named once, above the pair - **the team this app told you to play** - and the
labels shrink to **we said** and **it got**. Your own total is **your score**. A gameweek chip
that read `12.7 too high` (too high *what?*) now reads **we guessed 12.7 too high**. The My Team
tile called *Projected* is **expected score**.

Two further things the page was getting wrong about itself:

- **"What the model has learned: nothing yet"** read as *it is not measuring anything*, which is
  false - it grades every gameweek, and those numbers are further down the same page. What it
  withholds is the *correction*, until enough gameweeks sit under one scoring version. It now
  says how many it has, how many more it needs, and that the earlier ones do not count because
  the scoring they measured has since changed.
- **Most over-rated / most under-rated are not opposites.** A player only reaches the first list
  by being rated highly, which is also how a player gets recommended - so this app's own picks
  are structurally over-represented there, and structurally absent from the second, which is made
  of players rated near zero and therefore never picked. Presented side by side as a symmetrical
  pair, that looked like a bug in the advice. The players you were actually told to start are now
  marked, and the asymmetry is stated instead of left to be inferred.

`formatDuration` also returned the literal `<1m`, which every caller dropped straight into HTML,
where the `<` opens what the parser takes for a tag and eats the rest of the sentence. It returns
"under a minute".

### Saying how sure it is, in the heading and not just the small print

Three places where the app stated more confidence than it had. None of them changed a number;
all of them changed what a reader would do.

**A tied chip week is not a found one.** The chip advisor already worked out when it could not
separate the best gameweek from the field - it sets `confident: false` and the paragraph says
"no standout week ... it has sorted a tie". The card heading printed a bold **GW4** anyway. A
chip is worth one play a season, and the heading is what people actually read, so that heading
contradicted its own paragraph in the most expensive place on the site. It now reads "no
standout week - hold", and the tied week stays in the body where the caveat travels with it.

**"No last-season history loaded" was not measured.** It was derived from how many players were
being *projected from* last season's rates - which is nobody from the moment this season has
minutes, whether the history is loaded or not. So from gameweek 2 onward the page told every
reader their history was missing, and the claim carried no information either way. It is now
counted from `player_season_history` directly, with three distinct states: missing, loaded and
anchoring, and loaded and actively supplying rates.

That message matters more than it looks, because missing last-season history disables the
anchoring in `attacking.anchorPriorWeightMinutes` entirely - with no anchor, every thin rate is
shrunk toward **zero** rather than toward what the player actually did. Measured on the model
itself, three gameweeks in: an elite striker's goals term falls from 3.39 to 0.98, a
hard-working midfielder's defensive-contribution term from 0.76 to 0.01, projections roughly
halve, and the gap between the two shrinks from 0.76 to 0.18. Everything collapses toward the
appearance points, which is the only term that survives. That is what "low confidence" actually
means here, so the warning now says it.

**The captaincy names its runner-up.** The armband doubles one score, and a few tenths between
two players is not a finding - least of all in a week the model itself rates low confidence,
which is exactly when the page stated the pick most flatly. The card now always shows what the
next-best option projects, and when the gap is under `captain.tooCloseMargin` (1.0, display
only - it never changes who is captained) it says outright that these are two similar bets. A
captain projecting *below* his runner-up is possible, because the bounded upside bonus can
prefer the better shape at the same average; that is the most confusing pick the page can
produce, so it is now spelled out rather than left to be discovered.

### Club form is expected goals, split into attack and defence

The API's own team ratings are a pre-season view. Current form nudges them
(`teamStrength.tableWeight`, 1.0), bounded to a 0.7-1.3 multiplier either way so form can move a
rating but never replace it, and shrunk toward no adjustment by matches played
(`teamStrength.formPriorMatches`, 5) for the same reason every other rate here is shrunk.

**`tableWeight` went from 0.3 to 1.0 in `heuristic-0.22.0`, and that is a real change to the
numbers.** The question that found it was "he plays for a team that is not winning anything, so
why is he still in my squad?" - and the answer was that club form barely registered. The shrinkage
above is the caution this term needs; the exponent was a *second*, independent damp sitting on top
of an estimate that had already been damped, and two mechanisms for the same doubt, multiplied,
do not produce careful - they produce inert. Measured: a club creating **half the league average**,
six matches in, had its attackers downgraded by **9.1%** - 0.61 points on a 6.7 projection, which
cannot dislodge anybody from anything. The fixture alone moves the same player **61%** between his
easiest and hardest week, so the model knew a trip to the leaders was hard and had no idea the club
it was judging had stopped scoring. Team strength was coming almost entirely from the API's
pre-season ratings, which is reputation, not form. At 1.0 the same club comes down **27.3%**. The
three guards that matter are untouched: it is built from expected goals rather than results, it is
shrunk by how many matches are behind it, and it is still bounded either way.

Two things about *how* that nudge is measured changed in `heuristic-0.21.0`.

It used to be **points per game**, which is the most luck-exposed number in football, applied as
**one factor to both attack and defence**. That has two failures. A side that has conceded
nothing off five expected goals against reads, on points alone, as the best defence in the
league — right up until the finishing regresses. And one number cannot describe a side scoring
freely while leaking badly, because moving it moves both ratings the same way; every club is
forced onto a single good-to-bad axis.

It is now **expected goals, for and against, held separately**. This is not a new belief — the
player model already prefers expected goals to actual ones (`attacking.xgWeight`, 0.7) on the
grounds that they stabilise far faster over a small sample. It was simply never applied to
clubs, so the app trusted xG for a striker and scorelines for his team in the same projection.

Two details that are easy to get wrong:

- **Expected goals against is a whole-team figure**, recorded against every player who was on the
  pitch. Summing it across a squad multiplies one match's xGA by eleven, so it is taken as a
  maximum per fixture while xG *for* is summed.
- **Clubs with no underlying numbers yet fall back to scorelines**, and are then averaged only
  against other clubs on that same basis. Expected goals and goals scored are not the same scale;
  comparing a club measured in one against a league average made partly of the other rates it on
  the gap between two metrics rather than on its form. Early in a season, when the per-gameweek
  breakdown lags the results, that mix is the normal state rather than the edge case.

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

`https://fantasy.premierleague.com/api/my-team/<your team id>/` returns both, but **opening that
URL directly never works**, however logged in you are — it returns
`{"detail": "Authentication credentials were not provided."}`. The endpoint wants a bearer token,
and a browser only sends one from the site's own JavaScript, never on a plain navigation. No
setting changes that.

The route that does work:

1. Open `fantasy.premierleague.com` and log in.
2. Press **F12**, click the **Network** tab, type `my-team` in its filter box.
3. Click **Transfers** in the site's own menu. A `my-team` row appears.
4. Click it → **Response** → select all → copy.
5. On the Import Data tab, press **Paste instead** on that card and paste it in.

Every import slot takes pasted text as well as a file, for exactly this reason: the one thing
you cannot download is the one thing you most need to paste.

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

**One card per player you own.** The list used to be the top five swaps by net gain, which
sounds right and isn't: measured, five cards covered three players, because one weak holding
filled three slots with variants of the same move while the next-weakest players in the squad
were never named. Only one transfer gets made in a normal week, so the question the list has to
answer is *which of your players should be the one to go* — and it cannot answer that while a
single slot can crowd out the rest. Each squad member now appears at most once, with their own
best affordable replacement.

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

### Telling the app what you actually did

FPL publishes your picks only for a gameweek that has **already started**
(`entry.current_event`). So from the moment one gameweek ends until the next kicks off — which is
most of the week, and all of the time anyone spends planning — the app can only see last week's
team. Every projection, transfer suggestion and hit calculation in that window silently assumes
you still own players you may have sold days ago, and there is no way for it to find out.

Each suggested transfer therefore carries a tick box. Ticking it records the move against the
gameweek being planned and applies it on top of the last real squad, so everything below it is
rebuilt on the team you actually have. Untick to undo.

It is an **overlay, never a replacement**. The API is always the truth about a gameweek it can
see, and a confirmed transfer is applied only when the outgoing player is still in the squad and
the incoming one is not. That makes it idempotent by construction: once the gameweek starts and
the real picks arrive already containing the new player, the swap no longer matches and is
skipped rather than applied a second time. There is a test for exactly that sequence.

A confirmation that cannot be applied — the incoming player is missing from the latest player
data — is reported in the notes rather than dropped. A transfer that quietly did nothing would
leave every number built on it wrong with no sign on the page that anything had gone astray.

Substitutions deliberately have no tick box. The optimiser re-solves the XI from your fifteen
every time, so which eleven you fielded last week does not change what it advises this week — and
the "changed since gameweek N" comparison already reads your real picks once the gameweek starts.

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
