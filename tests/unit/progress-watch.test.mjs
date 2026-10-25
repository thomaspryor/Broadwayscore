// Task #597: monitors that assert existence/thresholds never catch a metric
// that stopped ADVANCING — a queue depth pinned at the same number, a launch
// counter stuck at zero. This is the primitive that closes that gap.
// Notion 3aa637c5-416f-8169.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { recordProgress, isStalled, assertProgress } = require('../../scripts/lib/progress-watch.js');

function withValues(values) {
  return values.reduce((history, value) => recordProgress(history, value), []);
}

test('isStalled: first observation is never a false-positive stall (cold start)', () => {
  const history = withValues([141]);
  assert.equal(isStalled(history, { cycles: 3 }).stalled, false);
  assert.equal(isStalled(history, { cycles: 3 }).reason, 'insufficient-history');
});

test('isStalled: fewer observations than cycles is never a stall', () => {
  const history = withValues([141, 141]); // only 2, cycles=3
  assert.equal(isStalled(history, { cycles: 3 }).stalled, false);
});

test('isStalled: value unchanged across N cycles => stalled', () => {
  const history = withValues([141, 141, 141]);
  const result = isStalled(history, { cycles: 3 });
  assert.equal(result.stalled, true);
  assert.match(result.reason, /unchanged for 3 consecutive cycles/);
});

test('isStalled: value moving => not stalled', () => {
  const history = withValues([141, 138, 130]);
  assert.equal(isStalled(history, { cycles: 3 }).stalled, false);
  assert.equal(isStalled(history, { cycles: 3 }).reason, 'moving');
});

test('isStalled: only the trailing window matters — old movement does not mask a recent stall', () => {
  const history = withValues([200, 150, 100, 50, 50, 50]);
  assert.equal(isStalled(history, { cycles: 3 }).stalled, true);
});

test('isStalled: a single differing sample inside the window breaks the stall', () => {
  const history = withValues([141, 141, 140, 140]);
  assert.equal(isStalled(history, { cycles: 3 }).stalled, false);
});

test('recordProgress: caps history at maxHistory, dropping oldest first', () => {
  let history = [];
  for (let i = 0; i < 5; i++) history = recordProgress(history, i, { maxHistory: 3 });
  assert.deepEqual(history.map((o) => o.value), [2, 3, 4]);
});

test('assertProgress: records then evaluates in one call, non-zero pinned value still stalls under direction:down', () => {
  let history = [];
  let result;
  for (const v of [10, 10, 10]) {
    result = assertProgress(history, v, { cycles: 3, direction: 'down' });
    history = result.history;
  }
  assert.equal(result.stalled, true);
  assert.equal(result.direction, 'down');
  assert.equal(result.value, 10);
});

// Second-opinion review finding (task #597, 2026-07-30): a naive stall
// detector pages forever on every queue it successfully drains. A queue that
// reaches 0 and STAYS at 0 is the surface working correctly, not stalled.
test('isStalled: direction=down pinned at 0 is never a stall (drained queue, not a dead one)', () => {
  const history = withValues([2, 1, 0, 0, 0, 0]);
  assert.equal(isStalled(history, { cycles: 3, direction: 'down' }).stalled, false);
  assert.match(isStalled(history, { cycles: 3, direction: 'down' }).reason, /drained-to-zero/);
});

test('isStalled: direction=down pinned at a NON-zero value still stalls', () => {
  const history = withValues([5, 5, 5]);
  assert.equal(isStalled(history, { cycles: 3, direction: 'down' }).stalled, true);
});

test('isStalled: without direction:down, pinned at 0 stalls like any other value (no implicit exception)', () => {
  const history = withValues([0, 0, 0]);
  assert.equal(isStalled(history, { cycles: 3 }).stalled, true);
  assert.equal(isStalled(history, { cycles: 3, direction: 'up' }).stalled, true);
});

// Replay check (task #597 acceptance criteria): the real bw-v6-decompression
// needsRescore queue sat at exactly 141 across repeated drains for ~6 days
// (scripts/lib/rescore-lifecycle.js header). Feed that literal history and
// confirm the primitive would have fired well before day 6.
test('replay: the real 141-for-6-days needsRescore history fires the stall', () => {
  const dailyValues = [141, 141, 141, 141, 141, 141]; // 6 daily drains, unchanged
  let history = [];
  const results = [];
  for (const v of dailyValues) {
    const r = assertProgress(history, v, { cycles: 3, direction: 'down' });
    history = r.history;
    results.push(r);
  }
  // Not enough history yet on day 1-2.
  assert.equal(results[0].stalled, false);
  assert.equal(results[1].stalled, false);
  // By day 3 (3 consecutive identical samples), it fires — and stays fired
  // for the rest of the real 6-day incident instead of going silent again.
  for (let day = 2; day < results.length; day++) {
    assert.equal(results[day].stalled, true, `day ${day + 1} should be stalled`);
  }
});

test('replay: the same history with real movement (10 files/day recovered) never fires', () => {
  const dailyValues = [141, 131, 121, 111, 101, 91];
  let history = [];
  let result;
  for (const v of dailyValues) {
    result = assertProgress(history, v, { cycles: 3, direction: 'down' });
    history = result.history;
  }
  assert.equal(result.stalled, false);
});
