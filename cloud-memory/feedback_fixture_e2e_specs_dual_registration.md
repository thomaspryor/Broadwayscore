---
name: feedback_fixture_e2e_specs_dual_registration
description: "New /test/* fixture E2E specs must be added to BOTH playwright.config.ts testIgnore AND test-ugc.yml's run list — else main CI runs them against production where TestGuard redirects"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 01818bd9-0b9c-4e6d-a366-7b1512af86c3
---

**What happened:** `tests/e2e/rating-editor.spec.ts` (added 2026-07-05) hit `/test/rating-editor-fixture`, which `TestGuard` client-redirects to `/` on production (fixtures are demo-flag-gated: `featureFlags.userAccounts` is true only on demo.broadwayscorecard.com). Main CI runs E2E with `TEST_BASE_URL=https://broadwayscorecard.com`, so all 16 tests timed out waiting for the fixture testid — main red for 3 days (07-06→07-09), 28 failed Test Suite runs. The spec was in `test-ugc.yml`'s local-server run but missing from `playwright.config.ts` `testIgnore`.

**Why:** The exclusion list and the UGC-workflow run list are maintained by hand in two places. A spec added to one but not the other either loses coverage (in run list only → fine, but nothing enforces) or reds main (missing from testIgnore).

**How to apply:** Any new spec that navigates to `/test/*` fixture pages or needs `RUN_UGC_TESTS=1`:
1. Add a glob to `testIgnore` in `playwright.config.ts` (the `RUN_UGC_TESTS` ternary).
2. Add the file to the `Run UGC tests` step in `.github/workflows/test-ugc.yml` (local `next start -p 3456` with all flags enabled).
3. Debug tip: a fixture-page timeout in CI where the page 200s via curl → load it in a real browser; if the URL lands on `/`, it's the TestGuard redirect, not a rendering bug. Server HTML has no testids for these pages (useSearchParams bails to client render) — that alone is not a failure signal.

Note: `ugc-interactive-qa.spec.ts` is testIgnored but NOT in test-ugc.yml's run list — it currently runs nowhere in CI (pre-existing gap, uses `/my-shows?mock=1` so it could run against prod or local).

Related: [[feedback_e2e_runs_against_production]], [[feedback_demo_flags_client_only]], [[feedback_flag_gated_verify_on_demo]]
