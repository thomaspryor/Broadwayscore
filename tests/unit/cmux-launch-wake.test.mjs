// Deferred-render wake (cmux lazy-exec fix, 2026-08-02): while the cmux app
// is backgrounded it does not create the terminal surface for a new
// workspace, so the typed command never runs — indistinguishable, to the
// verifier, from a swallowed injection, and the retry that follows is the
// duplicate-session factory. waitForLaunchOutcome must fire its wake exactly
// once when no wrapper has EVER appeared by wakeAfterSec, and never when the
// command started normally. Requires the REAL module (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { waitForLaunchOutcome, WAKE_AFTER_SEC } = require('../../scripts/lib/cmux-launch.js');

// Fake monotonic clock: each call advances 250ms, so second-scale thresholds
// are crossed after a handful of loop iterations without any real sleeping.
function fakeClock(stepMs = 250) {
  let t = 0;
  return () => (t += stepMs);
}

function runOutcome({ wrapperAliveSeq, tagAlive = false, wakeAfterSec = 1, injectionGraceSec = 3, slowBootCapSec = 5 }) {
  const wakes = [];
  let i = 0;
  const result = waitForLaunchOutcome({
    ws: { ref: 'workspace:999' },
    marker: 'bsc-cmd-test-deadbeef.sh',
    attempt: 2, maxAttempts: 2, // final attempt → terminal states are 'fail', loop always exits
    injectionGraceSec, slowBootCapSec, wakeAfterSec,
    probes: {
      wrapperAlive: () => {
        const v = i < wrapperAliveSeq.length ? wrapperAliveSeq[i] : wrapperAliveSeq[wrapperAliveSeq.length - 1];
        i += 1;
        return v;
      },
      claudeTagAlive: () => tagAlive,
      wake: () => wakes.push(true),
      intervalSec: 0,
      now: fakeClock(),
    },
  });
  return { result, wakes };
}

test('wrapper never appears → wake fires exactly once, before the grace expires', () => {
  const { result, wakes } = runOutcome({ wrapperAliveSeq: [false] });
  assert.equal(wakes.length, 1, 'wake must fire exactly once per verification');
  assert.equal(result.wakeAttempted, true);
  assert.equal(result.state, 'injection-never-ran');
});

test('wrapper alive from the first poll → wake never fires', () => {
  // wrapper + tag alive → immediate 'ok'; a wake here would churn app-focus
  // state on every healthy launch.
  const { result, wakes } = runOutcome({ wrapperAliveSeq: [true], tagAlive: true });
  assert.equal(result.action, 'ok');
  assert.equal(wakes.length, 0, 'healthy launches must not touch app-focus');
  assert.equal(result.wakeAttempted, false);
});

test('wrapper appears before wakeAfterSec → no wake, normal slow-boot path', () => {
  // First poll misses (elapsed still under the wake threshold on the same
  // iteration), wrapper is there from the second poll on.
  const { result, wakes } = runOutcome({ wrapperAliveSeq: [true], tagAlive: false, wakeAfterSec: 60 });
  assert.equal(wakes.length, 0);
  assert.equal(result.state, 'slow-boot-timeout', 'wrapper alive but claude never registers → slow-boot, not dead');
  assert.equal(result.wakeAttempted, false);
});

test('WAKE_AFTER_SEC default exists and sits inside the injection grace window', () => {
  assert.ok(Number.isFinite(WAKE_AFTER_SEC) && WAKE_AFTER_SEC > 0);
  assert.ok(WAKE_AFTER_SEC < 90, 'wake must fire before the default injection grace can expire');
});
