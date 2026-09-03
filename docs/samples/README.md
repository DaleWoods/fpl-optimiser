# Sample API payloads

Two real responses saved from the FPL API while the file-import feature was being built.

| File | Endpoint |
|---|---|
| `bootstrap-static.sample.json` | `/api/bootstrap-static/` |
| `fixtures.sample.json` | `/api/fixtures/` |

**Nothing in the codebase reads these.** The test suite builds every input in code (see
`test/support/fakeApi.ts`), deliberately, so there is no recording that can silently go stale.
These are kept only as a convenient hand-import target:

```bash
npm run fpl -- import docs/samples/bootstrap-static.sample.json docs/samples/fixtures.sample.json
```

They are a snapshot of one moment in one season. Do not treat the prices, statuses or fixture
dates in them as current, and do not use them to seed a database you intend to take advice from.
