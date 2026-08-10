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
| 3 | FPL API client (throttled, cached) + ingestion | in progress |
| 4 | Availability classification and selling-price rules | todo |
| 5 | Rules engine (hard constraints) | todo |
| 6 | Expected-points model | todo |
| 7 | ILP optimiser: best XI, captain, bench order | todo |
| 8 | Single-transfer recommender | todo |
| 9 | CLI report | todo |

## Requirements

Node.js 22 or newer. No other runtime dependencies — SQLite and the LP solver are both
bundled as npm packages.

```bash
npm install
npm test
```

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
