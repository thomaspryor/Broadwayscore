import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBlockCastChangesGate } = require('./cast-changes-gate.js');

const FLOOR = 15;

test('passes when only routine auto-healable churn under the floor (no cross-show conflict)', () => {
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 0, totalIssues: 0, floor: FLOOR }), false);
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 0, totalIssues: 3, floor: FLOOR }), false);
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 0, totalIssues: FLOOR, floor: FLOOR }), false, 'at floor is not over floor');
});

test('blocks on ANY cross-show conflict (actor in two shows at once — zero tolerance), even under the floor', () => {
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 1, totalIssues: 1, floor: FLOOR }), true);
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 1, totalIssues: 0, floor: FLOOR }), true);
});

test('blocks on a mass churn spike past the floor (cast-scraper regression)', () => {
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 0, totalIssues: FLOOR + 1, floor: FLOOR }), true);
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 0, totalIssues: 80, floor: FLOOR }), true);
});
