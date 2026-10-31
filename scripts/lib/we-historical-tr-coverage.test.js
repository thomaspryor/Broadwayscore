const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSeasonRange, classifyShow, buildCoverage } = require('./we-historical-tr-coverage.js');

const show = (id, season = '2018-2019') => ({ id, season, discoverySource: 'we-historical:wos' });
const probe = shows => ({ shows });
const picked = (o = {}) => ({ outcome: 'picked', listed: 8, skippedExisting: 8, saved: 0, pdf: { layoutChars: 9000, layoutReviews: 8 }, ...o });

test('parseSeasonRange handles short, long and range specs', () => {
  assert.deepEqual(parseSeasonRange('2016-17..2021-22'), { from: 2016, to: 2021 });
  assert.deepEqual(parseSeasonRange('2018-2019'), { from: 2018, to: 2018 });
  assert.equal(parseSeasonRange('nonsense'), null);
});

test('a show the probe never saw is unexplained', () => {
  assert.equal(classifyShow(show('a'), probe({}), 3).reason, 'not-probed');
});

test('no-match outcomes are explained with their reason', () => {
  const c = (outcome) => classifyShow(show('a'), probe({ a: { outcome } }), 1);
  assert.equal(c('search-miss').status, 'explained');
  assert.equal(c('title-mismatch').reason, 'title-mismatch');
  assert.equal(c('no-production-in-window').reason, 'tour-or-regional-only');
});

test('image-only issue is explained as scanned-only', () => {
  const c = classifyShow(show('a'), probe({ a: picked({ pdf: { layoutChars: 40 }, listed: 0 }) }), 0);
  assert.deepEqual([c.status, c.reason], ['explained', 'scanned-only']);
});

test('listed-but-not-held and parser-zero are unexplained', () => {
  assert.equal(classifyShow(show('a'), probe({ a: picked({ saved: 5, skippedExisting: 3 }) }), 3).reason, '5-listed-not-held');
  const z = classifyShow(show('a'), probe({ a: picked({ listed: 0, skippedExisting: 0 }) }), 1);
  assert.equal(z.reason, 'parser-yielded-zero');
});

test('errors and pdf failures are unexplained', () => {
  assert.match(classifyShow(show('a'), probe({ a: { outcome: 'error', error: 'x' } }), 0).reason, /^error/);
  assert.equal(classifyShow(show('a'), probe({ a: picked({ pdf: { failed: 'download' } }) }), 0).reason, 'pdf-download');
});

test('fully held production is ok', () => {
  assert.equal(classifyShow(show('a'), probe({ a: picked() }), 8).status, 'ok');
});

test('buildCoverage filters seasons, counts scored reviews, and fails only on unexplained', () => {
  const shows = [show('in', '2018-2019'), show('out', '2023-2024'), { id: 'x', season: '2018-2019', discoverySource: 'other' }];
  const reviews = [{ showId: 'in', assignedScore: 70 }, { showId: 'in', assignedScore: null }, { showId: 'out', assignedScore: 60 }];
  const ok = buildCoverage({ shows, reviews, probe: probe({ in: picked() }), range: { from: 2016, to: 2021 } });
  assert.equal(ok.rows.length, 1);
  assert.equal(ok.rows[0].counted, 1);
  assert.equal(ok.ok, true);
  const bad = buildCoverage({ shows, reviews, probe: probe({}), range: { from: 2016, to: 2021 } });
  assert.equal(bad.ok, false);
});
