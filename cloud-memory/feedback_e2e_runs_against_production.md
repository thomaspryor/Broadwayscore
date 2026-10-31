---
name: feedback_e2e_runs_against_production
description: "CI reads DEPLOYED/DERIVED state, not your commit: a UI fix stays red until its Vercel deploy lands, and a review-texts data fix stays red until a rebuild round-trips into core-data reviews.json — both produce lag false-negatives that corrupt green-streak counts"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 686a623e-7e63-4612-b05f-6b3885205270
---

The Test Suite "E2E Tests" job runs Playwright with `TEST_BASE_URL=https://broadwayscorecard.com` (set in `.github/workflows/test.yml`). It does NOT build or serve the PR/commit locally — it hits the **deployed production site**.

**Why:** A UI fix you push will leave the E2E job RED until the Vercel deploy of that SHA actually lands on production. Worse, the Test Suite run *triggered by your push* executes E2E within ~1 min, long before the deploy cron (every 5 min, often lagging 10-20 min) ships your fix — so that run is a **guaranteed deploy-lag false-negative**. Re-reading it as "my fix didn't work" is the trap.

**How to apply:**
1. To verify a UI fix locally before/after push, run the spec against a local dev server: `npx next dev -p PORT` then `TEST_BASE_URL=http://localhost:PORT npx playwright test <spec> --project=chromium`. (Worktrees need `ln -s ../../../node_modules` and the gitignored `data/*.json` copied in.)
2. After push: confirm the deploy SHA is live (`git merge-base --is-ancestor <yourSHA> <deploySHA>` on a successful "Deploy to Vercel" run) BEFORE trusting any E2E result.
3. To make CI green-on-record once prod is fixed, re-run the failed Test Suite: `gh run rerun <id> --failed` (it re-tests current production).
4. Don't manual-dispatch "Deploy to Vercel" to rush it — the `gh-poll-block.sh` hook blocks it (cascade risk); the cron picks up main HEAD. `# FORCE-DEPLOY` bypass is for genuinely broken prod only, not a too-tall-row test failure.

Incident 2026-06-03: Tony PressPicks row-height regression (76px>70px from Joshua Henry's 9 critic picks wrapping). Fixed in [[design-system]] component; chased the deploy-lag red Test Suite before realizing E2E hits prod. See [[feedback_local_preview_before_push]].

**Same trap, different subsystem — core-data lag (2026-08-15).** `Data Validation` and `Unit Tests` read `data/reviews.json`, which is DERIVED and lives in the private core-data repo (symlinked to `~/broadway-scorecard-data`), not in the main repo. Fixing the SOURCE (`data/review-texts/**`) does not turn CI green — a rebuild has to round-trip first (~25 min: trigger `Rebuild Reviews Data`, wait, then core-data gets a `data: Update from rebuild-*` commit). Any test.yml run that STARTS before that commit lands still checks out the stale reviews.json and goes red on the already-fixed defect.

Incident: six consecutive push runs (12:58–13:11Z) went red on a duplicate-URL error I had already fixed in review-texts at 13:10; the rebuild landed at 13:21 and the next run was green. Reading those six as "the fix didn't work" or as six real reds is the trap — and it also silently corrupts any "consecutive greens" streak count.

**How to apply:** after fixing anything under `data/review-texts/**` that a CI gate reads out of `reviews.json`, (1) trigger `Rebuild Reviews Data` rather than waiting for the 4 AM UTC cron, (2) confirm a new core-data commit exists (`git -C ~/broadway-scorecard-data log -1 -- reviews.json`), and only THEN (3) count the streak from a run whose `createdAt` is after that commit. Note `validate-data.js` failing also reddens `Unit Tests`, because `tests/unit/validate-data-push-refusal-sentinel.test.mjs` shells out to it and asserts exit 0 — one data defect, two red jobs, and the unit-test name points nowhere near the cause.
