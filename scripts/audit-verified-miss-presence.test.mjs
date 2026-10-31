import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { measure, summarize, normUrl, diagnose } = require('./audit-verified-miss-presence.js');

const miss = (o) => ({ cohort: 'we-2018-2019', id: 'show-a', outlet: 'The Guardian', url: 'https://www.theguardian.com/stage/2019/a', tier: 1, ...o });

test('same URL with www, scheme and tracking-param differences matches by url', () => {
  const [r] = measure([miss({})], [{ showId: 'show-a', outlet: 'Other', url: 'http://theguardian.com/stage/2019/a?utm_source=x' }]);
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
test('a trailing slash does not defeat the url match', () => {
  const [r] = measure([miss({})], [{ showId: 'show-a', outlet: 'Other', url: 'https://www.theguardian.com/stage/2019/a/' }]);
  assert.equal(r.via, 'url');
});
test('New York Times is not The Times; Time Out New York is not Time Out London', () => {
  const rv = [{ showId: 'show-a', outlet: 'The Times', url: 'https://thetimes.co.uk/x' }];
  assert.equal(measure([miss({ outlet: 'The New York Times', url: 'https://nytimes.com/y' })], rv)[0].present, false);
  const rv2 = [{ showId: 'show-a', outlet: 'Time Out London', url: 'https://timeout.com/london/x' }];
  assert.equal(measure([miss({ outlet: 'Time Out New York', url: 'https://timeout.com/newyork/y' })], rv2)[0].present, false);
});
test('normUrl is null for empty', () => { assert.equal(normUrl(''), null); });

const long = 'x'.repeat(300);
test('diagnose: no file, flagged, no text, unscored, scored-not-rebuilt', () => {
  const m = miss({});
  assert.equal(diagnose(m, []).stuck, 'no-file');
  const f = (d) => [{ file: 'a.json', data: { url: m.url, outlet: 'The Guardian', ...d } }];
  assert.equal(diagnose(m, f({ isRoundupArticle: true, fullText: long })).stuck, 'flagged:isRoundupArticle');
  assert.equal(diagnose(m, f({ fullText: 'short' })).stuck, 'no-text');
  assert.equal(diagnose(m, f({ fullText: long })).stuck, 'unscored');
  assert.equal(diagnose(m, f({ fullText: long, assignedScore: 80 })).stuck, 'scored-not-rebuilt');
});
test('diagnose never returns prose', () => {
  const m = miss({});
  const g = diagnose(m, [{ file: 'a.json', data: { url: m.url, fullText: long, excerpt: 'SECRET PROSE', assignedScore: 80 } }]);
  assert.doesNotMatch(JSON.stringify(g), /SECRET PROSE|xxxx/);
});
