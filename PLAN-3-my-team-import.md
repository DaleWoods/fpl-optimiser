# PLAN 3 — Real selling prices and the true free-transfer count

**Rank: 3 of 5.**
**Size: medium (new payload kind + import slot + wiring, ~250 lines, ~10 tests).**
**Type: correctness gap that makes transfer advice unactionable.**

---

## Goal

Two numbers the app currently guesses, both of which change what it tells you to do:

1. **Selling price.** The `squad_pick` table has `purchase_price`, `selling_price` and
   `price_source` columns. Grep the source: they are **written as NULL and read by nothing**.
   Every transfer affordability decision uses the player's *current* price as a proxy. FPL's
   real rule is that you sell for purchase price plus half the rise, rounded down to 0.1m — so
   for any player who has risen, the app believes you have more money than you do, and can
   recommend a transfer you cannot actually make.

2. **Free transfers.** Currently derived from transfer history under the rollover rules and
   marked `'derived'`. The derivation is careful and usually right, but it is inference, and it
   drives the hit arithmetic on both the transfer cards and the priority-fix plan.

Both are available, exactly and authoritatively, from `GET /api/my-team/{entryId}/` — which
requires being logged in. This app already has the pattern for exactly that situation: the
Import Data tab, where you save a JSON page from your logged-in browser and upload it.

**Add `my-team` as a fifth import slot.** No authentication code, no stored credentials, no new
failure mode in the automatic refresh.

---

## What the endpoint returns

```json
{
  "picks": [
    { "element": 351, "position": 1, "selling_price": 55, "purchase_price": 55,
      "multiplier": 1, "is_captain": false, "is_vice_captain": false }
  ],
  "chips": [ { "status_for_entry": "available", "name": "wildcard", "number": 1 } ],
  "transfers": { "cost": 4, "status": "cost", "limit": 1, "made": 0, "bank": 5, "value": 1002 }
}
```

Prices are in tenths of a million, same as everywhere else in this app. `transfers.limit` is the
authoritative free-transfer count. `transfers.bank` is the authoritative bank.

---

## Files to touch

| File | Change |
|---|---|
| `src/api/schemas.ts` | Add `ApiMyTeam` zod schema |
| `src/ingest/import.ts` | Add `'my-team'` to `PayloadKind`, detection, `KIND_LABELS`, handler |
| `src/report/importSlots.ts` | Add the fifth slot |
| `src/report/recommend.ts` | Load and use selling prices in `loadOwnedSquad` and `findTransfers` |
| `src/report/views.ts` | Show price source on My Team |
| `test/unit/import.test.ts` | Detection and ingestion tests |
| `test/unit/recommend.test.ts` | Affordability tests |
| `README.md` | Update the "What the public API cannot tell us" section |

---

## Step-by-step

### Step 1 — Schema

In `src/api/schemas.ts`, next to the existing `ApiPicks` schema, add:

```ts
/**
 * The authenticated my-team endpoint. Not reachable by the automatic refresh - it needs the
 * session cookie of a logged-in browser - so this arrives only by hand, through the import
 * screen, the same way every other file this app cannot fetch for itself does.
 *
 * It is the only source of two numbers the app otherwise has to infer: what each player would
 * actually sell for, and how many free transfers you really have.
 */
export const apiMyTeamSchema = z.object({
  picks: z.array(z.object({
    element: z.number().int(),
    position: z.number().int(),
    selling_price: z.number().int(),
    purchase_price: z.number().int(),
    multiplier: z.number().int(),
    is_captain: z.boolean(),
    is_vice_captain: z.boolean(),
  })),
  chips: z.array(z.object({
    name: z.string(),
    status_for_entry: z.string(),
  })).optional(),
  transfers: z.object({
    limit: z.number().int().nullable(),
    made: z.number().int(),
    bank: z.number().int(),
    value: z.number().int(),
  }),
});
```

Match the existing style in that file exactly — check whether other schemas use `.passthrough()`
or `.strip()`, and whether they are declared with `z.object` directly or via a helper. Copy what
is already there. **Use `.passthrough()` if the other API schemas do**, because the FPL API adds
fields without warning and a strict schema on live data is a time bomb.

### Step 2 — Detection

In `src/ingest/import.ts`:

- Add `| 'my-team'` to the `PayloadKind` union.
- Add to `KIND_LABELS`: `'my-team': 'your squad with real selling prices (my-team)'`.
- In `detectPayloadKind`, add a branch. **Order matters** — read the existing branches first.
  `my-team` and `picks` both have a `picks` array, so `my-team` must be tested *before* `picks`,
  and must be identified by something `picks` does not have:

  ```ts
  // my-team before picks: both carry a `picks` array, but only my-team's entries carry
  // selling_price, and only my-team has a `transfers` object. Testing picks first would
  // swallow every my-team upload and silently discard the prices that are the whole point.
  if (Array.isArray(parsed.picks) && parsed.picks[0]?.selling_price !== undefined) {
    return 'my-team';
  }
  ```

### Step 3 — Handler

In `importPayload`, add a `case 'my-team'`. Read the existing `case 'picks'` handler (around
line 380) and follow its shape: it inserts a `manager_state` row then `squad_pick` rows.

Differences for `my-team`:

- Requires `options.teamId`. If absent, return an `ImportSummary` with a warning saying the team
  ID must be set first and write nothing — do not throw. Match how the `picks` handler behaves
  when `teamId` is missing.
- Write `purchase_price`, `selling_price` and `price_source = 'api'` on every `squad_pick` row.
- Write `free_transfers = transfers.limit` and `free_transfers_source = 'api'` on the
  `manager_state` row. If `transfers.limit` is null, fall back to the derived value and keep
  `'derived'`.
- Write `bank = transfers.bank` and `team_value = transfers.value`.
- `my-team` has no `event` field. Use the current event: query
  `SELECT id FROM event WHERE is_current = 1` and fall back to the latest `manager_state.event_id`
  for this entry. Check the exact column name for `is_current` in `0001_init.sql` before writing
  the query.

`free_transfers_source` is currently typed as `'derived' | 'manual' | 'unknown'` in
`EntryIngestResult` in `src/ingest/entry.ts`. Add `'api'` to that union and to any other place
the type appears (grep `free_transfers_source`).

### Step 4 — Import slot

In `src/report/importSlots.ts`, add a fifth `SlotDefinition` after `my-squad`:

```ts
{
  id: 'my-team-prices',
  title: 'Your real selling prices and free transfers',
  cadence: 'When you make transfers',
  cadenceTone: 'occasional',
  what:
    'Two numbers the public API does not publish, and which this app otherwise has to infer: ' +
    'what each of your players would actually sell for, and how many free transfers you really ' +
    'have. FPL sells a player for what you paid plus half of any rise, so for anyone who has ' +
    'gone up in price the current price overstates what selling them frees up - which is how a ' +
    'suggested transfer turns out to be one you cannot afford. You must be logged in to ' +
    'fantasy.premierleague.com in the same browser for this link to return anything.',
  source: `${FPL}/my-team/<your team id>/`,
  sourceLabel: 'my-team',
  accepts: ['my-team'],
  acceptAttr: '.json',
  runSources: ['import:my-team'],
},
```

Check how the other slots' `source` values are built — if the team ID is interpolated elsewhere
(the `my-squad` slot must do something similar for its picks URL), copy that mechanism rather
than leaving a literal `<your team id>` placeholder.

### Step 5 — Actually use the prices

This is the part that changes recommendations, and the part most likely to be skipped.

**`loadOwnedSquad`** in `src/report/recommend.ts` (line ~510) currently selects only
`player_id`. Change the query to:

```sql
SELECT player_id AS playerId, selling_price AS sellingPrice, price_source AS priceSource
FROM squad_pick WHERE manager_state_id = ? ORDER BY slot
```

Return a `sellingPrices: Map<number, number>` alongside `squad`, containing only entries where
`sellingPrice` is non-null. Also return `priceSource: 'api' | 'unknown'` — `'api'` only when
**every** pick has a selling price, because a partially-known squad cannot be reasoned about
consistently.

**`findTransfers`** (line ~583) takes `options.bank`. It computes:

```ts
const budgetForReplacement = options.bank + out.price;
```

Change to take a `sellingPrice: (player: ProjectedPlayer) => number` in `options` and use:

```ts
const budgetForReplacement = options.bank + options.sellingPrice(out);
```

The caller passes a function that returns the real selling price when known and falls back to
`player.price` when not.

**`buildPriorityFixPlan`** (added in a previous change, same file) has the identical pattern:
`const budget = bank + out.price;` and later `bank = bank + out.price - chosen.price;`. Both must
use the selling price for the outgoing player. **The incoming player is always bought at current
price** — do not apply selling price to `chosen.price`. Getting this backwards inverts the whole
correction.

**Note on `totalCost`:** squad cost for display is computed from current prices and should stay
that way — that is your team value. Only *transfer affordability* uses selling price.

### Step 6 — Say which it used

In `renderRecommendation` in `src/report/views.ts`, the note
`'Selling prices are not published by the FPL API, so transfer affordability uses current price
as a proxy...'` is pushed unconditionally in `recommend()`. Make it conditional:

- `priceSource === 'api'` → push a note saying real selling prices are in use, and when they
  were imported.
- otherwise → keep the existing note, and add a pointer to the new import slot.

---

## Edge cases a weaker model will get wrong

1. **Selling price applies to the player leaving, purchase price to the player arriving.**
   Stated again because it is the single easiest thing to invert, and inverting it makes the
   advice worse than the proxy it replaced.

2. **Detection order.** `my-team` must be matched before `picks` in `detectPayloadKind`. Add a
   test that a real `my-team` payload does not detect as `picks`.

3. **A stale `my-team` import must not override a fresher automatic refresh.** `loadOwnedSquad`
   picks the latest `manager_state` row that has picks. If the user imports `my-team` and then
   the background refresh runs, the newer row will have no selling prices and the correction
   silently stops applying. Handle this: when the latest state has no selling prices, look back
   for the most recent state for this entry that *does*, and reuse those prices for any player
   still in the squad. Prices only change when you transfer, so this is sound. Any player not
   found in that older state falls back to current price. **Write a test for this** — it is the
   difference between the feature working once and working continuously.

4. **`transfers.limit` can be null**, and can exceed the rollover cap during a wildcard. Do not
   validate it against your own derivation and do not "correct" it. If it is present, it is
   authoritative; if it is null, fall back to derived.

5. **Chips in `my-team` use `status_for_entry`, not the `event`-stamped shape** that
   `entry-history` uses. Do not try to merge the two chip formats. Ignore `my-team`'s chips
   entirely for this plan — `entry-history` already handles chips correctly.

6. **Do not add `my-team` to `ingestAll` or the API client.** It cannot be fetched without a
   session cookie. Adding it to the automatic refresh gives every scheduled ingest a guaranteed
   401 and puts a permanent error on the dashboard. This is import-only. Do not create an
   `api.myTeam()` method.

7. **Do not log or store the file's raw contents beyond the columns named here.** It is
   associated with a logged-in session.

8. **Money is integer tenths everywhere.** `selling_price: 55` is £5.5m. No float conversion.

---

## Tests

**`test/unit/import.test.ts`:**
1. `'detects a my-team payload, and does not mistake it for a picks file'`
2. `'records the real selling price for every pick'` — assert `price_source = 'api'` and exact
   `selling_price` values.
3. `'takes the free transfer count from the API rather than deriving it'` — assert
   `free_transfers_source = 'api'` and the value from `transfers.limit`.
4. `'falls back to the derived free transfer count when the API does not state one'` —
   `limit: null`.
5. `'refuses to import without a team ID, and says so'` — no rows written, warning returned.

**`test/unit/recommend.test.ts`:**
6. `'will not suggest a transfer that the real selling price cannot fund'` — construct a squad
   where a player's current price affords a target but his selling price does not. Assert that
   target does not appear in `result.transfers`. Then set the selling price equal to current
   price and assert it does appear. Two halves, one test — the second half proves the first is
   testing the price and not something else.
7. `'buys at current price and sells at selling price, never the reverse'` — a squad where
   selling prices are *above* current prices (possible if a player fell after purchase; FPL
   never sells above purchase, but the code must not assume). Assert the budget arithmetic uses
   selling for out and current for in.
8. `'keeps using imported selling prices after a later refresh that has none'` — edge case 3.
9. `'reports which price basis it used'` — assert the notes contain the real-prices note when
   available and the proxy note when not.

Build a `fakeMyTeam()` helper in `test/support/fakeApi.ts` alongside `fakePicks()`, matching its
signature style.

---

## Acceptance criteria

- [ ] `npx tsc --noEmit` clean; `npx vitest run` all pass with 9 new tests.
- [ ] `grep -rn "selling_price" src/report/` returns real usage, not just comments.
- [ ] Importing a `my-team` file on the Import Data tab shows the slot as filled, with a
      timestamp.
- [ ] Before the import, My Team notes say affordability uses current price as a proxy. After,
      they say real selling prices are in use. Screenshot both.
- [ ] Test 6 fails if you revert only the `findTransfers` budget line. Verify this.
- [ ] Test 8 passes — run it, do not assume.
- [ ] README's "What the public API cannot tell us" section updated: both items now have a
      documented route, with the caveat that it is manual and needs a logged-in browser.
- [ ] No new network call anywhere. `grep -rn "my-team" src/api/` returns only the schema.
