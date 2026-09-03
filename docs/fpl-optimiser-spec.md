# Fantasy Premier League Optimiser — Requirements Specification

**Version:** 0.1 (draft for Claude Code build)
**Owner:** Dale
**Target season:** 2026/27 (GW1 deadline Fri 21 Aug 2026, 18:30 BST)
**Status:** Rules section pre-filled from the official 2026/27 ruleset — to be reconciled against Dale's uploaded rules file (which becomes the source of truth once supplied).

---

## 1. Purpose & goal

Build a single-user application that helps Dale field the highest-scoring possible Fantasy Premier League (FPL) team every gameweek, and win his mini-league over the season.

The app should:

1. Track statistics for every Premier League player.
2. Track availability news (injuries, suspensions, rotation risk, price changes).
3. Know Dale's current squad, budget, free transfers, and chips remaining.
4. Apply all FPL rules as hard constraints.
5. Recommend the optimal starting XI, captain, transfers, and chip usage for the upcoming gameweek.

### Success criteria (realistic)

No tool can guarantee winning — FPL has irreducible variance. Success is defined as:

- Recommendations that maximise **expected points** for the gameweek within all rules.
- Never recommending an unavailable or illegal player.
- A clear, explainable reason behind every recommendation (so Dale can override with judgement).
- Beating a "template/popular" baseline team over a rolling window.

---

## 2. Scope

### In scope (MVP)
- Ingest player data, fixtures, and prices from the FPL API.
- Ingest availability / injury flags.
- Pull Dale's current squad automatically via his FPL entry ID.
- Rules engine enforcing squad, budget, transfer, and formation rules.
- Expected-points model per player per gameweek.
- Optimiser: best legal starting XI + captain from the current squad.
- Transfer recommender: best 0/1/2+ transfer moves within free-transfer budget (and whether a −4 hit is worth it).

### In scope (later phases)
- Chip strategy (when to play Wildcard, Free Hit, Bench Boost, Triple Captain).
- Multi-gameweek transfer planning (look 3–6 GWs ahead, fixture swings).
- News scraping beyond the API's own flags (press conferences, predicted lineups).
- Mini-league tracking (compare vs rivals' teams).

### Out of scope
- Auto-executing transfers on the FPL site without confirmation (see Open Decision D1).
- Other fantasy games (UCL Fantasy, Draft) — Classic FPL only.

---

## 3. Assumptions & open decisions

### Assumptions
- This is **official Fantasy Premier League** (fantasy.premierleague.com), Classic format.
- Dale has one team in one or more mini-leagues.
- The app runs for Dale only (no multi-user auth needed).
- Dale is comfortable with a TypeScript/Node stack (consistent with his other Claude Code builds).

### Open decisions — all four resolved

| # | Decision | Resolved as | Where it lives |
|---|---|---|---|
| **D1** | Action mode: recommend only, or execute transfers via the API? | **Recommend only.** An app that can spend your transfers and your money on a projection it might have got wrong is a different risk category from one that shows its working and lets you decide. Not revisited. | — |
| **D2** | Interface: web, CLI, or scheduled report? | **Both web and CLI**, sharing one code path. The web report is deployed on Render and refreshes itself on a schedule; the CLI does everything the web does. Neither is a wrapper around the other — `src/report/recommend.ts` is the single source and both call it. | `src/report/cli.ts`, `src/report/server.ts` |
| **D3** | News depth: API flags only, or external scraping? | **API flags, plus two structured substitutes.** Curated intel is a hand-maintained file with sources and dates, applied transparently and withheld on a price mismatch. Ownership acts as a proxy for the crowd's team-news reading. Neither is scraping, and both are visible in the output. | `src/model/intel.ts`, `minutes.ownershipPriorPivot` |
| **D4** | Risk appetite: template or differential? | **Mostly maximise points, with a mild tiebreak toward rank.** `differential.weight` is 0.15, so the largest possible bonus is 0.15 xPts — enough to decide a genuinely close call, never enough to justify a meaningfully worse player. Set it to 0 for pure points maximisation. Separately, the *captaincy* now leans on the shape of the distribution rather than the mean, which is a different question from template-vs-differential. | `config/model.weights.json` → `differential`, `captain` |

The original wording of each is preserved in git history.

---

## 4. Users

Single user (Dale). No roles, no shared access. Local or personal-cloud hosting.

---

## 5. Data sources

### 5.1 Primary — official FPL API (public, free, no key)
Base: `https://fantasy.premierleague.com/api/`

| Endpoint | Provides |
|---|---|
| `bootstrap-static/` | All players (`elements`), teams, positions (`element_types`), prices, form, total points, ownership, availability flags, gameweeks (`events`) |
| `fixtures/` | Full fixture list with kickoff times + fixture difficulty rating (FDR) per team |
| `element-summary/{player_id}/` | Per-player history: points, minutes, xG/xA-style underlying stats per fixture |
| `entry/{team_id}/` | A manager's overall info (bank, team value, chips) |
| `entry/{team_id}/event/{gw}/picks/` | A manager's squad for a given gameweek |
| `entry/{team_id}/history/` | Transfer history, chip usage, past gameweek scores |
| `event/{gw}/live/` | Live points for all players in a gameweek |
| `leagues-classic/{league_id}/standings/` | Mini-league standings + rivals' entry IDs |

**Notes for the build:**
- The API is unofficial but stable. Be a good citizen: cache aggressively, throttle requests, set a descriptive User-Agent.
- `bootstrap-static` is the workhorse — refresh it on a schedule and store snapshots so price/form history can be tracked over time.
- Availability lives on each `element`: `status` (a/d/i/s/u/n), `chance_of_playing_this_round`, `chance_of_playing_next_round`, and a free-text `news` field with a `news_added` timestamp.

### 5.2 Secondary — availability / news (Phase 3)
Supplement the API's flags with predicted-lineup and press-conference data. Keep sources pluggable behind an interface so they can be added/swapped without touching core logic. Respect each source's terms and rate limits.

### 5.3 Dale's own team
Pulled automatically from `entry/{team_id}/...` given Dale's team ID (found in the FPL site URL). No login required for read access to a public entry.

---

## 6. Functional requirements

### FR1 — Data ingestion
- On a schedule (e.g. every few hours, and always shortly before each deadline), pull and store `bootstrap-static`, `fixtures`, and per-player summaries.
- Persist historical snapshots (prices, form, ownership) so trends are queryable.
- Detect and log changes: price rises/falls, new injury news, status changes.

### FR2 — Availability & news tracking
- For every player, maintain a current availability state derived from `status` + `chance_of_playing_*` + `news`.
- Classify into: **Available / Doubtful (25/50/75%) / Injured / Suspended / Unavailable**.
- Flag any player in Dale's squad whose availability has worsened since last check.
- (Phase 3) Enrich with predicted lineups and rotation risk.

### FR3 — Current squad state
- Load Dale's 15 players, bank balance, team value, free transfers available, and chips remaining.
- Reconcile free-transfer count using the roll-over rules (FR4).
- Surface a clear "state of play" view: who's flagged, who's on the bench, upcoming fixtures for each player.

### FR4 — Rules engine (hard constraints)
All optimiser output must satisfy every rule. Rules are config-driven so they can be updated season to season without code changes. Reconcile the defaults in **Section 7** against Dale's uploaded rules file.

### FR5 — Expected-points model
- For each player, compute an **expected points (xPts)** projection for the upcoming gameweek (and, later, the next N gameweeks).
- Inputs: recent form, minutes/rotation likelihood, fixture difficulty (FDR), home/away, underlying attacking + defensive-contribution stats, set-piece/penalty duties, opponent strength, and availability probability.
- Model should be transparent and tunable — start with a weighted heuristic, leave room to swap in a statistical/ML model later.
- Multiply xPts by availability probability (a 50% doubtful player is half-weighted).

### FR6 — Optimisation engine
- **Best XI:** From the current 15, pick the highest-xPts legal starting XI, choosing the best valid formation.
- **Captain / vice:** Highest xPts player as captain (with variance/ceiling as a tiebreak per D4); next best as vice.
- **Bench order:** Rank bench by xPts for auto-sub value.
- Use a proper solver (e.g. linear/integer programming) rather than brute force — squad selection under budget + club + position caps is a classic knapsack/ILP problem.

### FR7 — Transfer planning
- Evaluate the current squad against the whole player pool.
- Recommend the best move for: 0 transfers, 1 transfer, 2 transfers, and "take a −4 hit" scenarios.
- Report the **net xPts gain** of each option (subtracting any hit) so the value of a hit is explicit.
- Respect bank balance and selling-price rules.
- (Phase 2+) Plan transfers across multiple gameweeks to exploit fixture swings and banked transfers.

### FR8 — Chip advice (Phase 2)
- Recommend when to play each chip based on fixture difficulty, doubles/blanks, squad depth, and remaining-half deadlines.
- Enforce chip rules (Section 7): one chip per gameweek, first set expires at the GW19 deadline.

### FR9 — Output / interface
- Present, before each deadline: recommended XI, captain, transfer move(s), bench order, and a plain-English rationale for each.
- Highlight urgent items (a starter just got injured; a price is about to drop).
- Interface per Open Decision D2.

---

## 7. FPL rules to model — 2026/27 defaults

> These are the current official rules for 2026/27. **Dale's uploaded rules file is authoritative** — reconcile any differences (especially anything league-specific) once supplied. Keep all values in a config file.

### Squad
- 15 players: **2 GK, 5 DEF, 5 MID, 3 FWD**.
- Budget: **£100.0m**.
- Max **3 players from any single club**.

### Starting XI & formation
- 11 starters from the 15.
- Exactly **1 GK**; **3–5 DEF**; **2–5 MID**; **1–3 FWD**.
- Captain scores **double**; if the captain doesn't play, the vice-captain's points double instead.
- Bench = 4 players (1 GK + 3 outfield) in priority order for auto-subs.

### Transfers
- **1 free transfer per gameweek.**
- Unused free transfers **roll over, up to a maximum of 5** banked at any time.
- Each transfer **beyond** the free allowance costs **−4 points**.
- Banked free transfers are **kept** when a Wildcard or Free Hit is played.
- Selling price accounts for price changes (profit is split — model the FPL selling-price rule).

### Chips (2026/27 — two sets, one of each per half)
- **Wildcard** — unlimited free transfers for that gameweek (permanent).
- **Free Hit** — unlimited transfers for one gameweek only; squad reverts next GW.
- **Triple Captain** — captain scores triple that gameweek.
- **Bench Boost** — all 15 players score that gameweek.
- One chip per gameweek. **First set must be used before the GW19 deadline (Sat 2 Jan 2027, 13:30 GMT)** or it's lost. Second set unlocks after GW19.
- **No Assistant Manager chip** this season.

### Scoring notables (affect the xPts model)
- **Defensive Contribution (DefCon) points:** a defender scoring **10+** combined clearances, blocks, interceptions & tackles (CBIT) in a match earns **+2**; a midfielder/forward scoring **12+** combined CBIT **+ recoveries** (CBIRT) earns **+2**. This meaningfully re-rates defensive players — weight it in the model.
- **BPS rebalanced for 2026/27** to reduce overlap with DefCon and improve bonus prospects for goalkeepers, full-backs and attackers — factor into bonus-point projection.
- Simplified assist rules; standard appearance/goal/clean-sheet/save points.
- **11 players reclassified** into new positions for 2026/27 — always take positions from the live API, never hardcode.

### Deadlines
- Each gameweek has a deadline (typically 90 mins before the first kickoff). Pull exact deadlines from the API `events` data; never assume.

---

## 8. Suggested data model

Core entities (relational or document store):

- **Player** — id, name, club, position, price, status, chance_of_playing, news, ownership, form, total_points, underlying stats.
- **Club** — id, name, short name, strength (home/away, attack/defence).
- **Fixture** — id, gameweek, home club, away club, kickoff, FDR (home/away).
- **PlayerGameweek** — player_id, gameweek, minutes, points, underlying stats (history + live).
- **PriceSnapshot** — player_id, timestamp, price (for trend tracking).
- **Squad** — the current 15 with buy price, selling price, bench flag, captain flag.
- **ManagerState** — bank, team value, free transfers available, chips remaining, chips used.
- **Projection** — player_id, gameweek, xPts, availability_probability, model_version.

---

## 9. Optimisation approach (the core)

Treat squad/XI selection as a constrained optimisation problem, not a heuristic loop:

- **Objective:** maximise total xPts (captain double, bench weighted low for XI selection; full weight if Bench Boost).
- **Constraints:** budget, 2/5/5/3 squad make-up, max-3-per-club, valid formation, availability.
- **Method:** integer linear programming (e.g. a solver library) — models all constraints exactly and returns a provably optimal legal team. Brute force is infeasible across the full player pool.
- **Transfers:** run the optimiser on "current squad" vs "current squad minus/plus candidate transfers", compare net xPts after any −4 hits.
- **Multi-GW (later):** extend the objective to a discounted sum of xPts over N gameweeks, penalising unnecessary hits and rewarding banked transfers.

---

## 10. Recommended tech stack

Consistent with Dale's other Claude Code builds:

- **Language:** TypeScript (Node.js).
- **HTTP/ingestion:** native fetch or axios; scheduled jobs via node-cron.
- **Storage:** SQLite for MVP (single-user, easy snapshots) → Postgres if it grows.
- **Optimiser:** an ILP/LP solver library (e.g. a JS/WASM linear-programming package), or shell out to a Python solver (PuLP/OR-Tools) via a small service if a stronger solver is wanted.
- **Interface:** lightweight local web dashboard (React) or CLI, per D2.
- **Config:** all rules and model weights in a versioned config file.

---

## 11. Non-functional requirements

- **Reliability:** never recommend an illegal or unavailable player — rules are hard gates, validated before any output.
- **Explainability:** every recommendation carries a reason (xPts, fixtures, availability).
- **Freshness:** always re-pull data immediately before generating a pre-deadline recommendation.
- **Resilience:** handle API outages/rate limits gracefully with cached fallback and clear staleness warnings.
- **Auditability:** log every projection and recommendation with the model version, so past advice can be reviewed against actual results.
- **Politeness:** cache and throttle all external calls; respect source terms.

---

## 12. Build phases

- **Phase 1 (MVP):** FPL API ingestion → storage → load Dale's squad → rules engine → heuristic xPts model → best XI + captain + single-transfer recommender → simple output. — **done**
- **Phase 2:** ILP optimiser, multi-transfer + hit evaluation, chip advice, price-change tracking. — **done**
- **Phase 3:** External news/predicted-lineup enrichment, multi-gameweek planning, mini-league / rival tracking, model tuning against actual results. — **partly done.** Model tuning against actual results is built and automatic (`src/model/calibration.ts`). The other three were considered and deliberately not built; see "What's deliberately not built" in the README for the reasoning on each.

---

## 13. Appendix — quick FPL API reference

- `GET /api/bootstrap-static/` — everything about players, teams, positions, gameweeks.
- `GET /api/fixtures/?event={gw}` — fixtures (and difficulty) for a gameweek.
- `GET /api/element-summary/{player_id}/` — a player's per-match history.
- `GET /api/entry/{team_id}/` — a manager's summary (bank, value, chips).
- `GET /api/entry/{team_id}/event/{gw}/picks/` — a manager's squad that gameweek.
- `GET /api/entry/{team_id}/history/` — season history + chip usage.
- `GET /api/event/{gw}/live/` — live points for all players.
- `GET /api/leagues-classic/{league_id}/standings/` — mini-league standings.

---

**Status of this document.** It is the original specification, kept as the record of what was
asked for. Section 7's rules were reconciled against the real FPL rules file and now live in
`config/rules.json`, which is validated for self-consistency at load. D1-D4 are resolved above.
For what actually got built and what deliberately did not, see the README.
