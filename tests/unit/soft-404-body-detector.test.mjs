import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSoft404Body, findDuplicateBodies } = require('../../scripts/lib/soft-404-body.js');
const { isPermanentlyFailed, isNonEvidenceFailure } = require('../../scripts/lib/failed-fetch-policy.js');
const { shouldRetryFetch, recordFetchAttempt } = require('../../scripts/lib/review-guards.js');

// The London Box Office soft-404 chrome from BRO-3116 (jane-eyre-off-west-end-2026).
const LBO_BODY =
  'Home Theatre News Document not found The document you are looking for does not exist. ' +
  'Search News & Reviews Latest News 08 Sep Reviews Review: CRYBABIES ' + 'Theatre News Reviews Features '.repeat(24);

const REAL_SHORT_REVIEW =
  'Jane Eyre at Southwark Playhouse Elephant is a bold, stripped back retelling. The cast is superb, ' +
  'the staging inventive, and the evening moves briskly. Four stars.';

test('soft-404 chrome is detected', () => {
  assert.equal(isSoft404Body(LBO_BODY), true);
  assert.equal(isSoft404Body('Page not found. Sorry, we could not find that page.'), true);
});

test('a genuine short review is not flagged', () => {
  assert.equal(isSoft404Body(REAL_SHORT_REVIEW), false);
  assert.equal(isSoft404Body(''), false);
  assert.equal(isSoft404Body(null), false);
});

test('a long article quoting "page not found" is not flagged', () => {
  assert.equal(isSoft404Body('A great show. '.repeat(400) + ' page not found'), false);
});

test('byte-identical bodies across critics are grouped', () => {
  const groups = findDuplicateBodies([
    { file: 'a.json', fullText: LBO_BODY, url: 'https://x/a' },
    { file: 'b.json', fullText: LBO_BODY, url: 'https://x/b' },
    { file: 'd.json', fullText: LBO_BODY.replace('Home', 'Joint'), url: 'https://x/j' },
    { file: 'e.json', fullText: LBO_BODY.replace('Home', 'Joint'), url: 'https://x/j' },
    { file: 'c.json', fullText: REAL_SHORT_REVIEW + ' '.repeat(1) + 'x'.repeat(200) },
  ]);
  assert.deepEqual(groups, [['a.json', 'b.json']]);
});

test('soft_404 is never retired and only cools down', () => {
  assert.equal(isNonEvidenceFailure('soft_404'), true);
  assert.equal(isPermanentlyFailed({ failureReason: 'soft_404', failureCount: 99 }), false);
  const upd = recordFetchAttempt(null, {}, { failureReason: 'soft_404', failureCount: 99 });
  assert.ok(upd.fetchRetryAfter);
  assert.equal(upd.fetchDiscoveryAbandoned, undefined);
  const gate = shouldRetryFetch(null, { fetchRetryAfter: upd.fetchRetryAfter }, { failureReason: 'soft_404', failureCount: 99 });
  assert.equal(gate.shouldRetry, false);
  assert.equal(gate.reason, 'cooldown');
  const later = shouldRetryFetch(null, { fetchRetryAfter: new Date(Date.now() - 1000).toISOString() }, { failureReason: 'soft_404' });
  assert.equal(later.shouldRetry, true);
});
