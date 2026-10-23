import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { measure, summarize, normUrl } = require('./audit-verified-miss-presence.js');

const miss = (o) => ({ cohort: 'we-2018-2019', id: 'show-a', outlet: 'The Guardian', url: 'https://www.theguardian.com/stage/2019/a', tier: 1, ...o });

test('same URL with www, query and trailing slash differences matches by url', () => {
  const [r] = measure([miss({})], [{ showId: 'show-a', outlet: 'Other', url: 'http://theguardian.com/stage/2019/a/?utm=1' }]);
  assert.deepEqual([r.present, r.via], [true, 'url']);
});
test('different URL, same outlet and show matches by outlet only', () => {
  const [r] = measure([miss({})], [{ showId: 'show-a', outlet: 'Guardian', url: 'https://www.theguardian.com/other' }]);
  assert.deepEqual([r.present, r.via], [true, 'outlet']);
});
test('same outlet on a different show does not count', () => {
  const [r] = measure([miss({})], [{ showId: 'show-b', outlet: 'The Guardian', url: 'https://www.theguardian.com/stage/2019/a' }]);
  assert.equal(r.present, false);
});
test('summarize counts per cohort', () => {
  const rows = measure([miss({}), miss({ id: 'show-c', cohort: 'bw-historical' })], [{ showId: 'show-a', outlet: 'X', url: 'https://theguardian.com/stage/2019/a' }]);
  const s = summarize(rows);
  assert.deepEqual(s['we-2018-2019'], { total: 1, url: 1, outlet: 0, absent: 0 });
  assert.deepEqual(s['bw-historical'], { total: 1, url: 0, outlet: 0, absent: 1 });
});
test('normUrl is null for empty', () => { assert.equal(normUrl(''), null); });
