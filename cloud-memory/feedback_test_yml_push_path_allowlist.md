---
name: test-yml-push-path-allowlist
description: test.yml push trigger is an explicit path allow-list; non-listed scripts/ pushes run ZERO CI
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 04a9879e-3edc-4fbb-bc49-fcfb1c1cb1a3
---

`.github/workflows/test.yml`'s `on: push` uses an explicit `paths:` allow-list (src/**, tests/**, and a hand-maintained set of specific scripts + data globs). A push to main that touches only `scripts/` files NOT on that list triggers **no Test Suite run at all** — not a skip, not a pass, just nothing. This is separate from [[feedback_ci_step_short_circuits_colocated_tests]] (that one is about a red earlier step skipping the later `scripts/lib/*.test.mjs` step *within* a triggered run).

**Why:** 2026-05-30 — shipped a new `scripts/lib/email-utm.js` + colocated test wired into email generators. Pushed to main; `gh run list` showed zero runs for the sha. Wasted cycles assuming CI was lagging before realizing the changed paths matched nothing in the allow-list, so the colocated test would never run on email-only pushes.

**How to apply:**
- After pushing a scripts-only change, if no Test Suite run appears for your sha within ~1 min, check `test.yml`'s `on.push.paths` — your files probably aren't listed.
- When adding a new `scripts/lib/*.test.mjs` (or any script you want gated), ADD its source path(s) to `test.yml`'s push `paths` list, or the test only runs when some *other* listed path changes.
- `.github/workflows/**` IS in the allow-list, so editing test.yml itself triggers a run — handy to force a verifying run after adding paths.
- To verify a new colocated test actually executed in CI, check the "Unit Tests" job's "Run scripts/lib tests" step = success (the glob `scripts/lib/*.test.mjs` auto-includes new files).
