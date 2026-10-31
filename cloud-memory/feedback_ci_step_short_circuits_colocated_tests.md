---
name: ci-step-short-circuits-colocated-tests
description: A failing earlier step in a CI job skips later steps — a new scripts/lib/*.test.mjs gives ZERO CI coverage while the tests/unit batch is red
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a1d2358c-0e25-4350-a2d3-1fbdda8a1a56
---

A new colocated `scripts/lib/*.test.mjs` test can pass locally yet provide **zero CI protection**, because in `test.yml` the "Unit Tests" job runs the big `tests/unit/*` batch FIRST (step at ~line 743) and the `scripts/lib/*.test.mjs` glob LATER (step at ~line 766). GitHub Actions skips later steps once an earlier step fails (no `if: always()`), so if the `tests/unit` batch is red, the colocated glob step never executes.

**Why:** Discovered 2026-05-28 shipping the aggregator-candidate bridge. My new `scripts/lib/aggregator-candidate-extract.test.mjs` (13 tests) never ran in CI — the Unit Tests job died on pre-existing failures (`cast-changes-real-data` 171/172 data drift + St. Ann's `venue-listing-discover` orphan band). The colocated step was simply skipped. So a green local run + a "registered" test ≠ CI coverage.

**How to apply:**
- When main's Unit Tests job is already red, a new colocated lib test buys you nothing in CI until the earlier failures are fixed. Don't treat "I added a test" as "CI now guards this."
- Verify a new test actually RAN in CI: `gh run view <id> --log --job <Unit Tests id> | grep <your-test-name>`. Zero matches = it was skipped, not passed.
- The same short-circuit hides *cascading* lint failures: clearing one Lint-Workflows failure (e.g. an orphan-test registration) can unmask a second, previously-skipped guard (e.g. the `safeWriteReview` heuristic). Expect to re-check after each fix. See also [[silent-workflow-failures]].
- Structural fix (future): give independent test-suite steps `if: always()` (or split into separate jobs) so one red batch doesn't mask the rest. Tracked alongside the "main CI broadly red" card.
