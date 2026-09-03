> **Executed.** Delivered in `894265b` — "Run the existing checks before a push reaches production".
>
> Kept for the reasoning, not as outstanding work. Anything below written in the
> present tense ("currently", "today", "does not exist yet") describes the codebase
> *before* that commit. Executed as written. The first run on GitHub passed all four steps. The Render "wait for CI before deploying" setting remains a manual follow-up, as the plan notes.

# PLAN 4 — Stop broken code reaching production

**Rank: 4 of 5.**
**Size: small (one workflow file, ~40 lines). Under an hour.**
**Type: insurance on a live deploy path.**

---

## Goal

`render.yaml` has `autoDeploy: true` on `branch: main`. There is no `.github/` directory, no CI,
and no linter. Every push to `main` goes straight to the running app with nothing checked first.

The 489-test suite and the typechecker already exist and already catch this class of problem —
they are just not wired to the one moment they would matter. Add a GitHub Actions workflow that
runs them on every push and pull request.

### Why this ranks above further model work

You use this app against a deadline. A push that fails to compile takes the site down at exactly
the moment it is least recoverable, and Render's build failure is discovered by visiting the
site, not by being told. This is the cheapest item on the list by a wide margin and the only one
that protects all the others.

---

## Files to touch

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | **New.** |
| `README.md` | One line under "Requirements" |
| `package.json` | Add a `ci` script (optional but do it) |

Nothing in `src/`. This plan changes no application behaviour whatsoever.

---

## Step-by-step

### Step 1 — The workflow

Create `.github/workflows/ci.yml`:

```yaml
# Runs the checks that already exist, at the one moment they matter: before a push to main
# reaches Render, which auto-deploys it. The suite is fast (a few seconds) and has no external
# dependencies - no FPL API call, no network, no database beyond an in-memory SQLite - so this
# is cheap to run on every push and there is no reason to run a subset.
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: npm

      # ci, not install: the lockfile is the source of truth, and a build that quietly resolves
      # a different dependency tree than the one that was tested is not the same build.
      - run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Tests
        run: npm test

      # The deployed artefact is what Render builds, so building it here is part of checking
      # the push is safe - tsconfig.build.json is a different config from the one tsc --noEmit
      # uses, and has broken independently before.
      - name: Build
        run: npm run build
```

The repo has a `.node-version` file — confirm its contents (`cat .node-version`) and that
`node-version-file` picks it up. If the file is missing or empty, replace that line with
`node-version: '22'` to match `render.yaml`'s `NODE_VERSION`.

### Step 2 — Verify the scripts exist

`package.json` already has `typecheck`, `test` and `build`. Confirm all three by running them
locally before pushing. Optionally add:

```json
"ci": "npm run typecheck && npm test && npm run build"
```

so the same three checks can be run in one command locally.

### Step 3 — Note it in the README

Under `## Requirements`, after the existing `npm install` / `npm test` block:

```markdown
Pushes to `main` run the typecheck, the test suite and a production build in GitHub Actions
before Render deploys them. `npm run ci` runs the same three checks locally.
```

---

## Edge cases a weaker model will get wrong

1. **Do not add a linter in this change.** There is no linter configured, so adding one means
   choosing a config and then fixing every violation across 12,000 lines — which buries the
   actual point of this change in a thousand-line diff and makes the first CI run red. If you
   want a linter, that is a separate piece of work.

2. **Do not make CI a required status check that blocks Render.** Render's `autoDeploy` watches
   the branch, not the check. Wiring them together needs a Render setting change, not a repo
   change, and is outside what this plan can verify. The value here is *knowing* a push is
   broken, quickly, with an email. If you want deploy-blocking, turn on "Wait for CI to pass
   before deploying" in the Render dashboard — mention it in the commit message as a follow-up
   for a human, do not attempt it in code.

3. **Do not add caching beyond `cache: npm`.** `actions/setup-node`'s built-in npm cache is
   enough for a suite this size. A hand-rolled `actions/cache` step is another thing to get
   subtly wrong for no measurable gain.

4. **Do not add a matrix across Node versions.** The app runs on exactly one Node version in
   production. Testing versions you do not deploy adds failures you will not act on.

5. **The first run may fail on something unrelated** — a `.node-version` mismatch, or `npm ci`
   objecting to a lockfile that drifted. That is the workflow doing its job. Fix the real cause;
   do not weaken the workflow (adding `continue-on-error` or `|| true` to get a green tick makes
   the whole thing decorative).

6. **`npm test` must not need network access.** Confirm before pushing: `npx vitest run` with no
   network should already pass, because the suite uses `StubFplApi` throughout. If any test
   reaches the real FPL API, that test is the bug — find it and stub it, rather than giving CI
   network permissions.

---

## Acceptance criteria

- [ ] `npm run typecheck && npm test && npm run build` all pass locally, in that order.
- [ ] `.github/workflows/ci.yml` exists and is valid YAML (`python3 -c "import yaml,sys;
      yaml.safe_load(open('.github/workflows/ci.yml'))"`).
- [ ] After pushing, the Actions tab shows a green run for the commit.
- [ ] Deliberately break something trivially (e.g. add `const x: number = 'a';` to a source
      file), push to a throwaway branch, and confirm the workflow goes red on the typecheck
      step. Delete the branch afterwards. **Do this** — an untested safety net is not a safety
      net.
- [ ] README mentions the CI gate.
- [ ] No file under `src/`, `config/` or `test/` was modified by this change.
      `git diff --stat` should show only the workflow, README and possibly `package.json`.
