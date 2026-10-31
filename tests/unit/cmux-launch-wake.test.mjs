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
  // First poll misses, wrapper is there from the second poll on — well
  // before the (deliberately huge) wake threshold.
  const { result, wakes } = runOutcome({ wrapperAliveSeq: [false, true], tagAlive: false, wakeAfterSec: 60 });
  assert.equal(wakes.length, 0);
  assert.equal(result.state, 'slow-boot-timeout', 'wrapper alive but claude never registers → slow-boot, not dead');
  assert.equal(result.wakeAttempted, false);
});

test('deferred tab: wrapper appears only AFTER the wake, past the ORIGINAL grace → still ok (grace restarts at wake)', () => {
  // The feature's whole point: a deferred surface starts its command only
  // once woken, and the render + shell init can outlive the original grace.
  // Wake fires at 2s (grace 3s → restarted to 5s); the wrapper appears at
  // ~3.5s — DEAD under the pre-restart logic, verified ok with it.
  const wakes = [];
  let polls = 0;
  const result = waitForLaunchOutcome({
    ws: { ref: 'workspace:999' },
    marker: 'bsc-cmd-test-deadbeef.sh',
    attempt: 2, maxAttempts: 2,
    injectionGraceSec: 3, slowBootCapSec: 5, wakeAfterSec: 2,
    probes: {
      // Tag registers together with the wrapper — a tag-without-wrapper from
      // poll 1 would (correctly) short-circuit into wrapper-gone-tag-alive.
      wrapperAlive: () => { polls += 1; return wakes.length > 0 && polls >= 14; },
      claudeTagAlive: () => wakes.length > 0 && polls >= 14,
      wake: () => wakes.push(true),
      intervalSec: 0,
      now: fakeClock(),
    },
  });
  assert.equal(result.action, 'ok', 'a woken tab whose command starts after the original grace must verify, not die');
  assert.equal(wakes.length, 1);
  assert.equal(result.wakeAttempted, true);
});

test('WAKE_AFTER_SEC default exists and sits inside the injection window', () => {
  assert.ok(Number.isFinite(WAKE_AFTER_SEC) && WAKE_AFTER_SEC > 0);
  // launchCmuxSession's default verifyTimeoutSec is 30 — the wake must fire
  // well before the tightest real grace can expire.
  assert.ok(WAKE_AFTER_SEC < 30, 'wake must fire before the default injection grace can expire');
});
