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

const { countGateChurn, TIME_DRIVEN_COUNTERS } = require('./cast-changes-gate.js');

test('BRO-2752: stale [AUTO-FLAGGED] entries aging out never count toward the spike floor, regardless of N', () => {
  for (const n of [0, 15, 16, 25, 500]) {
    const churn = countGateChurn({ staleAutoFlaggedDropped: n, crossShowConflicts: 0 });
    assert.equal(churn, 0);
    assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 0, totalIssues: churn, floor: FLOOR }), false, `N=${n}`);
  }
});

test('calendar-driven counters (ended absences too) are excluded; scraper-driven counters still count', () => {
  assert.deepEqual([...TIME_DRIVEN_COUNTERS].sort(), ['endedAbsencesDropped', 'staleAutoFlaggedDropped']);
  assert.equal(countGateChurn({ endedAbsencesDropped: 40, nameVariantDedupes: 3, inCastArrivalsDropped: 2 }), 5);
  assert.equal(countGateChurn({ staleAutoFlaggedDropped: 25, nameVariantDedupes: FLOOR + 1 }), FLOOR + 1);
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 0, totalIssues: countGateChurn({ nameVariantDedupes: FLOOR + 1 }), floor: FLOOR }), true);
});

test('cross-show conflicts still block even alongside a large stale batch', () => {
  assert.equal(shouldBlockCastChangesGate({ crossShowConflicts: 1, totalIssues: countGateChurn({ staleAutoFlaggedDropped: 25, crossShowConflicts: 1 }), floor: FLOOR }), true);
});

test('every TIME_DRIVEN_COUNTERS name is a real issueCounts key in audit-cast-changes.js (rename guard)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../audit-cast-changes.js', import.meta.url), 'utf8');
  for (const name of TIME_DRIVEN_COUNTERS) {
    assert.match(src, new RegExp(`\\b${name}: report\\.${name}\\b`), `${name} missing from issueCounts`);
  }
});
