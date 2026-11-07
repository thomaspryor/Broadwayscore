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
  const it = { url: 'https://x.test/2026/09/review-million-dollar-quartet-arts-at-marble-arch/', headline: 'review million dollar quartet arts at marble arch' };
  assert.equal(census.censusTitleOnly(it, mdq, pool), true);
  // one-word titles are too ambiguous for a slug-only match
  assert.equal(census.censusTitleOnly({ url: 'https://x.test/review-hamlet-globe/', headline: 'review hamlet globe' }, other, pool), false);
  // a second show spelled in the same slug blocks it
  const both = { id: 'b', title: 'Pride and Prejudice', status: 'open' };
  const two = { url: 'https://x.test/review-million-dollar-quartet-pride-and-prejudice/', headline: '' };
  assert.equal(census.censusTitleOnly(two, mdq, [mdq, both]), false);
});
