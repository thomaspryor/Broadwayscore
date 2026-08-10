/**
 * Pins the detector that would have caught the 2026-08-10 incident on day 2:
 * the local claude CLI was logged out, every headless auto-fix job produced zero
 * output and timed out, and the owner received a near-identical morning digest
 * for 13 consecutive days while "Alert Router: dispatch deadman" read 42/42 green
 * (it counts launches, not outcomes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessAutofixEffectiveness,
  MIN_OUTCOMES_TO_JUDGE,
} = require('./autofix-effectiveness.js');

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
const pass = (h) => ({ event: 'card-pass', ts: at(h) });
const fail = (h) => ({ event: 'card-fail', ts: at(h) });

test('all jobs failing is an ERROR, not a warning', () => {
  const r = assessAutofixEffectiveness([fail(1), fail(2), fail(24)], { now: NOW });
  assert.equal(r.status, 'error');
  assert.equal(r.passes, 0);
  assert.equal(r.attempts, 3);
  assert.match(r.message, /DEAD/);
});

test('the error names the logged-out CLI as the first thing to check', () => {
  // The 2026-08-10 root cause. Without this the operator sees "0 succeeded" and
  // has no idea where to look; the whole point is to shorten 13 days to minutes.
  const r = assessAutofixEffectiveness([fail(1), fail(2), fail(3)], { now: NOW });
  assert.match(r.message, /Not logged in/);
  assert.match(r.message, /bsc-jobs/);
});

test('a majority-failing loop warns even though some jobs pass', () => {
  // Today's real shape: 1 pass, 2 fails.
  const r = assessAutofixEffectiveness([pass(1), fail(2), fail(3)], { now: NOW });
  assert.equal(r.status, 'warn');
  assert.equal(r.rate, 1 / 3);
  assert.match(r.message, /re-report in tomorrow/);
});

test('a healthy loop passes', () => {
  const r = assessAutofixEffectiveness([pass(1), pass(2), pass(3), fail(4)], { now: NOW });
  assert.equal(r.status, 'pass');
  assert.equal(r.passes, 3);
});

test('too few outcomes cannot be called broken', () => {
  const r = assessAutofixEffectiveness([fail(1), fail(2)], { now: NOW });
  assert.equal(r.status, 'pass');
  assert.equal(r.attempts, MIN_OUTCOMES_TO_JUDGE - 1);
  assert.match(r.message, /not enough to call it broken/);
});

test('outcomes outside the window are excluded', () => {
  // 3 ancient failures must not condemn a currently-quiet loop.
  const r = assessAutofixEffectiveness(
    [fail(24 * 30), fail(24 * 31), fail(24 * 32)],
    { now: NOW },
  );
  assert.equal(r.attempts, 0);
  assert.equal(r.status, 'pass');
});

test('auto-dispatch events are ignored — launches are not outcomes', () => {
  // The exact bug in "Alert Router: dispatch deadman": counting attempts made a
  // fully dead fleet look 42/42 healthy.
  const r = assessAutofixEffectiveness(
    [{ event: 'auto-dispatch', ts: at(1) }, { event: 'auto-dispatch', ts: at(2) },
     { event: 'auto-dispatch', ts: at(3) }, { event: 'auto-dispatch', ts: at(4) }],
    { now: NOW },
  );
  assert.equal(r.attempts, 0, 'dispatch attempts must not be read as successes');
  assert.equal(r.passes, 0);
});

test('malformed rows are counted, not silently dropped', () => {
  // A broken ledger writer must not be able to quiet this check.
  const r = assessAutofixEffectiveness(
    [{ event: 'card-fail' }, { event: 'card-fail', ts: 'garbage' }, fail(1)],
    { now: NOW },
  );
  assert.equal(r.attempts, 3);
  assert.equal(r.status, 'error');
});

test('dispatches with ZERO outcomes is an error, not silence', () => {
  // The shape a dead fleet presents in CI: digest-autofix-ledger.jsonl is
  // untracked so it is absent entirely, while the alert router still logs
  // dispatch attempts. An outcomes-only check would go permanently green here —
  // which is exactly what "Alert Router: dispatch deadman" already does wrong.
  const r = assessAutofixEffectiveness([], { now: NOW, dispatchCount: 42 });
  assert.equal(r.status, 'error');
  assert.equal(r.attempts, 0);
  assert.match(r.message, /NOT ONE reported an outcome/);
  assert.match(r.message, /Launching is not fixing/);
});

test('no dispatches and no outcomes stays quiet', () => {
  // A genuinely idle loop must not page anyone.
  const r = assessAutofixEffectiveness([], { now: NOW, dispatchCount: 0 });
  assert.equal(r.status, 'pass');
});

test('a couple of dispatches is below the judging floor', () => {
  const r = assessAutofixEffectiveness([], { now: NOW, dispatchCount: 2 });
  assert.equal(r.status, 'pass');
});

test('real outcomes take precedence over the dispatch cross-reference', () => {
  // Once outcomes exist, judge on those — dispatchCount is only the fallback.
  const r = assessAutofixEffectiveness([pass(1), pass(2), pass(3)], { now: NOW, dispatchCount: 99 });
  assert.equal(r.status, 'pass');
  assert.equal(r.passes, 3);
});

test('survives junk input without throwing', () => {
  for (const bad of [null, undefined, 'nope', 42, [null, undefined, {}]]) {
    const r = assessAutofixEffectiveness(bad, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.attempts, 0);
  }
});

test('reproduces the real ledger shape from the incident', () => {
  // Verbatim event/ts shape from data/audit/digest-autofix-ledger.jsonl.
  const real = [
    { ts: '2026-08-10T11:30:16.893Z', event: 'auto-dispatch', taskId: '1212' },
    { ts: '2026-08-10T11:30:16.893Z', event: 'card-fail' },
    { ts: '2026-08-10T11:30:16.893Z', event: 'card-fail' },
    { ts: '2026-08-10T11:30:16.893Z', event: 'card-pass' },
    { ts: '2026-08-09T11:30:18.000Z', event: 'card-fail' },
  ];
  const r = assessAutofixEffectiveness(real, { now: NOW });
  assert.equal(r.attempts, 4);
  assert.equal(r.passes, 1);
  assert.equal(r.status, 'warn');
});
