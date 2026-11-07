// BRO-7076: census listing source for the daily outlet poller. Requires the real helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const census = require('../../scripts/lib/outlet-listing-census.js');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const SOURCES = {
  freeblog: { kind: 'wp-json', apiBase: 'https://example.test/wp-json/wp/v2/posts' },
  mapsite: { kind: 'sitemap', url: 'https://example.test/sitemap.xml' },
  gzsite: { kind: 'sitemap', url: 'https://example.test/sitemap.xml.gz' },
  paid: { kind: 'serp', domain: 'paid.test' },
};
const LONDON = { londonblog: { kind: 'wp-json', apiBase: 'https://example.uk/wp-json/wp/v2/posts' }, paid: { kind: 'wp-json', apiBase: 'https://x.test/wp' } };
const src = { sources: SOURCES, londonSources: LONDON };

test('serp-kind source is never used, even when the other table has a free one', () => {
  assert.equal(census.censusSourceFor('nytimes'), null);
  assert.equal(census.censusSourceFor('slantmagazine'), null);
  assert.equal(census.censusSourceFor('paid', { sources: SOURCES, londonSources: {} }), null);
  assert.equal(census.shouldUseCensus({ outletId: 'paid', hasFeed: false, lookbackDays: 60, ...src, sources: SOURCES, londonSources: {} }).use, false);
  assert.ok(!census.FREE_KINDS.has('serp'));
});

test('gzip sitemaps are skipped', () => assert.equal(census.censusSourceFor('gzsite', src), null));

test('an outlet with no feed gets census items', () => {
  const r = census.shouldUseCensus({ outletId: 'freeblog', hasFeed: false, lookbackDays: 60, now: NOW, env: {}, ...src });
  assert.deepEqual(r, { use: true, reason: 'no-feed' });
  assert.deepEqual(census.censusOnlyCandidates((id) => id === 'mapsite', src), ['freeblog', 'londonblog', 'paid']);
});

test('a stale feed falls back to census; a healthy full-span feed does not', () => {
  const stale = { newestFiltered: day(75), filteredCount: 3, newestAny: day(1), oldestAny: day(120) };
  assert.equal(census.shouldUseCensus({ outletId: 'freeblog', hasFeed: true, health: stale, latestReviewDate: day(2), lookbackDays: 60, now: NOW, env: {}, ...src }).reason, 'stale');
  const fine = { newestFiltered: day(1), filteredCount: 5, newestAny: day(1), oldestAny: day(120) };
  assert.equal(census.shouldUseCensus({ outletId: 'freeblog', hasFeed: true, health: fine, latestReviewDate: day(2), lookbackDays: 60, now: NOW, env: {}, ...src }).use, false);
  const short = { newestFiltered: day(1), filteredCount: 5, newestAny: day(1), oldestAny: day(3) };
  assert.equal(census.shouldUseCensus({ outletId: 'freeblog', hasFeed: true, health: short, latestReviewDate: day(2), lookbackDays: 60, now: NOW, env: {}, ...src }).reason, 'short-span');
  assert.equal(census.shouldUseCensus({ outletId: 'freeblog', hasFeed: true, health: { error: 'boom' }, lookbackDays: 60, now: NOW, env: {}, ...src }).reason, 'feed-error');
});

test('kill switch CENSUS_LISTING_DISABLED=1 turns it off', () => {
  assert.equal(census.isDisabled({ CENSUS_LISTING_DISABLED: '1' }), true);
  assert.equal(census.shouldUseCensus({ outletId: 'freeblog', hasFeed: false, lookbackDays: 60, env: { CENSUS_LISTING_DISABLED: '1' }, ...src }).use, false);
});

test('enumerateCensusItems reads a wp-json source through the injected fetcher', async () => {
  const calls = [];
  const posts = [{ link: 'https://example.test/jane-eyre-review/', date: day(3) + 'T10:00:00', title: { rendered: 'Jane Eyre review' }, excerpt: { rendered: '' } }];
  const items = await census.enumerateCensusItems('freeblog', new Date(NOW - 60 * 86400000), {
    sourceOverrides: src, log: () => {},
    fetchText: async (u) => { calls.push(u); return JSON.stringify(posts); },
  });
  assert.equal(calls.length, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].viaCensus, true);
  assert.match(items[0].headline, /Jane Eyre/);
  assert.deepEqual(await census.enumerateCensusItems('paid', new Date(NOW), { sourceOverrides: { sources: SOURCES, londonSources: {} }, fetchText: async () => { throw new Error('must not fetch'); } }), []);
});

test('slug stands in for a missing headline', () => {
  assert.equal(census.headlineFromUrl('https://x.test/reviews/jane-eyre-review_123'), 'jane eyre review');
});

const show = { id: 's', title: 'Hamlet', status: 'open', openingDate: day(20), previewsStartDate: day(30) };
const item = (headline, url, publishDate = day(10)) => ({ headline, url, publishDate });

test('false matches from the card are rejected', () => {
  assert.equal(census.censusItemAccepted(item('Hamlet photo release: first look at the cast', 'https://theatreweekly.test/news/hamlet-photos'), show), false);
  assert.equal(census.censusItemAccepted(item('Every Ghost Story Ever', 'https://x.test/every-ghost-story-ever'), { ...show, title: 'The Story' }), false);
  assert.equal(census.censusItemAccepted(item('Wicked Fridays review', 'https://x.test/wicked-fridays-review', day(300)), { ...show, title: 'Wicked', openingDate: '2021-01-01', previewsStartDate: '2020-12-20' }), false);
  assert.equal(census.censusItemAccepted(item('Theatre reviews round-up: this week', 'https://x.test/reviews-round-up'), show), false);
  assert.equal(census.censusItemAccepted(item('What the critics say about Hamlet', 'https://x.test/hamlet-review'), show), false);
});

test('a real review inside the run window is accepted', () => {
  assert.equal(census.censusItemAccepted(item('Hamlet review', 'https://x.test/hamlet-review'), show), true);
});

test('census title-led match: distinctive multi-word title in the slug, nothing else in the pool', () => {
  const mdq = { id: 'mdq', title: 'Million Dollar Quartet', status: 'open' };
  const other = { id: 'other', title: 'Hamlet', status: 'open' };
  const pool = [mdq, other];
  const it = { url: 'https://x.test/2026/09/review-million-dollar-quartet-arts-at-marble-arch/', headline: 'review million dollar quartet arts at marble arch', publishDate: day(3) };
  assert.equal(census.censusTitleOnly(it, mdq, pool), true);
  // one-word titles are too ambiguous for a slug-only match
  assert.equal(census.censusTitleOnly({ url: 'https://x.test/review-hamlet-globe/', headline: 'review hamlet globe', publishDate: day(3) }, other, pool), false);
  // a second show spelled in the same slug blocks it
  const both = { id: 'b', title: 'Pride and Prejudice', status: 'open' };
  const two = { url: 'https://x.test/review-million-dollar-quartet-pride-and-prejudice/', headline: '', publishDate: day(3) };
  assert.equal(census.censusTitleOnly(two, mdq, [mdq, both]), false);
});

test('censusTitleOnly refuses an undated item, and a malformed % slug does not throw', () => {
  const mdq = { id: 'a', title: 'Million Dollar Quartet', status: 'open' };
  const undated = { url: 'https://x.test/2019/review-million-dollar-quartet-arts/', headline: '' };
  assert.equal(census.censusTitleOnly(undated, mdq, [mdq]), false);
  assert.doesNotThrow(() => census.headlineFromUrl('https://x.test/review-100%-sure-show/'));
});

// BRO-7083: write-mode caps.
test('censusItemMode: report-only unless write; dry-run always wins; add cap returns to report-only', () => {
  const m = census.censusItemMode;
  assert.deepEqual(m({ viaCensus: true, censusWrite: false, dryRun: false }), { censusDry: true, itemDry: true, capped: false });
  assert.equal(m({ viaCensus: true, censusWrite: true, dryRun: true, added: 0, maxAdds: 40 }).itemDry, true);
  assert.equal(m({ viaCensus: true, censusWrite: true, dryRun: false, added: 39, maxAdds: 40 }).itemDry, false);
  const capped = m({ viaCensus: true, censusWrite: true, dryRun: false, added: 40, maxAdds: 40 });
  assert.equal(capped.itemDry, true); assert.equal(capped.capped, true);
  // feed items are untouched by the census flags
  assert.equal(m({ viaCensus: false, censusWrite: false, dryRun: false }).itemDry, false);
  assert.equal(m({ viaCensus: false, censusWrite: true, dryRun: true }).itemDry, true);
});

test('makeCensusFetcher: plain first, paid only within the run-wide budget', async () => {
  const good = 'x'.repeat(2500);
  let paidCalls = 0;
  const { fetcher, stats } = census.makeCensusFetcher({
    plain: async (u) => (u.includes('ok') ? good : (u.includes('short') ? 'tiny' : Promise.reject(new Error('403')))),
    paid: async () => { paidCalls++; return good; },
    maxPaid: 2,
  });
  assert.equal(await fetcher('https://a.test/ok'), good);
  assert.equal(paidCalls, 0);
  assert.equal(await fetcher('https://a.test/blocked1'), good);
  assert.equal(await fetcher('https://a.test/blocked2'), good);
  assert.equal(paidCalls, 2);
  await assert.rejects(fetcher('https://a.test/blocked3'), /budget exhausted/);
  // over budget a weak plain page is NOT returned: PAID_BUDGET makes confirmOnPage retry next run
  await assert.rejects(fetcher('https://a.test/short'), (e) => e.code === 'PAID_BUDGET');
  assert.equal(paidCalls, 2);
  assert.deepEqual(stats, { paid: 2, paidRefused: 2 });
  // looksRight failing on a plain page also needs the paid path
  const f2 = census.makeCensusFetcher({ plain: async () => good, paid: async () => 'paid', maxPaid: 1 });
  assert.equal(await f2.fetcher('u', () => false), 'paid');
});

test('BRO-7083: a shortened two-word title form ("Double Bill") does not prove a title-led match', () => {
  const db = { id: 'db', title: 'Double Bill: Tell Me Straight & Aggy', status: 'open' };
  const firebird = { url: 'https://theatreweekly.com/review-firebird-a-double-bill-at-sadlers-wells-theatre/', headline: '', publishDate: day(3) };
  assert.equal(census.censusTitleOnly(firebird, db, [db]), false);
  // the full title in the slug still matches
  const own = { url: 'https://x.test/review-double-bill-tell-me-straight-and-aggy-kings-head/', headline: '', publishDate: day(3) };
  assert.equal(census.censusTitleOnly(own, db, [db]), true);
  // a three-word shortened form still counts (Jane Eyre style prefixes need 3+ words)
  const ltl = { id: 'ltl', title: 'Larger Than Life: Starring Wallace and Gromit', status: 'open' };
  assert.equal(census.censusTitleOnly({ url: 'https://x.test/post/review-larger-than-life-lightroom', headline: '', publishDate: day(3) }, ltl, [ltl]), true);
});

test('BRO-7083: censusMarketOk keeps a London-only outlet off New York shows and vice versa', () => {
  const sources = { 'nyc-only': {}, both: {} };
  const londonSources = { 'london-only': {}, both: {} };
  const opt = { sources, londonSources };
  const ny = { id: 'tom-at-the-farm-off-broadway-2026', market: 'broadway' };
  const ldn = { id: 'x-off-west-end-2026', market: 'west-end' };
  const reg = { id: 'y-regional-2026', market: 'regional' };
  assert.equal(census.censusMarketOk('london-only', ny, opt), false);
  assert.equal(census.censusMarketOk('london-only', ldn, opt), true);
  assert.equal(census.censusMarketOk('nyc-only', ldn, opt), false);
  assert.equal(census.censusMarketOk('nyc-only', ny, opt), true);
  assert.equal(census.censusMarketOk('both', ny, opt), true);
  assert.equal(census.censusMarketOk('london-only', reg, opt), true);
  // the real source tables: everything-theatre is London-only, exeunt-magazine New York-only
  assert.equal(census.censusMarketOk('everything-theatre', ny), false);
  assert.equal(census.censusMarketOk('exeunt-magazine', ny), true);
});
