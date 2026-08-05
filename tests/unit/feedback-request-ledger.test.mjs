// Guards the "is it actually live?" rules (2026-08-05, owner request).
//
// The dangerous failure here is a FALSE POSITIVE: emailing "your request is
// live" for something that never shipped closes the loop on an unfixed request,
// which is worse than the silence it replaced. Every rule below defaults to
// "not satisfied" when the evidence is absent or unrecognised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildEntry,
  evaluateEntry,
  staleEntries,
  mergeEntries,
  STALE_AFTER_DAYS,
} = require('../../scripts/lib/feedback-request-ledger.js');

// Real compact payload from broadwayscorecard.com/data/shows/{id}.json:
// `rv` reviews, `hi` hero image path, `cat` category.
const LIVE_ONE_REVIEW = { id: '3-summers-of-lincoln-regional-2025', cat: 'regional', rv: [{ o: 'San Diego Union-Tribune' }], hi: '/images/shows/3-summers-of-lincoln-regional-2025/hero.webp' };
const LIVE_NO_IMAGE = { id: 'x', cat: 'regional', rv: [], hi: null };

test('buildEntry records the standing route, so "systematic fix" can be reported', () => {
  const entry = buildEntry(
    { kind: 'missing-reviews', showId: 'lincoln', showTitle: '3 Summers of Lincoln', reviewCountAtRequest: 1, workflow: 'gather-reviews.yml' },
    { submissionId: 'sub-1', issueNumber: 543, requestedAt: '2026-08-05T14:10:00Z', message: 'Please finish the reviews', show: '3 Summers of Lincoln (Regional)' }
  );
  assert.equal(entry.status, 'open');
  assert.equal(entry.reviewCountAtRequest, 1);
  assert.equal(entry.systematicFix.routed, true);
  assert.equal(entry.systematicFix.route, 'missing-reviews');
});

test('a request is never "live" when production does not serve the show', () => {
  const entry = buildEntry({ kind: 'missing-show', title: 'The Outsiders', market: 'regional' }, { submissionId: 's' });
  const { satisfied, evidence } = evaluateEntry(entry, null);
  assert.equal(satisfied, false);
  assert.match(evidence, /not served by production/);
});

test('missing-show is satisfied the moment production serves the show', () => {
  const entry = buildEntry({ kind: 'missing-show', title: '3 Summers of Lincoln', market: 'regional' }, { submissionId: 's' });
  const { satisfied, evidence } = evaluateEntry(entry, LIVE_ONE_REVIEW);
  assert.equal(satisfied, true);
  assert.match(evidence, /live with 1 review/);
});

test('missing-reviews needs MORE reviews than at request time, not merely some', () => {
  const entry = buildEntry({ kind: 'missing-reviews', showId: 'lincoln', reviewCountAtRequest: 1 }, { submissionId: 's' });
  // Still the same single review the user complained about.
  assert.equal(evaluateEntry(entry, LIVE_ONE_REVIEW).satisfied, false,
    'unchanged review count must not be reported as fixed');
  const grown = { ...LIVE_ONE_REVIEW, rv: [{ o: 'A' }, { o: 'B' }, { o: 'C' }] };
  const res = evaluateEntry(entry, grown);
  assert.equal(res.satisfied, true);
  assert.match(res.evidence, /1 → 3 review/);
});

test('missing-reviews treats an unknown request-time count as zero', () => {
  const entry = buildEntry({ kind: 'missing-reviews', showId: 'lincoln', reviewCountAtRequest: null }, { submissionId: 's' });
  assert.equal(evaluateEntry(entry, LIVE_ONE_REVIEW).satisfied, true);
  assert.equal(evaluateEntry(entry, { rv: [] }).satisfied, false);
});

test('missing-image checks the hero path production actually serves', () => {
  const entry = buildEntry({ kind: 'missing-image', showId: 'x' }, { submissionId: 's' });
  assert.equal(evaluateEntry(entry, LIVE_NO_IMAGE).satisfied, false);
  assert.equal(evaluateEntry(entry, LIVE_ONE_REVIEW).satisfied, true);
});

test('an unrecognised kind never claims satisfied', () => {
  const entry = buildEntry({ kind: 'some-future-kind', showId: 'x' }, { submissionId: 's' });
  const { satisfied, evidence } = evaluateEntry(entry, LIVE_ONE_REVIEW);
  assert.equal(satisfied, false, 'a rule we have not written must not close a request');
  assert.match(evidence, /no live-check rule/);
});

test('stuck requests surface after the stale threshold and are not auto-closed', () => {
  const now = Date.parse('2026-08-10T00:00:00Z');
  const ledger = { entries: [
    { key: 'a', status: 'open', requestedAt: '2026-08-09T00:00:00Z' },  // 1 day
    { key: 'b', status: 'open', requestedAt: '2026-08-01T00:00:00Z' },  // 9 days
    { key: 'c', status: 'live', requestedAt: '2026-08-01T00:00:00Z' },  // already done
  ]};
  const stale = staleEntries(ledger, now);
  assert.deepEqual(stale.map((e) => e.key), ['b']);
  assert.equal(ledger.entries.find((e) => e.key === 'b').status, 'open',
    'stale must stay open — a failed request gets louder, never expires');
  assert.ok(STALE_AFTER_DAYS >= 1);
});

test('re-reporting the same request does not double-track it', () => {
  const first = buildEntry({ kind: 'missing-show', title: 'X' }, { submissionId: 'sub-1' });
  const dup = buildEntry({ kind: 'missing-show', title: 'X' }, { submissionId: 'sub-1' });
  const other = buildEntry({ kind: 'missing-show', title: 'X' }, { submissionId: 'sub-2' });
  const step1 = mergeEntries({ entries: [] }, [first]);
  assert.equal(step1.added, 1);
  const step2 = mergeEntries(step1.ledger, [dup, other]);
  assert.equal(step2.added, 1, 'same submission + same ask is one request');
  assert.equal(step2.ledger.entries.length, 2);
});

test('mergeEntries tolerates a missing or malformed ledger', () => {
  assert.equal(mergeEntries(null, []).ledger.entries.length, 0);
  assert.equal(mergeEntries({ entries: 'nope' }, []).ledger.entries.length, 0);
});
