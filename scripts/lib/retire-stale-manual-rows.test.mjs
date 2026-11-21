import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { planRetire, applyRetire } = createRequire(import.meta.url)('./retire-stale-manual-rows.js');
const rows = [
  { showId: 'w', outletId: 'artsfuse', criticName: 'Robert Israel', assignedScore: 40, manualEntry: true },
  { showId: 'w', outletId: 'artsfuse', criticName: 'Martin Copenhaver', assignedScore: 71 },
  { showId: 'p', outletId: 'boston-com', criticName: 'Samantha Genzer', assignedScore: 68, manualEntry: true },
  { showId: 'p', outletId: 'boston-com', criticName: 'Samantha Genzer', assignedScore: 68 },
];
test('removes only the exact manual row', () => {
  const o = applyRetire(rows, [{ showId: 'w', outletId: 'artsfuse', critic: 'robert israel', score: 40 }]);
  assert.equal(o.removed, 1);
  assert.equal(o.reviews.length, 3);
  assert.ok(o.reviews.some((r) => r.criticName === 'Martin Copenhaver'));
});
test('never touches a pipeline row with the same fields', () => {
  const o = applyRetire(rows, [{ showId: 'p', outletId: 'boston-com', critic: 'Samantha Genzer', score: 68 }]);
  assert.equal(o.removed, 1);
  assert.equal(o.reviews.filter((r) => r.showId === 'p').length, 1);
  assert.ok(!o.reviews.find((r) => r.showId === 'p').manualEntry);
});
test('wrong score matches nothing', () => {
  assert.equal(planRetire(rows, [{ showId: 'w', outletId: 'artsfuse', critic: 'Robert Israel', score: 41 }]).report[0].matched, 0);
});
