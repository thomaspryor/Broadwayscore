// BRO-6640: every reader tests wrongProductionManualClear === true, so a plan
// that writes the reason string there leaves the clear inert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');

const rec = () => ({ outletId: 'timeout', wrongProduction: true });
const stamp = { fixId: 'bro-6640', at: '2026-10-30T00:00:00Z' };

test('a prose wrongProductionManualClear is refused', () => {
  const r = applyReviewFieldEdit(rec(), { field: 'wrongProductionManualClear', oldValue: null, newValue: 'text names the right venue' }, stamp);
  assert.equal(r.ok, false);
  assert.match(r.reason, /true or false/);
});

test('true and false are accepted', () => {
  assert.equal(applyReviewFieldEdit(rec(), { field: 'wrongProductionManualClear', oldValue: null, newValue: true }, stamp).ok, true);
  const cleared = { ...rec(), wrongProductionManualClear: true };
  assert.equal(applyReviewFieldEdit(cleared, { field: 'wrongProductionManualClear', oldValue: true, newValue: false }, stamp).ok, true);
});
