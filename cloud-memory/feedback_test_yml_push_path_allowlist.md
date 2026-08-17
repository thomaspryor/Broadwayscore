---
name: test-yml-push-path-allowlist
description: test.yml push trigger is an explicit path allow-list; non-listed scripts/ pushes run ZERO CI
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 04a9879e-3edc-4fbb-bc49-fcfb1c1cb1a3
  modified: 2026-08-17T15:19:35.619Z
---

`.github/workflows/test.yml`'s `on: push` uses an explicit `paths:` allow-list (src/**, tests/**, and a hand-maintained set of specific scripts + data globs). A push to main that touches only files NOT on that list triggers **no Test Suite run at all** — not a skip, not a pass, just nothing. This is separate from [[feedback_ci_step_short_circuits_colocated_tests]] (that one is about a red earlier step skipping the later `scripts/lib/*.test.mjs` step *within* a triggered run).

**UPDATE (task #1745, 2026-08-17):** `scripts/lib/**` is now a single glob in the allow-list (replaced ~200 individually-listed `scripts/lib/*.js`/`*.test.mjs` entries that had drifted — 55 test files silently missing, recurred 3+ times). Any push touching a file *inside* `scripts/lib/` now always triggers CI — the old failure mode below no longer applies there. It still applies to everything else not covered by a glob: top-level `scripts/*.js`, root configs (`vercel.json`), etc. `scripts/audit-test-yml-lib-deps.js` (advisory, wired into `lint-workflows`) catches the one residual shape: a `scripts/lib` test requiring a file *outside* `scripts/lib/` with no path entry of its own.

**Separately, a same-day Notion card correction claimed a SECOND gap — that `scripts/lib/*.test.mjs` files never execute at all (only `tests/unit-test-manifest.txt`-listed files run) — and this was FALSE.** `test.yml`'s `unit-tests` job has two independent steps: "Run unit tests (no-data-dependency)" (manifest-driven, for `tests/unit/` + top-level `scripts/*.test.mjs`) and a separate "Run scripts/lib tests" step that does an unconditional `tests=(scripts/lib/*.test.mjs); node --test ... "${tests[@]}"` glob. Confirmed via a live CI run's log that a specific file the correction claimed "never ran" actually ran and passed. Don't trust a claim like this from a card/note without grepping the actual CI log for the specific step name + test output — job-body line numbers alone aren't proof of which step (or whether either step) executes a given file.

**Why:** 2026-05-30 — shipped a new `scripts/lib/email-utm.js` + colocated test wired into email generators. Pushed to main; `gh run list` showed zero runs for the sha. Wasted cycles assuming CI was lagging before realizing the changed paths matched nothing in the allow-list, so the colocated test would never run on email-only pushes.

**How to apply:**
- After pushing a scripts-only change, if no Test Suite run appears for your sha within ~1 min, check `test.yml`'s `on.push.paths` — your files probably aren't listed. `scripts/lib/**` files are now always covered; top-level `scripts/*.js` and root configs still need explicit listing.
- `.github/workflows/**` IS in the allow-list, so editing test.yml itself triggers a run — handy to force a verifying run after adding paths.
- To verify a new colocated `scripts/lib` test actually executed in CI, check the "Unit Tests" job's "Run scripts/lib tests" step log for the specific test's `ok N - <test name>` line — don't just check the step's overall conclusion.
