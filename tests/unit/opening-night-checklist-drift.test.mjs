import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildDriftCheckResult } = require('../../scripts/lib/drift-check.js');

const show = { id: 's1' };
// Shape written by updateState() in scripts/lib/review-count-probe.js.
const entry = (o) => ({ s1: { fingerprint: '21', firstSeen: 1, lastAlertTs: null, ...o } });

test('missing state is a warning, not a failure', () => {
  const r = buildDriftCheckResult(show, {});
  assert.equal(r.ok, true);
  assert.equal(r.severity, 'warning');
});
test('not above threshold is ok', () => {
  const r = buildDriftCheckResult(show, entry({ consecutiveCount: 9, aboveThreshold: false }));
  assert.deepEqual([r.ok, r.severity], [true, 'ok']);
});
test('above threshold on first run is a warning', () => {
  const r = buildDriftCheckResult(show, entry({ consecutiveCount: 1, aboveThreshold: true }));
  assert.deepEqual([r.ok, r.severity], [false, 'warning']);
});
test('above threshold for 2+ runs is an error', () => {
  const r = buildDriftCheckResult(show, entry({ consecutiveCount: 2, aboveThreshold: true }));
  assert.deepEqual([r.ok, r.severity], [false, 'error']);
});
