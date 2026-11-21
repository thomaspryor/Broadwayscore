// BRO-7402: Front Row Center was found by the audit sweep, not the first pass, on 3 off-Broadway openings.
// Requires the real helpers and the real poller config (no copied logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const h = require('../../scripts/lib/outlet-listing-helpers.js');
const poller = require('../../scripts/outlet-listing-poller.js');

const lefty = { id: 'clifford-odets-waiting-for-lefty-off-broadway-2026', title: 'Clifford Odets’ Waiting for Lefty', openingDate: '2026-11-03', closingDate: null, status: 'open', category: 'off-broadway', creativeTeam: [{ name: 'Clifford Odets', role: 'Playwright' }] };
const tristan = { id: 'tristan-and-yseult-off-broadway-2026', title: 'Tristan & Yseult', openingDate: '2026-11-02', closingDate: null, status: 'open', category: 'off-broadway', creativeTeam: [] };
const parcel = { id: 'parcel-from-america-off-broadway-2026', title: 'Parcel from America', openingDate: '2026-11-05', closingDate: null, status: 'open', category: 'off-broadway', creativeTeam: [] };
const pool = [lefty, tristan, parcel];
const item = (headline, slug, publishDate) => ({ headline, url: `https://thefrontrowcenter.com/2026/11/${slug}/`, publishDate });
const ids = (xs) => xs.map((c) => (c.show || c).id);

test('Waiting for Lefty: bare headline minus the author possessive is a candidate (was: no match)', () => {
  const it = item('Waiting For Lefty', 'waiting-for-lefty', '2026-11-02');
  assert.deepEqual(ids(h.findPageConfirmCandidates(it, pool, {})), [lefty.id]);
});

test('author possessive adds a form only when the owner is on the show creativeTeam', () => {
  assert.ok(h.titleForms(lefty).includes('waiting for lefty'));
  const turner = { id: 'jt', title: "Joe Turner's Come and Gone", creativeTeam: [{ name: 'August Wilson', role: 'Playwright' }] };
  assert.deepEqual(h.titleForms(turner), ['joe turners come and gone']);
});

test('Tristan and Parcel headlines are filed from the feed item alone', () => {
  assert.deepEqual(ids(h.findMatchingShows('Tristan and Yseult', '/2026/11/tristan-and-yseult/', pool, '', { publishDate: '2026-11-06' })), [tristan.id]);
  assert.deepEqual(ids(h.findMatchingShows('Parcel From America The Irish Musical', '/2026/11/parcel-from-america-the-irish-musical/', pool, '', { publishDate: '2026-11-04' })), [parcel.id]);
});

test('front-row-center stays a plain feed: a non-review post that names a show is not a candidate', () => {
  assert.notEqual(poller.OUTLET_STRATEGY_CONFIG['front-row-center'].reviewsOnly, true);
  const news = item('Parcel From America Extends Through December', 'parcel-from-america-extends', '2026-11-04');
  assert.deepEqual(ids(h.findPageConfirmCandidates({ ...news, headline: 'Irish musical news roundup' }, pool, {})), []);
});

test('generic two-word possessive remainders add no form', () => {
  const bm = { id: 'bm', title: "Gore Vidal's The Best Man", creativeTeam: [{ name: 'Gore Vidal', role: 'Playwright' }] };
  assert.equal(h.titleForms(bm).includes('best man'), false);
});
