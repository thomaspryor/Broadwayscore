// BRO-3503: createReviewFile's URL-date wrongProduction guards used to run only on the
// new-file path; the merge/replace branches returned first, so a cross-production url
// that matched an existing outlet+critic slot merged straight in. The merge branches
// now ask lib/merge-date-guard.js and refuse such a url. Real functions, no copies (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { incomingCrossProductionReason, crossProductionMergeRefusal } = require('../../scripts/lib/merge-date-guard.js');
const { normalizeUrl } = require('../../scripts/lib/review-normalization.js');

const SHOW = { id: 'x-2024', title: 'X', category: 'broadway', openingDate: '2024-04-11', previewsStartDate: '2024-03-20' };
const OLD_URL = 'https://www.nytimes.com/2019/05/01/theater/x-review.html';
const NEW_URL = 'https://www.nytimes.com/2024/04/11/theater/x-review.html';

test('Unknown-critic url dated years before the run is a cross-production url', () => {
  assert.match(incomingCrossProductionReason({ criticName: 'Unknown', url: OLD_URL }, SHOW), /2019-05-01 is \d+ days before/);
  assert.equal(incomingCrossProductionReason({ criticName: 'Unknown', url: NEW_URL }, SHOW), null);
});

test('BWW roundup entries are checked whatever the byline; other named critics get the benefit of the doubt', () => {
  assert.ok(incomingCrossProductionReason({ criticName: 'Jesse Green', source: 'bww-roundup', url: OLD_URL }, SHOW));
  assert.equal(incomingCrossProductionReason({ criticName: 'Jesse Green', source: 'show-score', url: OLD_URL }, SHOW), null);
});

test('no url or no show: nothing to check', () => {
  assert.equal(incomingCrossProductionReason({ criticName: 'Unknown', url: null }, SHOW), null);
  assert.equal(incomingCrossProductionReason({ criticName: 'Unknown', url: OLD_URL }, null), null);
});

test('a merge is refused only when the incoming url differs from the file\'s own', () => {
  const reason = incomingCrossProductionReason({ criticName: 'Unknown', url: OLD_URL }, SHOW);
  const incoming = { criticName: 'Unknown', url: OLD_URL };
  assert.equal(crossProductionMergeRefusal({ url: NEW_URL }, incoming, reason, normalizeUrl), reason, 'good file keeps its url');
  assert.equal(crossProductionMergeRefusal({ url: null }, incoming, reason, normalizeUrl), reason, 'stub is not filled with another production');
  assert.equal(crossProductionMergeRefusal({ url: OLD_URL + '?utm_source=x' }, incoming, reason, normalizeUrl), null, 're-gathering the same url is not refused');
  assert.equal(crossProductionMergeRefusal({ url: NEW_URL }, incoming, null, normalizeUrl), null);
});

test('createReviewFile consults the guard before every merge/replace into an existing slot', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'gather-reviews.js'), 'utf8');
  const start = src.indexOf('function createReviewFile(');
  const body = src.slice(start, src.indexOf('\nfunction ', start + 10));
  assert.ok(body.includes('incomingCrossProductionReason(reviewData, _showMeta)'));
  // prefix match x2, Unknown->named upgrade, same-key replace/merge
  assert.equal((body.match(/const refused = refuseMergeInto\(existingReview, existingFile\);/g) || []).length, 4);
  const firstRefusal = body.indexOf('refuseMergeInto(existingReview');
  const firstMerge = body.indexOf('mergeReviews(existingReview');
  assert.ok(firstRefusal > 0 && firstRefusal < firstMerge, 'refusal precedes the first merge');
});
