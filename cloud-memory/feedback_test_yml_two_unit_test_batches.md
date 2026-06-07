---
name: test-yml-two-unit-test-batches
description: "test.yml runs unit tests in TWO separate batches/jobs (no-data node --test vs E2E-job npx tsx --test); a poller/orchestrator topology guard lives only in the tsx batch, so the local no-data suite gives false green"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d48b8eb6-ac15-4c5a-bfe5-bca052a243ca
---

`test.yml` runs unit tests in (at least) TWO independent invocations, in DIFFERENT jobs:
1. **"Unit Tests" job** — `node --test tests/unit/<long explicit list>` (the "no-data-dependency" suite, ~line 766) + a later colocated `scripts/lib/*.test.mjs` glob step.
2. **"E2E Tests" job** — a separate `npx tsx --test tests/unit/<different explicit list>` step (~line 1263) that runs BEFORE the browser E2E step; if it fails, the actual E2E step is skipped.

The two lists are DISJOINT. Structural/topology guards for the opening-night pipeline (e.g. `tests/unit/serp-defer-iterations.test.mjs`, which greps `opening-night-poller.js` / `opening-night-orchestrator.yml` for the SERP gate) live in the **tsx batch only** — they are NOT in the no-data `node --test` list. So you can run the whole no-data suite locally, see green, push, and still get a CI failure surfaced as "E2E Tests: failure" whose real cause is a unit test in that job's pre-E2E step.

**Why:** 2026-06-04, shipping the flag-gated WE SERP burst. I changed the poller SERP gate from `if (!SKIP_SERP && shouldRunSerp())` to `((...) || serpBurstActive)`. The no-data suite I ran locally passed, but `serp-defer-iterations.test.mjs` (a literal-regex topology guard, in the tsx batch) failed in CI — reported under the **E2E Tests** job as `not ok 186 - Hop 4: ... gates runSERPBackup behind !SKIP_SERP`, with the browser E2E step then skipped. Cost a full CI round-trip + re-merge.

**How to apply:**
- Before pushing ANY change to `scripts/opening-night-poller.js`, `opening-night-orchestrator.yml`, or `opening-night-poller.yml`, also run the guard: `node --test tests/unit/serp-defer-iterations.test.mjs`. It pins the SERP-deferral cross-file wiring with literal regexes — change the gate and it (correctly) fails.
- More generally: don't trust the no-data `node --test` list as "all the unit tests." Grep ALL of `tests/` for the symbol you changed (`grep -rl <symbol> tests/`) and run every match, regardless of which CI step/job runs it.
- An "E2E Tests: failure" on a backend/scripts change is often NOT a browser failure — check the job's steps: a failed `Run unit tests` step (step 8) skips `Run E2E tests` (step 9). `gh run view <id> --json jobs --jq '.jobs[]|select(.name=="E2E Tests").steps[]|select(.conclusion=="failure")'`.
- When a literal-regex topology guard catches an intentional change, UPDATE the guard to the new invariant (don't loosen it) — here I kept the `!SKIP_SERP && shouldRunSerp()` requirement and added a Hop 4b asserting the only override is flag-gated + cap-checked. See [[ci-step-short-circuits-colocated-tests]] and [[must-match-comment-is-a-bug]].
