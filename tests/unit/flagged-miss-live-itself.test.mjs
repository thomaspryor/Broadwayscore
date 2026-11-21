/**
 * BRO-6742: the gap audit counted reviews that are live on the site as
 * "automated exclusions to re-verify", because its per-file predicate
 * (isIncludableForRebuild) mirrors the rebuild with known gaps: Off Off Online's
 * Anonymous and Front Row Center's Hate Radio carry a high-confidence CV
 * "feature/preview" verdict the rebuild treats as advisory (the ensemble scored
 * them as reviews), so both are in reviews.json while the audit called them missing.
 * Requires the real functions.
 *
 * Run: node --test tests/unit/flagged-miss-live-itself.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isLiveItself, shouldReverify } = require('../../scripts/lib/flagged-miss-basis.js');
const { canonicalizeUrlForDedup } = require('../../scripts/lib/review-guards.js');
const norm = (u) => canonicalizeUrlForDedup(u) || u;
const live = new Set(['https://www.offoffonline.com/offoffonline/2026/1/31/anonymous'].map(norm));

test('a flagged file whose own url is live is not a miss', () => {
  assert.equal(isLiveItself([{ url: 'https://www.offoffonline.com/offoffonline/2026/1/31/anonymous/' }], live, norm), true);
});

test('a different url, no url, or no live set is still a miss', () => {
  assert.equal(isLiveItself([{ url: 'https://www.offoffonline.com/offoffonline/2026/2/1/other' }], live, norm), false);
  assert.equal(isLiveItself([{}], live, norm), false);
  assert.equal(isLiveItself([{ url: 'https://www.offoffonline.com/offoffonline/2026/1/31/anonymous' }], new Set(), norm), false);
});

test('shouldReverify skips a live one and still re-verifies the rest', () => {
  const m = { exclusion: 'automatedExcluded' };
  assert.equal(shouldReverify(m), true);
  assert.equal(shouldReverify({ ...m, liveInReviews: true }), false);
});
