// BRO-5732: inheritReviews:false is honoured by the shared window predicate, not
// path by path (BRO-5285, 5333, 5724 each fixed one consumer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isWithinPriorRun, findMatchingPriorRun } = require('../../scripts/lib/wrong-production-autoclear.js');
const { evaluateDateGuard } = require('../../scripts/lib/date-guard.js');
const { filledDateOutsideWindow } = require('../../scripts/lib/flagged-recovery.js');
const { isPublishDateBeforeRun } = require('../../scripts/lib/gap-ingest-policy.js');

const optOut = { openingDate: '2025-03-01', closingDate: '2025-06-30', venue: 'Old House', inheritReviews: false };
const inherits = { ...optOut, inheritReviews: undefined };
const show = (run) => ({
  id: 's', category: 'broadway', openingDate: '2026-03-01', previewsStartDate: '2026-02-10', closingDate: null,
  priorRuns: [run],
});

test('isWithinPriorRun ignores an inheritReviews:false window; findMatchingPriorRun still sees it', () => {
  assert.equal(isWithinPriorRun('2025-04-15', [optOut]), false);
  assert.equal(isWithinPriorRun('2025-04-15', [inherits]), true);
  assert.ok(findMatchingPriorRun('2025-04-15', [optOut]));
  // an overlapping inheriting run still counts
  assert.equal(isWithinPriorRun('2025-04-15', [optOut, { openingDate: '2025-04-01', closingDate: '2025-05-01' }]), true);
});

test('date guard flags a pre-opening review that only an opt-out window would have exempted', () => {
  const flagged = evaluateDateGuard({ pubDate: new Date('2025-04-15'), show: show(optOut), outletId: 'x' });
  assert.equal(flagged.flag, true);
  assert.equal(evaluateDateGuard({ pubDate: new Date('2025-04-15'), show: show(inherits), outletId: 'x' }).flag, false);
});

test('flagged-recovery and gap-ingest-policy treat an opt-out window as not this run', () => {
  assert.equal(filledDateOutsideWindow('2025-04-15', '2026-03-01', show(optOut)), true);
  assert.equal(filledDateOutsideWindow('2025-04-15', '2026-03-01', show(inherits)), false);
  assert.equal(isPublishDateBeforeRun('2025-04-15', show(optOut)), true);
  assert.equal(isPublishDateBeforeRun('2025-04-15', show(inherits)), false);
});
