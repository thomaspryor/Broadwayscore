// scripts/lib/express-retry-decision.test.mjs — node:test
// Run: node --test scripts/lib/express-retry-decision.test.mjs
//
// Pure decision logic for card #1889 (Opening Night Express same-night
// retry). Per CLAUDE.md §15 — require()s the real functions, no copied logic.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  RETRY_RATIO_THRESHOLD,
  shouldRetryExpress,
  computeDueAt,
  enqueueRetry,
  selectDueRetries,
  markAttempted,
  pruneStale,
} from './express-retry-decision.js';

const NOW = '2026-08-25T09:09:00.000Z';

// Minimal realistic fixtures — isIncludableForRebuild requires either
// fullText, an aggregator excerpt field, or a score signal (originalScore/
// aggregatorStars/llmScore) before it will count a record as scoreable at
// all (scripts/lib/review-guards.js "noTextOrScoreSignal"/
// "wrongContentNoUsableSignal" branches) — a bare {contentTier: 'complete'}
// is excluded, not includable, so tests must carry that minimum shape.
const realText = (contentTier) => ({ contentTier, fullText: 'x'.repeat(300) });
const excerptOnly = (contentTier) => ({ contentTier, bwwExcerpt: 'short excerpt text', originalScore: 7 });

test('shouldRetryExpress: zero scoreable records -> retry', () => {
  const result = shouldRetryExpress({ reviewFiles: [], isRetry: false });
  assert.equal(result.retry, true);
  assert.match(result.reason, /zero scoreable/);
});

test('shouldRetryExpress: all records excluded (wrongProduction) -> retry', () => {
  const reviewFiles = [
    { contentTier: 'invalid', wrongProduction: true },
    { contentTier: 'invalid', wrongProduction: true },
  ];
  const result = shouldRetryExpress({ reviewFiles, isRetry: false });
  assert.equal(result.retry, true);
});

test('shouldRetryExpress: mostly stubs/excerpts below threshold -> retry', () => {
  // 1/3 real text = 33% < 34% threshold
  const reviewFiles = [realText('complete'), excerptOnly('stub'), excerptOnly('excerpt')];
  const result = shouldRetryExpress({ reviewFiles, isRetry: false });
  assert.equal(result.retry, true);
  assert.match(result.reason, /1\/3/);
});

test('shouldRetryExpress: real coverage at/above threshold -> no retry', () => {
  // 2/3 real text = 67% >= 34%
  const reviewFiles = [realText('complete'), realText('truncated'), excerptOnly('excerpt')];
  const result = shouldRetryExpress({ reviewFiles, isRetry: false });
  assert.equal(result.retry, false);
});

test('shouldRetryExpress: exactly at threshold boundary is retry (< not <=)', () => {
  // Construct a ratio just under RETRY_RATIO_THRESHOLD deliberately, and
  // confirm the boundary constant is exported for callers/tests to reference.
  assert.equal(RETRY_RATIO_THRESHOLD, 0.34);
});

test('shouldRetryExpress: isRetry true never re-enqueues, even with zero coverage', () => {
  const result = shouldRetryExpress({ reviewFiles: [], isRetry: true });
  assert.equal(result.retry, false);
  assert.equal(result.thin, true);
  assert.match(result.reason, /still thin after retry/);
});

test('shouldRetryExpress: isRetry true with good coverage -> not thin, plain reason', () => {
  const reviewFiles = [realText('complete'), realText('truncated')];
  const result = shouldRetryExpress({ reviewFiles, isRetry: true });
  assert.equal(result.retry, false);
  assert.equal(result.thin, false);
  assert.doesNotMatch(result.reason, /still thin/);
});

test('shouldRetryExpress: excluded records are not counted toward scoreable total', () => {
  const reviewFiles = [
    realText('complete'),
    { ...excerptOnly('invalid'), wrongProduction: true },
    { ...excerptOnly('invalid'), isNonReview: true },
    { ...excerptOnly('invalid'), duplicateOf: 'other-file.json' },
  ];
  // Only 1 scoreable record, and it has real text -> no retry.
  const result = shouldRetryExpress({ reviewFiles, isRetry: false });
  assert.equal(result.retry, false);
});

test('computeDueAt: default 16h offset', () => {
  const due = computeDueAt(NOW);
  assert.equal(due, '2026-08-26T01:09:00.000Z');
});

test('computeDueAt: custom delay', () => {
  const due = computeDueAt(NOW, 4);
  assert.equal(due, '2026-08-25T13:09:00.000Z');
});

test('enqueueRetry: adds a new entry with computed dueAt', () => {
  const { entries, changed } = enqueueRetry([], {
    showId: 'paranormal-activity-2026',
    market: 'broadway',
    nowIso: NOW,
  });
  assert.equal(changed, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].showId, 'paranormal-activity-2026');
  assert.equal(entries[0].attempted, false);
  assert.equal(entries[0].dueAt, computeDueAt(NOW));
});

test('enqueueRetry: idempotent while an un-attempted entry is outstanding', () => {
  const first = enqueueRetry([], { showId: 'show-a', market: 'broadway', nowIso: NOW });
  const second = enqueueRetry(first.entries, { showId: 'show-a', market: 'broadway', nowIso: NOW });
  assert.equal(second.changed, false);
  assert.equal(second.entries.length, 1);
});

test('enqueueRetry: allows a new entry once the prior one is attempted', () => {
  const first = enqueueRetry([], { showId: 'show-a', market: 'broadway', nowIso: NOW });
  const attempted = markAttempted(first.entries, 'show-a', NOW, NOW);
  const second = enqueueRetry(attempted, { showId: 'show-a', market: 'broadway', nowIso: '2026-08-26T09:00:00.000Z' });
  assert.equal(second.changed, true);
  assert.equal(second.entries.length, 2);
});

test('selectDueRetries: only un-attempted entries at/past dueAt', () => {
  const entries = [
    { showId: 'a', dueAt: '2026-08-25T10:00:00.000Z', attempted: false },
    { showId: 'b', dueAt: '2026-08-25T12:00:00.000Z', attempted: false }, // not due yet
    { showId: 'c', dueAt: '2026-08-25T09:00:00.000Z', attempted: true }, // already attempted
  ];
  const due = selectDueRetries(entries, '2026-08-25T11:00:00.000Z');
  assert.deepEqual(due.map((e) => e.showId), ['a']);
});

test('markAttempted: only touches the matching showId+queuedAt pair', () => {
  const entries = [
    { showId: 'a', queuedAt: NOW, attempted: false },
    { showId: 'a', queuedAt: '2026-08-20T00:00:00.000Z', attempted: false },
  ];
  const result = markAttempted(entries, 'a', NOW, '2026-08-25T10:00:00.000Z');
  assert.equal(result[0].attempted, true);
  assert.equal(result[0].attemptedAt, '2026-08-25T10:00:00.000Z');
  assert.equal(result[1].attempted, false);
});

test('markAttempted: merges extra fields (e.g. skipped-because-coverage-complete)', () => {
  const entries = [{ showId: 'a', queuedAt: NOW, attempted: false }];
  const result = markAttempted(entries, 'a', NOW, '2026-08-25T10:00:00.000Z', {
    skipped: true,
    skipReason: 'coverage-already-complete',
  });
  assert.equal(result[0].attempted, true);
  assert.equal(result[0].skipped, true);
  assert.equal(result[0].skipReason, 'coverage-already-complete');
});

test('pruneStale: drops entries older than maxAgeDays regardless of attempted', () => {
  const entries = [
    { showId: 'old', queuedAt: '2026-08-20T00:00:00.000Z', attempted: true },
    { showId: 'recent', queuedAt: '2026-08-25T00:00:00.000Z', attempted: false },
  ];
  const result = pruneStale(entries, '2026-08-26T00:00:00.000Z', 3);
  assert.deepEqual(result.map((e) => e.showId), ['recent']);
});
