---
name: feedback_ci_red_stale_state_and_brittle_assertions
description: "CI goes red forever when a validation gate checks persistent state that nothing proactively heals, and when E2E tests hardcode config-driven dates/thresholds"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8d8415be-a89d-4469-aef3-64c7b7ace03e
---

When main's Test Suite "goes red every couple hours," look for two classes before anything else (2026-05-30 investigation: 9 failure / 15 cancelled of last 25 runs):

1. **A CI gate validating PERSISTENT state with no proactive heal.** `audit-duplicate-of-url-mismatch.js` (Data Validation) failed on 2 dormant stale `duplicateOf` flags. The `review-write-guard` self-heal *exists* but only fires when a file is rewritten — a flag on a never-re-gathered show (closed / quiet West End) sits forever and fails EVERY triggered run. Fix: clear the current offenders in the private repo, AND add the audit's `--fix` as a periodic sweep in `rebuild-reviews.yml`'s pre-rebuild cleanup cluster (alongside cleanup-phantom-outlets etc.) so dormant flags clear daily and ship via push-review-texts. Don't weaken the gate — heal the input.

2. **E2E assertions coupled to config-driven values.** `homepage.spec.ts` asserted `> 10` show cards but the homepage curates exactly 10 → flapped red the moment it landed on 10 (use `>= 10`, match the comment's intent). `beat-the-critics.spec.ts` hardcoded "June 7" but the reveal badge is driven by `PICKS_REVEAL_DATE`, which moved to June 8 → 0 matches. Match the stable prefix (`/^Revealed /`), not the date.

**Why:** these fail on every run, not intermittently, so they read as "CI is broken" and erode trust in the signal. The dormant-state class is the sneaky one: a gate that's correct but whose input is never refreshed.

**How to apply:** When triaging recurring CI red, run `gh run list --workflow="Test Suite" --branch main --limit 25` and classify failure-vs-cancelled first. `cancelled` (concurrency `cancel-in-progress` + bursty pushes) is NOT failure — don't chase it. For genuine `failure`, pull `--log-failed`, find the failing STEP, and ask "does anything proactively fix this state, or only a write-time guard that dormant rows never hit?" If only write-time, add a scheduled/rebuild sweep. For E2E, grep the assertion for hardcoded dates/counts and derive from source or use stable selectors. Related: [[feedback_duplicate_of_url_mismatch]], [[feedback_ci_failure_preexisting_baseline]], [[feedback_ci_step_short_circuits_colocated_tests]].
