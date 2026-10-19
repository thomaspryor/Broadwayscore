// Tests for scripts/lib/poller-serp-deadline.js (BRO-5674). Requires the real module.
// Run: node --test scripts/lib/poller-serp-deadline.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEFAULT_SERP_DEADLINE_SEC, serpDeadlineSec, serpTimeLeft } = require('./poller-serp-deadline.js');

test('default deadline leaves room inside the 600s per-show timeout', () => {
  assert.equal(serpDeadlineSec({}), DEFAULT_SERP_DEADLINE_SEC);
  // worst single SERP call (~70s) started just before the cutoff still ends well before 600s
  assert.ok(DEFAULT_SERP_DEADLINE_SEC + 70 < 600 - 60);
});

test('env override accepted only when a positive number', () => {
  assert.equal(serpDeadlineSec({ POLLER_SERP_DEADLINE_SEC: '120' }), 120);
  assert.equal(serpDeadlineSec({ POLLER_SERP_DEADLINE_SEC: 'abc' }), DEFAULT_SERP_DEADLINE_SEC);
  assert.equal(serpDeadlineSec({ POLLER_SERP_DEADLINE_SEC: '0' }), DEFAULT_SERP_DEADLINE_SEC);
  assert.equal(serpDeadlineSec({ POLLER_SERP_DEADLINE_SEC: '-5' }), DEFAULT_SERP_DEADLINE_SEC);
});

test('serpTimeLeft stops at the deadline', () => {
  const start = 1_000_000;
  assert.equal(serpTimeLeft(start, start + 10_000, 360), true);
  assert.equal(serpTimeLeft(start, start + 359_999, 360), true);
  assert.equal(serpTimeLeft(start, start + 360_000, 360), false);
  // ODC run 39198573930: SERP was still going ~600s in
  assert.equal(serpTimeLeft(start, start + 590_000, 360), false);
});
