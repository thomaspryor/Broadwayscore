/**
 * Unit tests for scripts/lib/failed-fetch-policy.js (Scraping cost v3 S2-T5/T6).
 *
 * Run: node --test scripts/lib/failed-fetch-policy.test.mjs
 *
 * The first two cases are the acceptance criteria from the sprint plan:
 * 4x budget_capped + 1x transient → failureCount 1; a ledger entry with 10
 * budget_capped failures is NOT permanently failed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('./failed-fetch-policy.js');
const { shouldCountFailure, isPermanentlyFailed, isNonEvidenceFailure } = require('./failed-fetch-policy.js');

/** Replays recordFailedFetch's counter arithmetic over a sequence of reasons. */
function replay(reasons) {
  let count = 0;
  let lastReason = '';
  for (const reason of reasons) {
    if (shouldCountFailure(reason)) count += 1;
    lastReason = reason;
  }
  return { failureReason: lastReason, failureCount: count };
}

test('S2-T5 acceptance: 4x budget_capped + 1x transient → failureCount === 1', () => {
  const entry = replay(['budget_capped', 'budget_capped', 'budget_capped', 'budget_capped', 'fetch_error']);
  assert.equal(entry.failureCount, 1);
  assert.equal(isPermanentlyFailed(entry), false);
});

test('S2-T6 acceptance: 10 budget_capped failures are NOT permanently failed', () => {
  // Belt-and-braces: even a ledger entry written BEFORE the write-time fix —
  // where the count really did climb — must not retire on a capped reason.
  assert.equal(isPermanentlyFailed({ failureReason: 'budget_capped', failureCount: 10 }), false);
});

test('budget_capped never counts; every other reason does', () => {
  assert.equal(shouldCountFailure('budget_capped'), false);
  assert.equal(isNonEvidenceFailure('budget_capped'), true);
  for (const r of ['fetch_error', 'all_tiers_failed', 'all_tiers_timeout', 'url_dead_404', 'garbage_content', '']) {
    assert.equal(shouldCountFailure(r), true, r);
  }
});

test('confirmed-dead URLs retire at 3, not 5', () => {
  for (const reason of ['url_dead_404', 'url_dead_410']) {
    assert.equal(isPermanentlyFailed({ failureReason: reason, failureCount: 2 }), false, `${reason} @2`);
    assert.equal(isPermanentlyFailed({ failureReason: reason, failureCount: 3 }), true, `${reason} @3`);
  }
});

test('garbage_content retires at 3', () => {
  assert.equal(isPermanentlyFailed({ failureReason: 'garbage_content', failureCount: 2 }), false);
  assert.equal(isPermanentlyFailed({ failureReason: 'garbage_content', failureCount: 3 }), true);
});

test('every other reason retires at 5', () => {
  assert.equal(isPermanentlyFailed({ failureReason: 'fetch_error', failureCount: 4 }), false);
  assert.equal(isPermanentlyFailed({ failureReason: 'fetch_error', failureCount: 5 }), true);
  assert.equal(isPermanentlyFailed({ failureReason: 'all_tiers_failed', failureCount: 5 }), true);
});

test('parity with the inline logic this replaced (read path, all reason/count pairs)', () => {
  // The old inline read-path predicate, verbatim from collect-review-texts.js
  // before S2-T6. budget_capped did not exist then, so it is excluded here —
  // everywhere else the new function must agree exactly.
  const old = (reason, count) => {
    const isConfirmedDead = reason === 'url_dead_404' || reason === 'url_dead_410';
    const isExhaustedGarbage = reason === 'garbage_content' && count >= 3;
    const threshold = isConfirmedDead ? 3 : 5;
    return (reason !== 'garbage_content' && count >= threshold) || isExhaustedGarbage;
  };
  const reasons = ['url_dead_404', 'url_dead_410', 'garbage_content', 'fetch_error', 'all_tiers_failed', 'all_tiers_timeout', 'url_content_mismatch', ''];
  for (const reason of reasons) {
    for (let count = 0; count <= 8; count++) {
      assert.equal(
        isPermanentlyFailed({ failureReason: reason, failureCount: count }),
        old(reason, count),
        `${reason} @${count}`,
      );
    }
  }
});

test('missing/garbage entries are handled without throwing', () => {
  assert.equal(isPermanentlyFailed(null), false);
  assert.equal(isPermanentlyFailed(undefined), false);
  assert.equal(isPermanentlyFailed({}), false, 'no count → nothing to retire on');
  // A reason-less entry still retires on the generic 5-threshold, matching the
  // inline logic this replaced — an unlabelled failure is still a failure.
  assert.equal(isPermanentlyFailed({ failureCount: 99 }), true);
});

// BRO-4185 H: one fresh fetch for a content mismatch judged by an older check.
const { shouldReopenStaleContentMismatch } = require('./failed-fetch-policy');
test('shouldReopenStaleContentMismatch: old-version mismatch on a textless unflagged file reopens once', () => {
  const entry = { failureReason: 'url_content_mismatch' };
  const data = { url: 'https://example.com/review', fullText: null };
  assert.equal(shouldReopenStaleContentMismatch(entry, data, 2), true);
  assert.equal(shouldReopenStaleContentMismatch({ ...entry, checkVersion: 2 }, data, 2), false);
  assert.equal(shouldReopenStaleContentMismatch(entry, { ...data, contentMismatchReopenedFor: 2 }, 2), false);
  assert.equal(shouldReopenStaleContentMismatch(entry, { ...data, fullText: 'x'.repeat(2000) }, 2), false);
  assert.equal(shouldReopenStaleContentMismatch(entry, { ...data, wrongShow: true }, 2), false);
  assert.equal(shouldReopenStaleContentMismatch({ failureReason: 'url_dead' }, data, 2), false);
});

// BRO-5933: a JS exception in our own fetch code is not evidence about the URL.
test('code_error: judged from the error object, never from the waterfall aggregate', () => {
  const crash = "Cannot read properties of undefined (reading 'length')";
  assert.equal(policy.isOwnCodeException(new TypeError(crash)), true);
  assert.equal(policy.isOwnCodeException(new ReferenceError('foo is not defined')), true);
  assert.equal(policy.isOwnCodeException(new Error(crash)), false);
  // A page-side Playwright error quoted inside "All tiers failed" is evidence about the page.
  assert.equal(policy.isOwnCodeException(new TypeError(`All tiers failed: [{"error":"${crash}"}]`)), false);
  assert.equal(policy.classifyFetchFailure({ message: crash, codeError: true }), 'code_error');
  assert.equal(policy.classifyFetchFailure({ message: crash }), 'fetch_error');
  assert.equal(policy.classifyFetchFailure({ message: 'HTTP 404', codeError: true }), 'url_dead_404');
  assert.equal(policy.isNonEvidenceFailure('code_error'), true);
});

test('legacy fetch_error rows whose whole message is an exception read as code_error', () => {
  const crash = "Cannot read properties of undefined (reading 'length')";
  assert.equal(policy.effectiveFailureReason({ failureReason: 'fetch_error', errorMessage: crash }), 'code_error');
  assert.equal(policy.effectiveFailureReason({ failureReason: 'fetch_error', errorMessage: 'x.map is not a function' }), 'code_error');
  assert.equal(policy.effectiveFailureReason({ failureReason: 'fetch_error', errorMessage: `All tiers failed: [{"error":"${crash}"}]` }), 'fetch_error');
  assert.equal(policy.effectiveFailureReason({ failureReason: 'all_tiers_failed', errorMessage: crash }), 'all_tiers_failed');
  // Once the deferral budget is spent the row is an ordinary failure again.
  assert.equal(policy.effectiveFailureReason({ failureReason: 'fetch_error', errorMessage: crash, codeErrorDeferrals: 4 }), 'fetch_error');
  assert.equal(policy.isPermanentlyFailed({ failureReason: 'fetch_error', failureCount: 9, errorMessage: crash }), false);
  assert.equal(policy.isPermanentlyFailed({ failureReason: 'fetch_error', failureCount: 9, errorMessage: 'socket hang up' }), true);
});

test('code_error deferrals are capped, then the row counts as fetch_error', () => {
  let existing = {};
  const seen = [];
  for (let i = 0; i < policy.MAX_CODE_ERROR_DEFERRALS + 1; i++) {
    const r = policy.applyRouteCapDeferralLimit('code_error', existing);
    seen.push(r.reason);
    existing = { codeErrorDeferrals: r.codeErrorDeferrals };
  }
  assert.deepEqual(seen, [...Array(policy.MAX_CODE_ERROR_DEFERRALS).fill('code_error'), 'fetch_error']);
});

test('shouldRetryFetch on the collector-projected entry retries a closed show whose failures were a code exception', () => {
  const { shouldRetryFetch } = require('./review-guards.js');
  const show = { id: 's', status: 'closed', closingDate: '2019-01-01', openingDate: '2018-10-01' };
  const ledgerRow = { reviewId: 's/guardian--x.json', failureReason: 'fetch_error', failureCount: 3, errorMessage: "Cannot read properties of undefined (reading 'length')" };
  // Same projection collect-review-texts.js builds for the per-file gate (no errorMessage carried).
  const projected = { failureReason: policy.effectiveFailureReason(ledgerRow), failureCount: ledgerRow.failureCount, url: null, lastFailedAt: null, lastCappedAt: null };
  assert.equal(shouldRetryFetch(show, { url: 'https://www.theguardian.com/stage/x' }, projected).shouldRetry, true);
  const real = { failureReason: policy.effectiveFailureReason({ failureReason: 'fetch_error', errorMessage: 'socket hang up' }), failureCount: 9 };
  assert.equal(shouldRetryFetch(show, { url: 'https://www.theguardian.com/stage/x' }, real).shouldRetry, false);
});

test('code_error review fixes: Node network TypeErrors are not code errors; the deferral count survives other failures; incomplete reason reads legacy crash rows', () => {
  assert.equal(policy.isOwnCodeException(new TypeError('fetch failed')), false);
  assert.equal(policy.isOwnCodeException(new TypeError('Invalid URL')), false);
  assert.equal(policy.applyRouteCapDeferralLimit('fetch_error', { codeErrorDeferrals: 2 }).codeErrorDeferrals, 2);
  const { classifyIncompleteReason } = require('./incomplete-reason.js');
  const r = classifyIncompleteReason({ url: 'https://www.theguardian.com/stage/x' }, { failureReason: 'fetch_error', failureCount: 2, errorMessage: "Cannot read properties of undefined (reading 'length')" });
  assert.equal(r && r.incompleteReason, 'code_error');
});
