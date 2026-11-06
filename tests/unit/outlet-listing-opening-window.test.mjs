// BRO-7051: opening-window mode of outlet-listing-poller. Requires the real filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ow = require('../../scripts/lib/outlet-opening-window.js');
const poller = require('../../scripts/outlet-listing-poller.js');

const NOW = Date.parse('2026-11-06T15:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const show = (id, category, daysAgo, extra = {}) => ({ id, category, openingDate: day(daysAgo), status: 'open', ...extra });

test('no in-window shows means no shows and no outlets (so no fetches)', () => {
  const shows = [show('old', 'broadway', 30), show('future', 'off-broadway', -5)];
  const w = ow.selectWindowShows(shows, NOW);
  assert.deepEqual(w, []);
  const r = ow.selectWindowOutlets({ windowShows: w, allShows: shows, allReviews: [], outletStrategyConfig: {}, wpApiConfig: {}, skipOutlets: new Set(), now: NOW });
  assert.deepEqual(r, { outlets: [], skippedSerp: [] });
});

test('window is 0..3 days past opening, status-independent', () => {
  const shows = [0, 1, 3, 4].map((d) => show('s' + d, 'off-broadway', d, { status: d === 1 ? 'previews' : 'open' }));
  assert.deepEqual(ow.selectWindowShows(shows, NOW).map((s) => s.id), ['s0', 's1', 's3']);
});

test('tours and regional shows are excluded', () => {
  const shows = [show('t', 'tour', 1), show('r', 'regional', 1), show('b', 'broadway', 1)];
  assert.deepEqual(ow.selectWindowShows(shows, NOW).map((s) => s.id), ['b']);
});

test('SERP-only outlets are skipped; free strategies are kept', () => {
  const osc = { a: { strategy: 'rss' }, b: { strategy: 'serp' }, c: { strategy: 'listing-html' }, d: { strategy: 'sitemap' } };
  const wp = { e: {} };
  assert.equal(ow.windowStrategyFor('a', osc, wp), 'rss');
  assert.equal(ow.windowStrategyFor('b', osc, wp), null);
  assert.equal(ow.windowStrategyFor('c', osc, wp), 'listing-html');
  assert.equal(ow.windowStrategyFor('d', osc, wp), 'sitemap');
  assert.equal(ow.windowStrategyFor('e', osc, wp), 'wp-api');
  assert.equal(ow.windowStrategyFor('zzz', osc, wp), null);
});

test('selectWindowOutlets filters by market and reports skipped SERP outlets', () => {
  const win = [show('ob1', 'off-broadway', 1)];
  const shows = [...win, show('ob2', 'off-broadway', 20), show('bw1', 'broadway', 20), show('bw2', 'broadway', 25)];
  const rev = (outletId, showId) => ({ outletId, showId });
  const reviews = [
    rev('obFeed', 'ob1'), rev('obFeed', 'ob2'),
    rev('bwFeed', 'bw1'), rev('bwFeed', 'bw2'),
    rev('obSerp', 'ob1'), rev('obSerp', 'ob2'),
  ];
  const osc = { obFeed: { strategy: 'rss' }, bwFeed: { strategy: 'rss' }, obSerp: { strategy: 'serp' } };
  const r = ow.selectWindowOutlets({ windowShows: win, allShows: shows, allReviews: reviews, outletStrategyConfig: osc, wpApiConfig: {}, skipOutlets: new Set(), now: NOW });
  assert.deepEqual(r.outlets, ['obFeed']);
  assert.deepEqual(r.skippedSerp, ['obSerp']);
});

test('paid budget caps attempts and counts refusals', () => {
  const b = ow.createPaidBudget(2);
  assert.deepEqual([b.attempt(), b.attempt(), b.attempt()], [true, true, false]);
  assert.equal(b.used, 2);
  assert.equal(b.refused, 1);
  assert.equal(ow.DEFAULT_MAX_PAID, 15);
});

test('projected monthly cost at the cap stays under the $10 target', () => {
  const p = ow.projectMonthlyCost({ paidPerRun: ow.DEFAULT_MAX_PAID, activeRunsPerMonth: 8 * 30 });
  assert.ok(p.usd < 10, `worst case ${p.usd}`);
});

test('poller config: New York Sun has a free entry and new OB feeds are registered', () => {
  const c = poller.OUTLET_STRATEGY_CONFIG;
  assert.equal(c['new-york-sun'].strategy, 'listing-html');
  for (const id of ['londonpubtheatres', 'fringereview', 'stagebuddy', 'the-knockturnal', 'lighting-and-sound-america']) {
    assert.ok(ow.windowStrategyFor(id, c, poller.WP_API_CONFIG || {}), id);
  }
});

test('needsCollection / showsNeedingCollection pick stubs without text, skip scored or flagged', () => {
  const stub = { url: 'https://x.com/a', contentTier: 'stub' };
  assert.equal(ow.needsCollection(stub), true);
  assert.equal(ow.needsCollection({ ...stub, fullText: 'abc' }), false);
  assert.equal(ow.needsCollection({ ...stub, assignedScore: 70 }), false);
  assert.equal(ow.needsCollection({ ...stub, wrongShow: true }), false);
  assert.equal(ow.needsCollection({ ...stub, duplicateOf: 'z' }), false);
  assert.equal(ow.needsCollection({ contentTier: 'stub' }), false);
  const win = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const by = { a: [stub], b: [stub, stub, { ...stub, fullText: 'x' }], c: [{ ...stub, assignedScore: 80 }], d: [stub] };
  assert.deepEqual(ow.showsNeedingCollection(win, by, 2), ['b', 'a']);
  assert.deepEqual(ow.showsNeedingCollection([], by), []);
});
