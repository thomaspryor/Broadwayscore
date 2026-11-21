// BRO-5081: legacy web-search rows with a url but no real text were scored from
// excerpts that step wrote itself (absent from all 34 reachable pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isUnverifiableWebSearchRow } = require('../../scripts/lib/review-guards.js');

const base = { source: 'web-search', sources: ['web-search'], url: 'https://variety.com/2008/legit/reviews/a-tale-of-two-cities-1200472041/', dtliExcerpt: 'Despite handsome design elements, this ambitious musical suffers.', assignedScore: 50 };

test('url + no text + web-search only: excluded', () => {
  assert.equal(isUnverifiableWebSearchRow(base), true);
  assert.equal(isUnverifiableWebSearchRow({ ...base, fullText: 'A Bronx Tale is a show that knows exactly what it wants to be and executes that vision with considerable skill and heart.' }), true);
});
test('real page text, an aggregator source, a SERP url row or a human score keeps the row', () => {
  assert.equal(isUnverifiableWebSearchRow({ ...base, fullText: 'x '.repeat(600) }), false);
  assert.equal(isUnverifiableWebSearchRow({ ...base, sources: ['web-search', 'dtli'] }), false);
  assert.equal(isUnverifiableWebSearchRow({ ...base, source: 'serp-discovery', sources: ['serp-discovery'] }), false);
  assert.equal(isUnverifiableWebSearchRow({ ...base, humanReviewScore: 70 }), false);
});
test('no-url rule unchanged', () => {
  assert.equal(isUnverifiableWebSearchRow({ source: 'serp-discovery', fullText: '' }), true);
  assert.equal(isUnverifiableWebSearchRow({ source: 'serp-discovery', fullText: 'y'.repeat(60) }), false);
});
