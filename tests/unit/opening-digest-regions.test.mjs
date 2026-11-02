// Owner ask 2026-11-02: regional, tour, tryout and Chicago/DC openings never
// reached the opening digest. buildRows() tagged them region 'other' and
// buildHtml() only rendered the NYC and London blocks, so they vanished.
// These tests pin the routing and that every region a row can land in is
// rendered. Real functions only (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { regionOf, rowMarketLabel, buildHtml, REGION_ORDER } = require('../../scripts/send-opening-digest.js');

test('regionOf routes every market to its own block', () => {
  assert.equal(regionOf('broadway'), 'nyc');
  assert.equal(regionOf('off-broadway'), 'nyc');
  assert.equal(regionOf('west-end'), 'london');
  assert.equal(regionOf('off-west-end'), 'london');
  assert.equal(regionOf('tour', { city: 'chicago-il' }), 'tour');
  assert.equal(regionOf('regional', { city: 'chicago-il' }), 'chicago');
  assert.equal(regionOf('regional', { city: 'washington-dc' }), 'dc');
  assert.equal(regionOf('regional', { city: 'san-diego-ca' }), 'regional');
  assert.equal(regionOf('regional'), 'regional');
  assert.equal(regionOf('opera'), 'other');
});

test('every region regionOf can return is rendered', () => {
  for (const [m, s] of [['broadway'], ['west-end'], ['tour'], ['regional', { city: 'chicago-il' }],
    ['regional', { city: 'washington-dc' }], ['regional'], ['opera'], ['something-new']]) {
    assert.ok(REGION_ORDER.includes(regionOf(m, s || {})), `${m} -> ${regionOf(m, s || {})} not rendered`);
  }
});

test('row labels say what kind of production it is', () => {
  assert.equal(rowMarketLabel({ venue: 'Goodman Theatre', transferredTo: 'x-2027' }, 'regional'), 'Pre-Broadway tryout · Goodman Theatre');
  assert.equal(rowMarketLabel({ venue: 'Steppenwolf', localOnly: true }, 'regional'), 'Local · Steppenwolf');
  assert.equal(rowMarketLabel({ venue: 'La Jolla Playhouse' }, 'regional'), 'Regional · La Jolla Playhouse');
  assert.equal(rowMarketLabel({ venue: 'Kennedy Center' }, 'tour'), 'National tour · Kennedy Center');
  assert.equal(rowMarketLabel({}, 'off-broadway'), 'Off-Broadway');
});

const row = (id, region, market, daysFromToday) => ({
  id, title: `Show ${id}`, url: `https://broadwayscorecard.com/show/${id}`, date: '2026-11-05',
  market, region, marketLabel: 'x', type: 'play', daysFromToday, reviewCount: 0, criticScore: null,
});

test('non-NYC/London rows appear in the email', () => {
  const html = buildHtml({
    needsHelp: [], broadcastReady: [], comingUp: [],
    otherRecent: [row('tryout-a', 'regional', 'regional', -2)],
    otherUpcoming: [row('chi-b', 'chicago', 'regional', 3), row('dc-c', 'dc', 'regional', 4), row('tour-d', 'tour', 'tour', 5), row('opera-e', 'other', 'opera', 1)],
    todayHuman: 'Monday',
  });
  for (const id of ['tryout-a', 'chi-b', 'dc-c', 'tour-d', 'opera-e']) assert.ok(html.includes(`Show ${id}`), `${id} missing from HTML`);
  for (const label of ['Pre-Broadway &amp; Regional', 'Chicago', 'Washington DC', 'National Tours']) assert.ok(html.includes(label), `${label} block missing`);
});

test('empty extra regions stay out; long city lists are capped with a hub link', () => {
  const many = Array.from({ length: 14 }, (_, i) => row(`chi-${i}`, 'chicago', 'regional', 2));
  const html = buildHtml({ needsHelp: [], broadcastReady: [], comingUp: [], otherRecent: [], otherUpcoming: many, todayHuman: 'Monday' });
  assert.ok(!html.includes('National Tours'));
  assert.ok(html.includes('+4 more'));
  assert.ok(html.includes('/tours/chicago-il'));
  assert.ok(!html.includes('Show chi-13<'));
});
