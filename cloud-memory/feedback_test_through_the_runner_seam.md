---
name: feedback_test_through_the_runner_seam
description: "unit-testing pure rules directly missed a P0 living in the runner's parameter choice (7d window vs cumulative floor) — add fixture/state env seams and lifecycle-test through the REAL runner"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7fc18b1f-6174-4c6a-b243-9b51c71e27b1
---

The gate A/B monitor shipped with 10/10 unit tests and a live dry-run — and still carried a P0 that made its most important alert unfireable: the pure rules compared arm counts against a CUMULATIVE 950 floor, but the runner fed them a 7-DAY query window. Neither test layer could see it: unit tests constructed summaries directly (bypassing the runner's window choice), and live runs were pre-flag (empty arms either way). An adversarial agent review caught it (2026-07-13).

**Why:** the bug class lives in the SEAM — the parameters one component chooses when invoking another. Testing each side in isolation proves both halves "correct" while the composition is broken. My "17/17 checks, as sure as it gets" confidence from one layer (gate mechanics) was silently extended to an untested layer (monitoring).

**How to apply:**
- When a runner/orchestrator picks query windows, thresholds' inputs, file paths, or flags for a pure function: add cheap env-var seams (fixture dir + state-file override, e.g. `GATE_AB_FIXTURE_DIR`/`GATE_AB_STATE_FILE`) and write a lifecycle test that drives the REAL runner across multiple invocations (state evolution, once-only semantics, failure-path behavior). Pattern lives in `scripts/dev/gate-ab-monitor-lifecycle-test.js`.
- Stripping delivery env (RESEND/Discord keys) in that harness ALSO tests the delivery-failure path for free.
- When claiming "fully tested," name the layers: mechanics ≠ monitoring ≠ delivery. A layer with zero executed paths is untested no matter how green its neighbors are.
- For any system meant to run unattended for weeks, an independent adversarial agent review of the SYSTEM (not just the diff) is worth the tokens — it found 1 P0 + 4 P1s here after three other review passes were clean.
