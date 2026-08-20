// End-to-end deploy-dedup scenario tests for BRO-554 (reduce 48 deploys/day).
// Thin by design: the exhaustive per-branch coverage of decide() lives in
// scripts/lib/should-deploy-gate.test.mjs and shouldSkipDispatch() is a
// one-line decision, so this file requires both real functions (CLAUDE.md
// rule 15 — no logic duplication) and asserts the two dedup paths from the
// workflow's own perspective: the schedule-tick gate inside
// vercel-deploy.yml, and the pre-dispatch check the 5 automated pipeline
// workflows (gather-reviews.yml etc.) run before calling
// `gh workflow run vercel-deploy.yml`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decide, DEDUP_WINDOW_SEC } = require('./lib/should-deploy-gate.js');
const { shouldSkipDispatch, DEFAULT_WINDOW_SEC } = require('./check-recent-deploy.js');

const SHA_LIVE = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);

test('a burst of schedule ticks within the dedup window only deploys once', () => {
  // Tick 1: content changed, nothing deployed recently — ships.
  const tick1 = decide({
    eventName: 'schedule', gateDisabled: false,
    baselineSha: SHA_LIVE, headSha: SHA_NEW,
    deployAgeSec: DEDUP_WINDOW_SEC + 1, diffResult: 'dirty',
  });
  assert.equal(tick1.proceed, true);

  // Tick 2, five minutes later: tick 1's deploy is now live and recent —
  // even with a further content diff, this tick waits for the window.
  const tick2 = decide({
    eventName: 'schedule', gateDisabled: false,
    baselineSha: SHA_NEW, headSha: 'c'.repeat(40),
    deployAgeSec: 300, diffResult: 'dirty',
  });
  assert.deepEqual(tick2, { proceed: false, reason: 'recently-deployed' });
});

test('once the 30-min window elapses, the next dirty tick deploys', () => {
  const r = decide({
    eventName: 'schedule', gateDisabled: false,
    baselineSha: SHA_LIVE, headSha: SHA_NEW,
    deployAgeSec: DEDUP_WINDOW_SEC + 1, diffResult: 'dirty',
  });
  assert.deepEqual(r, { proceed: true, reason: 'content-changed' });
});

test('pipeline dispatchers (gather-reviews.yml etc.) skip gh workflow run when a deploy is recent', () => {
  const recent = shouldSkipDispatch({ ageSec: 300, windowSec: DEFAULT_WINDOW_SEC, gateDisabled: false });
  assert.deepEqual(recent, { skip: true, reason: 'recently-deployed' });

  const stale = shouldSkipDispatch({ ageSec: DEFAULT_WINDOW_SEC + 1, windowSec: DEFAULT_WINDOW_SEC, gateDisabled: false });
  assert.deepEqual(stale, { skip: false, reason: 'window-elapsed' });
});

test('pipeline dispatchers fail open on unknown deploy age or the kill switch', () => {
  assert.deepEqual(
    shouldSkipDispatch({ ageSec: null, windowSec: DEFAULT_WINDOW_SEC, gateDisabled: false }),
    { skip: false, reason: 'no-age-fail-open' }
  );
  assert.deepEqual(
    shouldSkipDispatch({ ageSec: 1, windowSec: DEFAULT_WINDOW_SEC, gateDisabled: true }),
    { skip: false, reason: 'kill-switch' }
  );
});

test('shared window constant stays in sync between the gate and the pre-dispatch check', () => {
  assert.equal(DEFAULT_WINDOW_SEC, DEDUP_WINDOW_SEC);
  assert.equal(DEDUP_WINDOW_SEC, 1800);
});

test('emergency/manual dispatch (workflow_dispatch) is never dedup-throttled by the gate itself', () => {
  const r = decide({
    eventName: 'workflow_dispatch', gateDisabled: false,
    baselineSha: SHA_LIVE, headSha: SHA_NEW,
    deployAgeSec: 1, diffResult: null,
  });
  assert.deepEqual(r, { proceed: true, reason: 'explicit-ship' });
});
