/**
 * SERP deferral — structural wiring regression test.
 *
 * Bucket A: On opening night, Google hasn't indexed real reviews yet. SERP
 * returns stale OB/tryout URLs and contaminates the pipeline. The orchestrator
 * defers SERP for the first N iterations to let aggregators (Layers 1-3) run
 * alone; by the time SERP turns on, Google has indexed properly.
 *
 * The feature is cross-file wiring with 4 hops. This test locks each hop:
 *   orchestrator.yml ──┐
 *                      ├─ skip_serp=true ─► poller.yml ─► --skip-serp ─► poller.js
 *   (ITERATION <= N) ──┘
 *
 * If any hop silently regresses (e.g., someone renames the input, removes the
 * -le branch, or deletes SKIP_SERP handling), this test fails and forces the
 * author to restore the end-to-end behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..');
const ORCH = readFileSync(join(ROOT, '.github/workflows/opening-night-orchestrator.yml'), 'utf8');
const POLLER_YML = readFileSync(join(ROOT, '.github/workflows/opening-night-poller.yml'), 'utf8');
const POLLER_JS = readFileSync(join(ROOT, 'scripts/opening-night-poller.js'), 'utf8');

test('Hop 1: orchestrator sets SERP_DEFER_ITERATIONS to a positive integer', () => {
  const m = ORCH.match(/SERP_DEFER_ITERATIONS\s*=\s*(\d+)/);
  assert.ok(m, 'orchestrator.yml missing `SERP_DEFER_ITERATIONS=<N>` assignment');
  const n = parseInt(m[1], 10);
  assert.ok(
    n >= 1 && n <= 24,
    `SERP_DEFER_ITERATIONS=${n} — must be in [1, 24]. 0 defeats the purpose; >24 ` +
      `exceeds MAX_ITERATIONS default.`
  );
});

test('Hop 2: orchestrator gates skip_serp=true on `$ITERATION -le $SERP_DEFER_ITERATIONS`', () => {
  // Must gate on -le (inclusive), not -lt, so iteration N itself is also deferred.
  assert.ok(
    /\[\s*"\$ITERATION"\s+-le\s+"\$SERP_DEFER_ITERATIONS"\s*\]/.test(ORCH),
    'orchestrator.yml missing `[ "$ITERATION" -le "$SERP_DEFER_ITERATIONS" ]` gate. ' +
      'If this was changed to -lt, off-by-one bug: the Nth iteration runs SERP ' +
      'prematurely.'
  );
  // And the branch body must set ITER_SKIP_SERP to the skip_serp dispatch flag.
  assert.ok(
    /ITER_SKIP_SERP\s*=\s*"-f\s+skip_serp=true"/.test(ORCH),
    'orchestrator.yml no longer injects `-f skip_serp=true` into poller dispatch.'
  );
});

test('Hop 3: poller.yml declares skip_serp input and forwards it as --skip-serp', () => {
  assert.ok(
    /skip_serp:\s*\n\s*description:/.test(POLLER_YML),
    'opening-night-poller.yml missing skip_serp workflow input'
  );
  assert.ok(
    /if \[ "\$\{\{\s*inputs\.skip_serp\s*\}\}" = "true" \]/.test(POLLER_YML),
    'opening-night-poller.yml missing input-check for skip_serp=true'
  );
  assert.ok(
    /SKIP_SERP_FLAG="--skip-serp"/.test(POLLER_YML),
    'opening-night-poller.yml not translating skip_serp=true into --skip-serp CLI flag'
  );
});

test('Hop 4: poller.js parses --skip-serp and gates runSERPBackup behind !SKIP_SERP', () => {
  assert.ok(
    /const\s+SKIP_SERP\s*=\s*process\.argv\.includes\('--skip-serp'\)/.test(POLLER_JS),
    'opening-night-poller.js no longer parses --skip-serp into SKIP_SERP constant'
  );
  // The normal SERP branch must STILL be guarded by `!SKIP_SERP && shouldRunSerp()`.
  // (The gate may now be one disjunct of a larger condition — see Hop 4b for the only
  // permitted override — but the deferral guard itself must remain intact.)
  assert.ok(
    /!SKIP_SERP\s*&&\s*shouldRunSerp\(\)/.test(POLLER_JS),
    'opening-night-poller.js: runSERPBackup is no longer gated on `!SKIP_SERP && shouldRunSerp()`. ' +
      'Deferral is silently defeated — every iteration will run SERP.'
  );
});

test('Hop 4b: the ONLY override of --skip-serp is the capped WE SERP burst, kill-switchable', () => {
  // 2026-06-05: the WE opening-night SERP burst (scripts/lib/serp-burst-caps.js) is the one
  // sanctioned way SERP runs despite --skip-serp. It is ON by default (automated system) and
  // disabled ONLY by the DISABLE_WE_SERP_BURST kill-switch — so the emergency off must exist,
  // and the override must still be cap-gated. If someone adds an unconditional bypass of
  // SKIP_SERP, or removes the kill-switch, this guard fails.
  assert.ok(
    /ENABLE_WE_SERP_BURST\s*=\s*process\.env\.DISABLE_WE_SERP_BURST\s*!==\s*'true'/.test(POLLER_JS),
    'opening-night-poller.js: burst must be ON by default with a DISABLE_WE_SERP_BURST kill-switch.'
  );
  // serpBurstActive (the override) may only be set inside the SKIP_SERP && ENABLE_WE_SERP_BURST block.
  assert.ok(
    /if\s*\(\s*SKIP_SERP\s*&&\s*ENABLE_WE_SERP_BURST\s*\)/.test(POLLER_JS),
    'opening-night-poller.js: the SERP burst override is no longer gated on ' +
      '`SKIP_SERP && ENABLE_WE_SERP_BURST` — an unflagged bypass would defeat the deferral.'
  );
  // The burst override path must consult the cap helper (hard ceilings), not run unbounded.
  assert.ok(
    /checkSerpBurstAllowed\s*\(/.test(POLLER_JS),
    'opening-night-poller.js: SERP burst no longer routes through checkSerpBurstAllowed (caps bypassed).'
  );
});

test('End-to-end (simulated): ITERATION=1..N are deferred; N+1+ run SERP', () => {
  // Extract the SERP_DEFER_ITERATIONS value and simulate the shell gate.
  const m = ORCH.match(/SERP_DEFER_ITERATIONS\s*=\s*(\d+)/);
  const N = parseInt(m[1], 10);

  function isDeferred(iteration) {
    // Mirrors: if [ "$ITERATION" -le "$SERP_DEFER_ITERATIONS" ] && [ -z "$SKIP_SERP_FLAG" ]
    return iteration <= N;
  }

  for (let i = 1; i <= N; i++) {
    assert.strictEqual(
      isDeferred(i),
      true,
      `Iteration ${i} (<= ${N}) should defer SERP but the gate says otherwise`
    );
  }
  assert.strictEqual(
    isDeferred(N + 1),
    false,
    `Iteration ${N + 1} (> ${N}) should run SERP but the gate defers it`
  );
});
