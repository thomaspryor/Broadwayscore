import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { guardianFieldsToResult } = require('../../scripts/lib/guardian-api-result.js');

const body = 'A '.repeat(150) + 'review body.';

test('returns the standard tier shape the caller reads (text, method, attempts)', () => {
  const r = guardianFieldsToResult({ bodyText: body, body: `<p>${body}</p>`, starRating: '4' });
  assert.equal(r.text, body);
  assert.equal(typeof r.text.length, 'number');
  assert.equal(r.method, 'guardian-api');
  assert.equal(r.html, `<p>${body}</p>`);
  assert.deepEqual(r.attempts, [{ tier: 0, method: 'guardian-api', success: true }]);
  assert.equal(r.starRating, 4);
  assert.equal(r.fullText, undefined);
});

test('strips HTML from body when bodyText is missing', () => {
  const r = guardianFieldsToResult({ body: `<p>${body}</p><p>More.</p>` });
  assert.match(r.text, /review body\. More\.$/);
  assert.equal(r.starRating, undefined);
});

test('returns null for empty or short bodies so the scraper chain runs', () => {
  assert.equal(guardianFieldsToResult(undefined), null);
  assert.equal(guardianFieldsToResult({}), null);
  assert.equal(guardianFieldsToResult({ bodyText: 'too short' }), null);
});
