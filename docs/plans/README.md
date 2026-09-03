# Executed plans

Implementation plans written before the work, kept afterwards because the *reasoning* in them is
worth more than the diff. Each was written to be executable without further questions: exact
files, step order, the edge cases that would be easy to miss, and acceptance criteria.

**None of these is outstanding work.** Every one has been delivered — each file opens with the
commit that did it. Where a plan describes something in the present tense ("this is currently
broken"), it is describing the codebase *before* that commit.

| Plan | Delivered in | What it was |
|---|---|---|
| [1 — Anchor sample size](PLAN-1-anchor-sample-size.md) | `0c58c3a` | A live correctness bug: the last-season anchor was taken at face value however few minutes produced it |
| [2 — Calibration loop](PLAN-2-calibration-loop.md) | `62f2e39` | The accuracy tables measured error per position and nothing read it |
| [3 — my-team import](PLAN-3-my-team-import.md) | `2df6f5f` | `selling_price` was a column written NULL and read by nothing |
| [4 — CI gate](PLAN-4-ci-gate.md) | `894265b` | `autoDeploy: true` on `main` with no checks in front of it |
| [5 — Captain ceiling](PLAN-5-captain-ceiling.md) | `e95f23d` | Captaincy and Triple Captain decided on a mean |

## Two things worth reading them for

**Where the reasoning was wrong, and how it was caught.** Plan 5's mean-reconciliation test
existed to catch exactly one class of error and caught it on the first run. Plan 1's own test was
wrong and had to be rewritten. Plan 2's stated failure mode was corrected during drafting — the
naive calibration loop reverts rather than diverging, which is a subtler bug and needs a
different fix.

**What "written for an executor" means here.** Each plan names the exact function, warns where
the obvious edit would be in the wrong place (Plan 5: the captain is chosen in the ILP objective,
not in `buildEleven` — editing the latter looks like it did nothing), and states which test must
fail before the change as proof it tests the change at all.
