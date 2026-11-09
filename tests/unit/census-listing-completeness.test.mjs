// BRO-7163 F13/F03: a listing read says whether it was complete, and a healthy feed does not
// switch the listing off for good. Requires the real helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const census = require('../../scripts/lib/outlet-listing-census.js');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const cutoff = new Date(NOW - 14 * 86400000);
const sources = { wp: { kind: 'wp-json', apiBase: 'https://e.test/wp-json/wp/v2/posts' }, sm: { kind: 'sitemap', url: 'https://e.test/sitemap_index.xml', urlFilter: /e\.test\/p\// } };
const o = { sources, londonSources: {} };
const post = (i) => ({ link: `https://e.test/p/show-${i}-review/`, date: day(2) + 'T10:00:00', title: { rendered: `Show ${i} review` }, excerpt: { rendered: '' } });

test('F13: wp page-8 cap is reported incomplete', async () => {
  const r = await census.enumerateCensusItemsDetailed('wp', cutoff, { sourceOverrides: o, log: () => {},
    fetchText: async (u) => JSON.stringify(Array.from({ length: 100 }, (_, i) => post(`${new URL(u).searchParams.get('page')}-${i}`))) });
  assert.equal(r.complete, false);
  assert.match(r.capped[0], /8 full pages/);
});

test('F13: a later wp page failure is reported incomplete, page 1 data kept', async () => {
  const r = await census.enumerateCensusItemsDetailed('wp', cutoff, { sourceOverrides: o, log: () => {},
    fetchText: async (u) => { if (new URL(u).searchParams.get('page') === '2') throw new Error('boom'); return JSON.stringify(Array.from({ length: 100 }, (_, i) => post(i))); } });
  assert.equal(r.complete, false);
  assert.equal(r.items.length, 100);
  assert.match(r.failed[0], /wp page 2/);
});

test('F13: sitemap child failure and >40 children are reported', async () => {
  const kids = Array.from({ length: 45 }, (_, i) => `https://e.test/review-sitemap${i}.xml`);
  const idx = `<sitemapindex>${kids.map((k) => `<loc>${k}</loc>`).join('')}</sitemapindex>`;
  const r = await census.enumerateCensusItemsDetailed('sm', cutoff, { sourceOverrides: o, log: () => {},
    fetchText: async (u) => { if (u.endsWith('sitemap_index.xml')) return idx; if (u.endsWith('review-sitemap3.xml')) throw new Error('503'); return '<urlset></urlset>'; } });
  assert.equal(r.complete, false);
  assert.ok(r.capped.some((x) => /5 of 45/.test(x)));
  assert.ok(r.failed.some((x) => /review-sitemap3/.test(x)));
});

test('F13: a clean read is complete; legacy wrapper still returns the array', async () => {
  const deps = { sourceOverrides: o, log: () => {}, fetchText: async () => JSON.stringify([post(1)]) };
  assert.equal((await census.enumerateCensusItemsDetailed('wp', cutoff, deps)).complete, true);
  assert.equal((await census.enumerateCensusItems('wp', cutoff, deps)).length, 1);
});

test('F13: review-named child preference reports skipped generic children unless the source filters to reviews', async () => {
  const idx = '<sitemapindex><loc>https://e.test/reviews-sitemap.xml</loc><loc>https://e.test/post-sitemap1.xml</loc></sitemapindex>';
  const fetchText = async (u) => (u.endsWith('sitemap_index.xml') ? idx : '<urlset></urlset>');
  const r = await census.enumerateCensusItemsDetailed('sm', cutoff, { sourceOverrides: o, log: () => {}, fetchText });
  assert.equal(r.complete, false);
  assert.match(r.partial[0], /1 non-review/);
});

test('F03: a healthy, long-span feed is still reconciled against the listing on a rotation', () => {
  const fine = { newestFiltered: day(1), filteredCount: 10, newestAny: day(1), oldestAny: day(30) };
  const reasons = new Set();
  for (let d = 0; d < census.RECONCILE_EVERY_DAYS * 16; d++) {
    reasons.add(census.shouldUseCensus({ outletId: 'wp', hasFeed: true, health: fine, latestReviewDate: day(2), lookbackDays: 14, now: NOW + d * 10800000, env: {}, ...o }).reason);
  }
  assert.ok(reasons.has('reconcile'), 'listing never read while the feed looks healthy');
  assert.ok(reasons.has('none'), 'must not read every day');
});

test('F03: every outlet is reconciled in exactly one 3h slot per RECONCILE_EVERY_DAYS days (not all day)', () => {
  for (const id of ['a', 'exeunt-magazine', 'all-that-dazzles-uk', 'thestage']) {
    const hits = Array.from({ length: census.RECONCILE_EVERY_DAYS * 8 }, (_, d) => census.reconcileDue(id, NOW + d * 10800000)).filter(Boolean).length;
    assert.equal(hits, 1, id);
  }
});

test('kill switch reports disabled, not "none"', () => {
  assert.equal(census.shouldUseCensus({ outletId: 'wp', hasFeed: false, lookbackDays: 14, env: { CENSUS_LISTING_DISABLED: '1' }, ...o }).reason, 'disabled');
});
