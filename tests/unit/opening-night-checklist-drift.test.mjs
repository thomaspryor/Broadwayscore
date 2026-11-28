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
test('allowlisted / deploy-lag (suppressed) drift never escalates to error', () => {
  const r = buildDriftCheckResult(show, entry({ consecutiveCount: 5, aboveThreshold: true, suppressed: true }));
  assert.equal(r.severity, 'warning');
});
test('updateState persists suppressed so the checklist can see it', () => {
  const { updateState } = require('../../scripts/lib/review-count-probe.js');
  const st = {};
  updateState(st, 's1', '21', false, true, true);
  updateState(st, 's1', '21', false, true, true);
  assert.equal(st.s1.suppressed, true);
  assert.equal(buildDriftCheckResult(show, st).severity, 'warning');
  updateState(st, 's1', '21', false, true, false);
  assert.equal(buildDriftCheckResult(show, st).severity, 'error');
});
