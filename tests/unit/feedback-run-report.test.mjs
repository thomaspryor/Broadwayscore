// Guards the owner-visibility path (2026-08-05, GH #543).
//
// The failure this protects against is quiet, not loud: if a submission fails
// to match its report entry, nothing crashes — the owner simply gets an email
// saying "no action taken" for a dispatch that actually ran. That is the same
// class of silent-wrong-outcome that let #505 and #543 sit untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  submissionId,
  findReportItem,
  recordIssue,
  recordDispatch,
} = require('../../scripts/lib/feedback-run-report.js');

// Formspree's real shape: `_date`, not `_id`/`id`/`createdAt`.
const SUB = { _date: '2026-08-05T14:10:00.000000+00:00', show: '3 Summers of Lincoln (Regional)', message: 'Please finish the reviews for 3 Summers of Lincoln.' };

function freshReport() {
  return {
    items: [
      {
        submissionId: '2026-08-05T14:10:00.000000+00:00',
        show: '3 Summers of Lincoln (Regional)',
        message: 'Please finish the reviews for 3 Summers of Lincoln.',
        plannedActions: [{ kind: 'missing-reviews', workflow: 'gather-reviews.yml' }],
        issueNumber: null,
        dispatches: [],
      },
      {
        submissionId: '2026-08-05T09:00:00.000000+00:00',
        show: 'Hamilton',
        message: 'Different submission entirely.',
        plannedActions: [],
        issueNumber: null,
        dispatches: [],
      },
    ],
  };
}

test('submissionId reads Formspree _date, matching process-feedback.js', () => {
  assert.equal(submissionId(SUB), '2026-08-05T14:10:00.000000+00:00');
  assert.equal(submissionId({ _id: 'x', _date: 'y' }), 'x', '_id still wins if the API ever returns it');
  assert.equal(submissionId({}), null);
  assert.equal(submissionId(null), null);
});

test('a submission matches its own report entry, not a sibling', () => {
  const report = freshReport();
  const entry = findReportItem(report, SUB);
  assert.equal(entry.show, '3 Summers of Lincoln (Regional)');
});

test('message text is the fallback when the ID is absent', () => {
  const report = freshReport();
  const entry = findReportItem(report, { message: 'Please finish the reviews for 3 Summers of Lincoln.' });
  assert.ok(entry, 'an ID-less submission must still find its entry');
  assert.equal(entry.submissionId, '2026-08-05T14:10:00.000000+00:00');
});

test('an unmatchable submission returns null rather than corrupting a sibling entry', () => {
  const report = freshReport();
  assert.equal(findReportItem(report, { _date: 'nope', message: 'never seen' }), null);
  assert.equal(recordIssue(report, { _date: 'nope', message: 'never seen' }, 999), false);
  assert.equal(report.items.some((i) => i.issueNumber === 999), false,
    'a miss must never write onto the wrong submission');
});

test('recordIssue and recordDispatch attach to the right entry', () => {
  const report = freshReport();
  assert.equal(recordIssue(report, SUB, 543), true);
  assert.equal(recordDispatch(report, SUB, { workflow: 'gather-reviews.yml', kind: 'missing-reviews', inputs: { shows: '3-summers-of-lincoln-regional-2025' } }, true, null), true);
  const [lincoln, hamilton] = report.items;
  assert.equal(lincoln.issueNumber, 543);
  assert.deepEqual(lincoln.dispatches, [{
    workflow: 'gather-reviews.yml',
    kind: 'missing-reviews',
    inputs: { shows: '3-summers-of-lincoln-regional-2025' },
    ok: true,
    error: null,
  }]);
  assert.equal(hamilton.issueNumber, null, 'the other submission must be untouched');
  assert.deepEqual(hamilton.dispatches, []);
});

test('a failed dispatch is recorded with its error, never dropped', () => {
  const report = freshReport();
  recordDispatch(report, SUB, { workflow: 'gather-reviews.yml', kind: 'missing-reviews' }, false, 'HTTP 422: workflow disabled');
  const d = report.items[0].dispatches[0];
  assert.equal(d.ok, false);
  assert.equal(d.error, 'HTTP 422: workflow disabled');
});

test('a missing report degrades to no-op instead of throwing', () => {
  // Happens on a run that drains only PREVIOUS-run pending diagnoses, whose
  // report no longer exists. Must not sink issue creation.
  assert.equal(findReportItem(null, SUB), null);
  assert.equal(recordIssue(null, SUB, 1), false);
  assert.equal(recordDispatch(undefined, SUB, { workflow: 'w' }, true), false);
  assert.equal(findReportItem({ items: 'not-an-array' }, SUB), null);
});
