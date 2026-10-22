import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { guardianContentToResult } = require('../../scripts/lib/guardian-api-result.js');

const body = 'A '.repeat(150) + 'review body.';
const show = { id: 'king-lear-west-end-2018', market: 'west-end', previewsStartDate: '2018-07-11', openingDate: '2018-07-18', closingDate: '2018-11-03' };

test('returns the standard tier shape the caller reads, with the API rating and date as apiMeta', () => {
  const { result, reason } = guardianContentToResult(
    { webPublicationDate: '2018-07-19T06:00:00Z', fields: { bodyText: body, body: `<p>${body}</p>`, starRating: '4' } },
    { show });
  assert.equal(reason, null);
  assert.equal(result.text, body);
  assert.equal(result.method, 'guardian-api');
  assert.equal(result.html, '', 'body fragment is not handed to page-level extractors');
  assert.deepEqual(result.attempts, [{ tier: 0, method: 'guardian-api', success: true }]);
  assert.deepEqual(result.apiMeta.score, { originalScore: '4/5 stars', normalizedScore: 80, source: 'guardian-api' });
  assert.equal(result.apiMeta.publishDate, '2018-07-19');
});

test('strips HTML from body when bodyText is missing; no rating means no apiScore', () => {
  const { result } = guardianContentToResult({ fields: { body: `<p>${body}</p><p>More.</p>` } });
  assert.match(result.text, /review body\. More\.$/);
  assert.equal(result.apiMeta.score, null);
  assert.equal(result.apiMeta.publishDate, null);
});

test('ignores a malformed starRating instead of inventing one', () => {
  const { result } = guardianContentToResult({ fields: { bodyText: body, starRating: '4/5' } });
  assert.equal(result.apiMeta.score, null);
});

test('refuses an article dated outside the production window (stale revival slug)', () => {
  const { result, reason } = guardianContentToResult(
    { webPublicationDate: '2014-03-02T00:00:00Z', fields: { bodyText: body, starRating: '5' } }, { show });
  assert.equal(result, null);
  assert.match(reason, /outside this production's window/);
});

test('returns null for empty or short bodies so the scraper chain runs', () => {
  assert.equal(guardianContentToResult(undefined).result, null);
  assert.equal(guardianContentToResult({}).result, null);
  assert.equal(guardianContentToResult({ fields: { bodyText: 'too short' } }).result, null);
});

test('the API publish date counts as a page date for provenance checks', () => {
  const { isPageDateSource } = require('../../scripts/lib/publish-date-provenance.js');
  assert.equal(isPageDateSource('page-guardian-api'), true);
});

test('updateReviewJson stores the API rating and date, replacing an unverified extracted score', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { updateReviewJson } = require('../../scripts/collect-review-texts.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-api-'));
  const url = 'https://www.theguardian.com/stage/2018/jul/27/king-lear-review';
  const text = 'Ian McKellen is magnificent in King Lear at the Duke of York Theatre. '.repeat(40);
  const { result } = guardianContentToResult({ webPublicationDate: '2018-07-27T06:00:00Z', fields: { bodyText: text, starRating: '4' } });
  try {
  for (const seed of [{}, { originalScore: '3/5', scoreSource: 'llm-text' }]) {
    const fp = path.join(dir, `guardian--test-${Object.keys(seed).length}.json`);
    fs.writeFileSync(fp, JSON.stringify({ showId: 'king-lear-west-end-2018', outletId: 'guardian', outlet: 'The Guardian', criticName: 'Michael Billington', url, ...seed }));
    const review = { filePath: fp, file: path.basename(fp), showId: 'king-lear-west-end-2018', outletId: 'guardian', url };
    await updateReviewJson(review, result.text, { isValid: true, issues: [] }, null, result.method, result.attempts, {}, result.html, { isValid: true, issues: [] }, result.apiMeta);
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(d.originalScore, '4/5 stars');
    assert.equal(d.scoreSource, 'guardian-api');
    assert.equal(d.publishDate, '2018-07-27');
    assert.equal(d.dateSource, 'page-guardian-api');
    assert.equal(d.fetchMethod, 'guardian-api');
    assert.equal(d.fetchTier, 0);
    if (seed.originalScore) assert.deepEqual(d.previousExtractedScore, { value: '3/5', source: 'llm-text' });
  }
  // An aggregator-routed score is left to the aggregator slot logic, not superseded.
  const fp = path.join(dir, 'guardian--test-agg.json');
  fs.writeFileSync(fp, JSON.stringify({ showId: 'king-lear-west-end-2018', outletId: 'guardian', url, originalScore: '3/5', scoreSource: 'westendtheatre-star-rating' }));
  await updateReviewJson({ filePath: fp, file: path.basename(fp), showId: 'king-lear-west-end-2018', outletId: 'guardian', url }, result.text, { isValid: true, issues: [] }, null, result.method, result.attempts, {}, result.html, { isValid: true, issues: [] }, result.apiMeta);
  const agg = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.notEqual(agg.aggregatorStarsSource, 'guardian-api');
  assert.equal(agg.originalScore, '3/5', 'aggregator-routed score not superseded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish date is the London calendar day', () => {
  const { londonDay } = require('../../scripts/lib/guardian-api-result.js');
  assert.equal(londonDay('2018-07-26T23:30:00Z'), '2018-07-27');
  assert.equal(londonDay('2018-01-26T23:30:00Z'), '2018-01-26');
  assert.equal(londonDay('nope'), null);
  assert.equal(londonDay(undefined), null);
});
