/**
 * Acceptance test for BRO-55 (Lost Boys postmortem Issue #1 P1) — same
 * underlying bug as Notion Card #1604, fixed by commits 404620f8bbc,
 * 7573df7bd2d, 18a313f5c32, 13cd832c3cd (scripts/lib/ingest-status.js +
 * IngestForm.tsx wiring; see tests/unit/bulk-ingest-status-reporting.test.mjs
 * for the full pure-function suite and tests/e2e/ingest-form-batch.spec.ts
 * for the component-level wiring regression).
 *
 * This file is the named acceptance check for BRO-55: reproduce the exact
 * Lost Boys scenario (11 submitted reviews, "6 reviews · rebuild ·
 * dispatched" + 4 visible errors = 10 accounted for, 1 silently vanished)
 * and assert every submitted slot now produces exactly one accounted-for
 * status row — submit or skip, never neither.
 *
 * Run: node --test tests/unit/ingest-bulk-drop-detection.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSubmissionPlan, classifyStatus } = require('../../scripts/lib/ingest-status.js');

function slot(id, url, fullText = 'x'.repeat(60)) {
  return { id, url, fullText, scoreInput: '' };
}

test('BRO-55 regression: 11-review batch (6 saved, 4 byline-errors, 1 duplicate) — all 11 accounted for', () => {
  const slots = [
    slot('r1', 'https://nytimes.com/review-1'),
    slot('r2', 'https://vulture.com/review-2'),
    slot('r3', 'https://variety.com/review-3'),
    slot('r4', 'https://newoutlet-a.com/review-4'),
    slot('r5', 'https://newoutlet-b.com/review-5'),
    slot('r6', 'https://newoutlet-c.com/review-6'),
    slot('byline1', 'https://smallblog-a.com/review-7'),
    slot('byline2', 'https://smallblog-b.com/review-8'),
    slot('byline3', 'https://smallblog-c.com/review-9'),
    slot('byline4', 'https://smallblog-d.com/review-10'),
    slot('dupe', 'https://nytimes.com/review-1'), // 11th: same URL as r1, the one that used to vanish
  ];

  const plan = buildSubmissionPlan(slots);
  assert.equal(plan.length, 11, 'every one of the 11 submitted slots must get a plan entry');

  const bySlotId = Object.fromEntries(plan.map(p => [p.slot.id, p]));

  // Simulate the API: 6 clean saves, 4 saved-with-no-byline.
  const serverResponses = {
    r1: { status: 'saved' },
    r2: { status: 'saved' },
    r3: { status: 'saved' },
    r4: { status: 'saved' },
    r5: { status: 'saved' },
    r6: { status: 'saved' },
    byline1: { status: 'saved', pendingReason: 'no-byline' },
    byline2: { status: 'saved', pendingReason: 'no-byline' },
    byline3: { status: 'saved', pendingReason: 'no-byline' },
    byline4: { status: 'saved', pendingReason: 'no-byline' },
  };

  const rows = plan.map(item => {
    if (item.action === 'skip') return classifyStatus({ status: 'failed', skippedReason: item.skipReason });
    return classifyStatus(serverResponses[item.slot.id]);
  });

  assert.equal(rows.length, 11, 'no row disappears between the plan and the rendered status list');
  assert.equal(bySlotId.dupe.action, 'skip');
  assert.equal(bySlotId.dupe.skipReason, 'duplicate-filtered', 'the 11th review is reported as a duplicate, not silently dropped');

  const successCount = rows.filter(r => r === 'success').length;
  const bylineErrorCount = rows.filter(r => r === 'byline-error').length;
  const duplicateCount = rows.filter(r => r === 'duplicate-filtered').length;
  assert.equal(successCount, 6);
  assert.equal(bylineErrorCount, 4);
  assert.equal(duplicateCount, 1);
  assert.equal(successCount + bylineErrorCount + duplicateCount, 11, '6 + 4 + 1 = 11, not 10 — nothing vanishes');
});

test('no-silent-drop invariant: N slots with any content in -> N status rows out, for arbitrary mixes', () => {
  const slots = [
    slot('valid-a', 'https://outlet-a.com/review'),
    slot('valid-b', 'https://outlet-b.com/review'),
    slot('malformed', 'not-a-url'),
    slot('too-short', 'https://outlet-c.com/review', 'short'),
    slot('dupe-of-a', 'https://outlet-a.com/review'),
    slot('blank', '', ''), // genuinely empty — not an attempted submission
  ];

  const plan = buildSubmissionPlan(slots);
  const attempted = slots.filter(s => (s.url || '').trim() || (s.fullText || '').trim());
  assert.equal(plan.length, attempted.length, 'every slot with any content gets exactly one plan entry');
  assert.ok(!plan.some(p => p.slot.id === 'blank'), 'a genuinely blank slot is not a phantom row');
});
