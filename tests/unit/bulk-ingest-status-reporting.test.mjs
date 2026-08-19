/**
 * Regression test for Card #1604 (Lost Boys postmortem Issue #1 P1).
 *
 * Lost Boys 2026 opening night: operator submitted 11 reviews via the
 * /ingest bulk-paste UI. UI showed "6 reviews · rebuild · dispatched" +
 * 4 visible byline-detect errors = 10 accounted for. One review vanished
 * with no error message anywhere.
 *
 * 2026-04-29 audit found the original delimited-paste architecture (the one
 * that dropped that review) had already been replaced by an explicit
 * URL/text-row model, but the row model reintroduced its own silent-drop
 * paths: a slot that failed client-side validation (bad URL, <50 char text)
 * or duplicated another slot's URL in the same batch was filtered out of
 * `validSlots` before the submit loop ever ran — so it never produced a log
 * row at all. scripts/lib/ingest-status.js is the fix: every non-empty slot
 * gets exactly one plan entry (submit or skip-with-reason), and every
 * outcome (success, byline-fallback, server rejection, or pre-submit skip)
 * classifies into one explicit, always-rendered status.
 *
 * Run: node --test tests/unit/bulk-ingest-status-reporting.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyStatus,
  classifyServerFailure,
  describeStatus,
  isValidUrl,
  validateSlotForSubmission,
  findDuplicateSlotIds,
  buildSubmissionPlan,
  STATUS_META,
} = require('../../scripts/lib/ingest-status.js');

function slot(id, url, fullText = 'x'.repeat(60)) {
  return { id, url, fullText, scoreInput: '' };
}

// ─── classifyStatus / describeStatus ────────────────────────────────

test('classifyStatus: successful save with no pendingReason -> success', () => {
  assert.equal(classifyStatus({ status: 'saved' }), 'success');
});

test('classifyStatus: saved with pendingReason no-byline -> byline-error', () => {
  assert.equal(classifyStatus({ status: 'saved', pendingReason: 'no-byline' }), 'byline-error');
});

test('classifyStatus: failed outlet-unknown -> outlet-unknown', () => {
  assert.equal(classifyStatus({ status: 'failed', failureReason: 'outlet-unknown' }), 'outlet-unknown');
});

test('classifyStatus: failed stale-flag duplicate -> duplicate-filtered', () => {
  assert.equal(classifyStatus({ status: 'failed', failureReason: 'duplicate' }), 'duplicate-filtered');
});

test('classifyStatus: failed malformed-url -> malformed-line', () => {
  assert.equal(classifyStatus({ status: 'failed', failureReason: 'malformed-url' }), 'malformed-line');
});

test('classifyStatus: failed server-error -> server-error', () => {
  assert.equal(classifyStatus({ status: 'failed', failureReason: 'server-error' }), 'server-error');
});

test('classifyStatus: failed no-show/other -> other-rejection (never unclassified)', () => {
  assert.equal(classifyStatus({ status: 'failed', failureReason: 'no-show' }), 'other-rejection');
  assert.equal(classifyStatus({ status: 'failed', failureReason: 'other' }), 'other-rejection');
  assert.equal(classifyStatus({ status: 'failed' }), 'other-rejection');
});

test('classifyStatus: pre-submit skippedReason takes priority (never reached the API)', () => {
  assert.equal(classifyStatus({ status: 'failed', skippedReason: 'malformed-line' }), 'malformed-line');
  assert.equal(classifyStatus({ status: 'failed', skippedReason: 'duplicate-filtered' }), 'duplicate-filtered');
});

test('classifyStatus: submitting -> submitting', () => {
  assert.equal(classifyStatus({ status: 'submitting' }), 'submitting');
});

test('every classifyServerFailure branch has a describeStatus entry with a distinct icon', () => {
  const reasons = ['outlet-unknown', 'duplicate', 'malformed-url', 'server-error', 'no-show', 'other', undefined];
  const seen = new Map();
  for (const reason of reasons) {
    const displayStatus = classifyServerFailure(reason);
    const meta = describeStatus(displayStatus);
    assert.ok(meta && meta.icon && meta.label, `missing STATUS_META entry for ${displayStatus}`);
    seen.set(reason, { displayStatus, icon: meta.icon, label: meta.label });
  }
  // outlet-unknown / duplicate-filtered / malformed-line / server-error must
  // each be visually distinct from one another (icon or label differs).
  const distinctBuckets = new Set(['outlet-unknown', 'duplicate', 'malformed-url', 'server-error'].map(r => seen.get(r).displayStatus));
  assert.equal(distinctBuckets.size, 4);
});

// ─── isValidUrl / validateSlotForSubmission ─────────────────────────

test('isValidUrl accepts http(s), rejects malformed/non-web schemes', () => {
  assert.equal(isValidUrl('https://www.nytimes.com/theater/review'), true);
  assert.equal(isValidUrl('http://example.com'), true);
  assert.equal(isValidUrl('not a url'), false);
  assert.equal(isValidUrl(''), false);
  assert.equal(isValidUrl('mailto:critic@outlet.com'), false);
});

test('validateSlotForSubmission: valid url + >=50 char text passes', () => {
  assert.equal(validateSlotForSubmission(slot('s1', 'https://outlet.com/review', 'x'.repeat(50))), null);
});

test('validateSlotForSubmission: malformed url -> malformed-line', () => {
  assert.equal(validateSlotForSubmission(slot('s1', 'not-a-url', 'x'.repeat(60))), 'malformed-line');
});

test('validateSlotForSubmission: text under 50 chars -> malformed-line', () => {
  assert.equal(validateSlotForSubmission(slot('s1', 'https://outlet.com/review', 'too short')), 'malformed-line');
});

test('validateSlotForSubmission: empty url -> malformed-line', () => {
  assert.equal(validateSlotForSubmission(slot('s1', '', 'x'.repeat(60))), 'malformed-line');
});

// ─── findDuplicateSlotIds ────────────────────────────────────────────

test('findDuplicateSlotIds: flags the 2nd+ occurrence of the same URL, not the 1st', () => {
  const slots = [
    slot('a', 'https://outlet.com/review'),
    slot('b', 'https://other.com/review'),
    slot('c', 'https://outlet.com/review'), // dupe of a
  ];
  const dupes = findDuplicateSlotIds(slots);
  assert.deepEqual([...dupes], ['c']);
});

test('findDuplicateSlotIds: normalizes host case and trailing slash', () => {
  const slots = [
    slot('a', 'https://Outlet.com/review'),
    slot('b', 'https://outlet.com/review/'),
  ];
  const dupes = findDuplicateSlotIds(slots);
  assert.deepEqual([...dupes], ['b']);
});

test('findDuplicateSlotIds: distinct URLs -> no dupes', () => {
  const slots = [slot('a', 'https://outlet.com/1'), slot('b', 'https://outlet.com/2')];
  assert.equal(findDuplicateSlotIds(slots).size, 0);
});

// ─── buildSubmissionPlan: the no-silent-drop guarantee ──────────────

test('buildSubmissionPlan: every non-empty slot gets exactly one plan entry (N in -> N out)', () => {
  const slots = [
    slot('valid', 'https://nytimes.com/review-a', 'x'.repeat(60)),
    slot('malformed-url', 'not-a-url', 'x'.repeat(60)),
    slot('malformed-text', 'https://nypost.com/review-b', 'short'),
    slot('dupe', 'https://nytimes.com/review-a', 'x'.repeat(60)), // dupes 'valid'
  ];
  const plan = buildSubmissionPlan(slots);
  assert.equal(plan.length, slots.length, 'no submitted slot should vanish from the plan');
  const bySlotId = Object.fromEntries(plan.map(p => [p.slot.id, p]));
  assert.equal(bySlotId.valid.action, 'submit');
  assert.equal(bySlotId['malformed-url'].action, 'skip');
  assert.equal(bySlotId['malformed-url'].skipReason, 'malformed-line');
  assert.equal(bySlotId['malformed-text'].action, 'skip');
  assert.equal(bySlotId['malformed-text'].skipReason, 'malformed-line');
  assert.equal(bySlotId.dupe.action, 'skip');
  assert.equal(bySlotId.dupe.skipReason, 'duplicate-filtered');
});

test('buildSubmissionPlan: genuinely blank slots (no url, no text) are not "attempted submissions"', () => {
  const slots = [slot('valid', 'https://nytimes.com/review-a', 'x'.repeat(60)), slot('blank', '', '')];
  const plan = buildSubmissionPlan(slots);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].slot.id, 'valid');
});

test('buildSubmissionPlan: a slot with only a URL typed (no text yet) still gets a row, not silence', () => {
  const slots = [slot('partial', 'https://nytimes.com/review-a', '')];
  const plan = buildSubmissionPlan(slots);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'skip');
  assert.equal(plan[0].skipReason, 'malformed-line');
});

// ─── Acceptance criterion 5: mixed batch produces exactly 3 distinct rows ──

test('mixed batch (1 valid, 1 byline-fail, 1 duplicate) -> exactly 3 distinct status rows', () => {
  const slots = [
    slot('good', 'https://nytimes.com/review-a', 'x'.repeat(60)),
    slot('byline', 'https://newoutlet.com/review-b', 'x'.repeat(60)),
    slot('dupe', 'https://nytimes.com/review-a', 'x'.repeat(60)), // same URL as 'good'
  ];
  const plan = buildSubmissionPlan(slots);
  assert.equal(plan.length, 3, 'exactly 3 status rows for 3 submitted URLs — none silently dropped');

  // Simulate the API responses each 'submit' action would get back, then
  // build the final display rows the same way IngestForm does.
  const serverResponses = {
    good: { status: 'saved' },
    byline: { status: 'saved', pendingReason: 'no-byline' },
  };
  const rows = plan.map(item => {
    if (item.action === 'skip') return classifyStatus({ status: 'failed', skippedReason: item.skipReason });
    return classifyStatus(serverResponses[item.slot.id]);
  });

  assert.deepEqual(rows.sort(), ['byline-error', 'duplicate-filtered', 'success'].sort());

  const labels = new Set(rows.map(r => describeStatus(r).label));
  const icons = new Set(rows.map(r => describeStatus(r).icon));
  assert.equal(labels.size, 3, 'all 3 rows must have distinct human-readable labels');
  assert.equal(icons.size, 3, 'all 3 rows must have distinct icons');
});

test('STATUS_META covers every status classifyStatus can produce', () => {
  const allInputs = [
    { status: 'saved' },
    { status: 'saved', pendingReason: 'no-byline' },
    { status: 'failed', failureReason: 'outlet-unknown' },
    { status: 'failed', failureReason: 'duplicate' },
    { status: 'failed', failureReason: 'malformed-url' },
    { status: 'failed', failureReason: 'server-error' },
    { status: 'failed', failureReason: 'no-show' },
    { status: 'submitting' },
    { status: 'failed', skippedReason: 'malformed-line' },
    { status: 'failed', skippedReason: 'duplicate-filtered' },
  ];
  for (const entry of allInputs) {
    const displayStatus = classifyStatus(entry);
    assert.ok(STATUS_META[displayStatus], `STATUS_META missing entry for "${displayStatus}"`);
  }
});
