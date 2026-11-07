import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeFetchResult } = require('./fetch-page-probe.js');

const PAGE = '<a href="/news/review-a-play">x</a><a href="/news/review-b-show">y</a>'
  + '<a href="/news/review-a-play">dup</a>';

test('counts distinct matches in result.content', () => {
  const s = summarizeFetchResult({ content: PAGE, format: 'html', source: 'scrapingdog' }, /\/news\/review-[a-z-]+/);
  assert.equal(s.ok, true);
  assert.equal(s.source, 'scrapingdog');
  assert.deepEqual(s.matches, ['/news/review-a-play', '/news/review-b-show']);
});

test('ignores html/body fields fetchPage never returns (BRO-2763 shape)', () => {
  const s = summarizeFetchResult({ html: PAGE, body: PAGE }, /\/news\/review-/);
  assert.equal(s.length, 0);
  assert.equal(s.ok, false);
});

test('content without the expected pattern is not ok', () => {
  const s = summarizeFetchResult({ content: '<html>shell</html>', source: 'brightdata' }, /\/news\/review-/);
  assert.equal(s.ok, false);
  assert.equal(s.matches.length, 0);
});

test('no --expect: any content is ok, empty is not', () => {
  assert.equal(summarizeFetchResult({ content: 'x' }, null).ok, true);
  assert.equal(summarizeFetchResult({ content: '' }, null).ok, false);
  assert.equal(summarizeFetchResult(null, null).ok, false);
});
