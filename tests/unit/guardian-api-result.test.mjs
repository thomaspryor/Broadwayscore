import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { guardianContentToResult } = require('../../scripts/lib/guardian-api-result.js');

const body = 'A '.repeat(150) + 'review body.';
const show = { id: 'king-lear-west-end-2018', market: 'west-end', previewsStartDate: '2018-07-11', openingDate: '2018-07-18', closingDate: '2018-11-03' };

test('returns the standard tier shape the caller reads, with the API rating as apiScore', () => {
  const { result, reason } = guardianContentToResult(
    { webPublicationDate: '2018-07-19T06:00:00Z', fields: { bodyText: body, body: `<p>${body}</p>`, starRating: '4' } },
    { show });
  assert.equal(reason, null);
  assert.equal(result.text, body);
  assert.equal(result.method, 'guardian-api');
  assert.equal(result.html, '', 'body fragment is not handed to page-level extractors');
  assert.deepEqual(result.attempts, [{ tier: 0, method: 'guardian-api', success: true }]);
  assert.deepEqual(result.apiScore, { originalScore: '4/5 stars', normalizedScore: 80, source: 'guardian-api' });
});

test('strips HTML from body when bodyText is missing; no rating means no apiScore', () => {
  const { result } = guardianContentToResult({ fields: { body: `<p>${body}</p><p>More.</p>` } });
  assert.match(result.text, /review body\. More\.$/);
  assert.equal(result.apiScore, null);
});

test('ignores a malformed starRating instead of inventing one', () => {
  const { result } = guardianContentToResult({ fields: { bodyText: body, starRating: '4/5' } });
  assert.equal(result.apiScore, null);
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
