// BRO-6872 (holdout baseline, Billy Crystal 860): the lane reached DTLI and BWW only through their homepages, so a
// show that had scrolled off them was unreachable, and NY Stage Review's own feed item was dropped because its
// headline had no review word. These pin the fallbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const { ALL_FEEDS } = require('../../scripts/lib/rss-discovery.js');

const SHOW = { id: 'billy-crystal-860-2026', title: '860', openingDate: '2026-10-21', category: 'broadway' };
const NYT = 'https://www.nytimes.com/2026/10/21/theater/860-review-billy-crystal.html';
const NYT_KEY = d.canonicalUrl(NYT);
const fetchFrom = (map) => async (u) => { if (!(u in map)) throw new Error(`404 ${u}`); return map[u]; };

const dated = (iso, body = '') => `<script type="application/ld+json">{"@type":"WebPage","datePublished":"${iso}"}</script>${body}`;
const DTLI_INDEX = 'https://didtheylikeit.com/sitemap_index.xml';
const DTLI_SM1 = 'https://didtheylikeit.com/shows-sitemap1.xml';
const sitemap = (...slugs) => `<urlset>${slugs.map((x) => `<url><loc>https://didtheylikeit.com/shows/${x}/</loc></url>`).join('')}</urlset>`;
const cite = `<article><div class="review-item"><p>A crowd-pleaser from start to finish, says the paper.</p><a href="${NYT}">READ THE REVIEW</a></div></article>`;

test('DTLI: a show missing from the homepage is found through DTLI\'s sitemap when its page is dated at this opening', async () => {
  const showPage = 'https://didtheylikeit.com/shows/860/';
  const map = {
    'https://didtheylikeit.com/': '<a href="https://didtheylikeit.com/shows/another-show/">Another</a>',
    [DTLI_INDEX]: `<sitemapindex><sitemap><loc>${DTLI_SM1}</loc></sitemap></sitemapindex>`,
    [DTLI_SM1]: sitemap('860', 'another-show'),
    [showPage]: dated('2026-10-22T04:00:00+00:00', cite),
  };
  const out = await d.dtliAdapter().discover({ show: SHOW, fetchText: fetchFrom(map) });
  assert.deepEqual(out.map((c) => c.url), [NYT_KEY]);
  assert.equal(out[0].via, showPage);
});

test('DTLI: a revival takes the "-2" page dated at its opening, never the original production\'s page', async () => {
  const odc = { id: 'other-desert-cities-2026', title: 'Other Desert Cities', openingDate: '2026-10-18', category: 'broadway' };
  const base = {
    'https://didtheylikeit.com/': '',
    [DTLI_INDEX]: `<sitemapindex><sitemap><loc>${DTLI_SM1}</loc></sitemap></sitemapindex>`,
    'https://didtheylikeit.com/shows/other-desert-cities/': dated('2011-11-04T04:00:00+00:00', cite),
  };
  // Before DTLI posts the revival's page: only the 2011 page exists, and it is refused.
  const before = await d.dtliAdapter().discover({ show: odc, fetchText: fetchFrom({ ...base, [DTLI_SM1]: sitemap('other-desert-cities') }) });
  assert.deepEqual(before, []);
  // Once it is posted, the "-2" page is taken.
  const after = await d.dtliAdapter().discover({ show: odc, fetchText: fetchFrom({ ...base, [DTLI_SM1]: sitemap('other-desert-cities', 'other-desert-cities-2'), 'https://didtheylikeit.com/shows/other-desert-cities-2/': dated('2026-10-19T05:13:37+00:00', cite) }) });
  assert.deepEqual(after.map((c) => c.via), ['https://didtheylikeit.com/shows/other-desert-cities-2/']);
});

test('DTLI: a failed sitemap index does not probe the numbered sitemaps', async () => {
  const asked = [];
  const fetchText = async (u) => { asked.push(u); if (u === 'https://didtheylikeit.com/') return ''; throw new Error('404'); };
  assert.deepEqual(await d.dtliAdapter().discover({ show: SHOW, fetchText }), []);
  assert.deepEqual(asked.filter((u) => /shows-sitemap\d/.test(u)), []);
});

test('DTLI: a sitemap miss is not asked again every pass, and a dated hit is kept', async () => {
  let calls = 0;
  const adapter = d.dtliAdapter({ findInSitemap: async () => { calls++; return []; } });
  const fetchText = fetchFrom({ 'https://didtheylikeit.com/': '' });
  for (let i = 0; i < 4; i++) assert.deepEqual(await adapter.discover({ show: SHOW, fetchText }), []);
  assert.equal(calls, 1, 'one sitemap read for four passes');
  for (let i = 0; i < 2; i++) await adapter.discover({ show: SHOW, fetchText });
  assert.equal(calls, 2, 'asked again after the retry interval');

  let hits = 0;
  const page = 'https://didtheylikeit.com/shows/860/';
  const found = d.dtliAdapter({ findInSitemap: async () => { hits++; return [page]; } });
  const f2 = fetchFrom({ 'https://didtheylikeit.com/': '', [page]: dated('2026-10-21T23:00:00-04:00') });
  await found.discover({ show: SHOW, fetchText: f2 });
  await found.discover({ show: SHOW, fetchText: f2 });
  assert.equal(hits, 1);
});

test('DTLI: a sitemap page dated at another opening is not fetched again; an undated one is retried', async () => {
  const old = 'https://didtheylikeit.com/shows/860/';
  const blank = 'https://didtheylikeit.com/shows/860-3/';
  const asked = []; let lookups = 0;
  const adapter = d.dtliAdapter({ findInSitemap: async () => { lookups++; return [old, blank]; } });
  const base = fetchFrom({ 'https://didtheylikeit.com/': '', [old]: dated('2011-11-04T02:00:00Z'), [blank]: '<p>Just a moment...</p>' });
  const fetchText = async (u) => { asked.push(u); return base(u); };
  for (let i = 0; i < 11; i++) await adapter.discover({ show: SHOW, fetchText });
  assert.equal(lookups, 3, 'three sitemap reads in eleven passes');
  assert.equal(asked.filter((u) => u === old).length, 1, 'the page dated in 2011 is fetched once');
  assert.equal(asked.filter((u) => u === blank).length, 3, 'the undated page is tried on every sitemap read');
});

test('DTLI: refused pages free the fetch cap for later sitemap pages', async () => {
  const olds = [1, 2, 3, 4].map((n) => `https://didtheylikeit.com/shows/old-${n}/`);
  const right = 'https://didtheylikeit.com/shows/860-2/';
  const map = { 'https://didtheylikeit.com/': '', [right]: dated('2026-10-21T23:00:00-04:00') };
  for (const u of olds) map[u] = dated('2011-11-04T02:00:00Z');
  const asked = [];
  const base = fetchFrom(map);
  const adapter = d.dtliAdapter({ findInSitemap: async () => [...olds, right] });
  for (let i = 0; i < 6; i++) await adapter.discover({ show: SHOW, fetchText: async (u) => { asked.push(u); return base(u); } });
  assert.ok(asked.includes(right), 'the fifth page is reached on the next sitemap read');
});

test('DTLI: a failing sitemap is a quiet miss, not an adapter error', async () => {
  const out = await d.dtliAdapter().discover({ show: SHOW, fetchText: fetchFrom({ 'https://didtheylikeit.com/': '' }) });
  assert.deepEqual(out, []);
});

test('pageDatedNear: within 7 days of opening only; undated pages and missing openings fail', () => {
  assert.equal(d.pageDatedNear(dated('2026-10-22T02:00:00Z'), '2026-10-21'), true);
  assert.equal(d.pageDatedNear(dated('2026-10-30T02:00:00Z'), '2026-10-21'), false);
  assert.equal(d.pageDatedNear(dated('2011-11-04T02:00:00Z'), '2026-10-21'), false);
  assert.equal(d.pageDatedNear('<p>no date</p>', '2026-10-21'), false);
  assert.equal(d.pageDatedNear(dated('2026-10-22T02:00:00Z'), null), false);
});

test('BWW: a show missing from the homepage falls back to its stored roundup URL only when that page is dated at this opening', async () => {
  const roundup = 'https://www.broadwayworld.com/article/Review-Roundup-Billy-Crystal-Returns-to-Broadway-in-860-20261021';
  const body = `<div class="disnep-area"><p>Critic, <a href="${NYT}">The New York Times:</a> A crowd-pleaser from start to finish.</p></div>`;
  const home = { 'https://www.broadwayworld.com/': '<a href="https://www.broadwayworld.com/article/Something-Else-20261101">x</a>' };
  const ok = await d.bwwRoundupAdapter().discover({ show: { ...SHOW, bwwRoundupUrl: roundup }, fetchText: fetchFrom({ ...home, [roundup]: dated('2026-10-21T23:30:00-04:00', body) }) });
  assert.deepEqual(ok.map((c) => c.url), [NYT_KEY]);
  // Another production's roundup stored on this show (a copied record): refused, and not fetched again next pass.
  const other = 'https://www.broadwayworld.com/article/Review-Roundup-TWO-GIRLS-at-the-Cherry-Lane-Theatre-20231023';
  let fetches = 0;
  const adapter = d.bwwRoundupAdapter();
  const f = async (u) => { if (u === other) fetches++; return fetchFrom({ ...home, [other]: dated('2023-10-23T23:30:00-04:00', body) })(u); };
  assert.deepEqual(await adapter.discover({ show: { ...SHOW, bwwRoundupUrl: other }, fetchText: f }), []);
  assert.deepEqual(await adapter.discover({ show: { ...SHOW, bwwRoundupUrl: other }, fetchText: f }), []);
  assert.equal(fetches, 1);
  assert.deepEqual(await d.bwwRoundupAdapter().discover({ show: { ...SHOW, bwwRoundupUrl: 'https://evil.example/x' }, fetchText: fetchFrom(home) }), []);
  assert.deepEqual(await d.bwwRoundupAdapter().discover({ show: SHOW, fetchText: fetchFrom(home) }), []);
});

const NYSR_FEED = 'https://nystagereview.com/feed/';
const NYSR_ITEM = 'https://nystagereview.com/2026/10/21/860-billy-crystal-brings-down-the-house/';
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>860: Billy Crystal brings down the house</title><link>${NYSR_ITEM}</link><pubDate>Wed, 22 Oct 2026 02:00:00 +0000</pubDate></item>
<item><title>860 at the Ethel Barrymore</title><link>https://elsewhere.example/860-ethel-barrymore/</link><pubDate>Wed, 22 Oct 2026 02:00:00 +0000</pubDate></item>
</channel></rss>`;

test('a reviews-only feed vouches for its own items; off-host links and ordinary feeds do not', async () => {
  const nysr = d.defaultLaneFeeds(SHOW).find((f) => f.url === NYSR_FEED);
  assert.equal(nysr && nysr.reviewsOnly, true, 'NY Stage Review is a reviews-only feed');
  const out = await d.rssAdapter({ feeds: [nysr] }).discover({ show: SHOW, fetchText: fetchFrom({ [NYSR_FEED]: FEED }) });
  const own = out.find((c) => c.url === NYSR_ITEM);
  assert.equal(own.reviewSignalGiven, true);
  assert.equal(own.outletId, 'nysr');
  assert.equal(out.find((c) => c.url !== NYSR_ITEM).reviewSignalGiven, undefined);
  const plain = await d.rssAdapter({ feeds: [{ ...nysr, reviewsOnly: undefined }] }).discover({ show: SHOW, fetchText: fetchFrom({ [NYSR_FEED]: FEED }) });
  assert.equal(plain.find((c) => c.url === NYSR_ITEM).reviewSignalGiven, undefined);
});

test('reviewsOnly is set only on feeds that carry nothing but reviews', () => {
  const flagged = ALL_FEEDS.filter((f) => f.reviewsOnly).map((f) => f.outletId).sort();
  assert.deepEqual(flagged, ['broadwaynews', 'exeunt-magazine', 'nysr']);
});

test('end to end: the NY Stage Review item is admitted, not rejected as not review-like', async () => {
  const nysr = d.defaultLaneFeeds(SHOW).find((f) => f.url === NYSR_FEED);
  const T0 = Date.parse('2026-10-22T01:00:00Z');
  const r = await d.runDiscoveryPass({ show: SHOW, night: SHOW.openingDate, now: T0 + 3600e3, startedAt: T0, adapters: [d.rssAdapter({ feeds: [nysr] })], fetchText: fetchFrom({ [NYSR_FEED]: FEED, [NYSR_ITEM]: '<html></html>' }) });
  assert.ok(!r.rejected.some((x) => /nystagereview/.test(x.url || x.key || '') && x.reason === 'not-review-like'), JSON.stringify(r.rejected));
  assert.ok(r.admitted.some((a) => /nystagereview\.com/.test(a.url)), JSON.stringify(r));
});

// Google News (billy-crystal-860-2026 shadow runs 41562664962 and the 8-min run before it): Time Out and TheaterMania
// file reviews under /news/, and the unwrap dropped them without a recorded reason. A Google News item is already tied
// to a registry outlet by its <source url>, the same vetting the regular pipeline needs before it accepts /news/.
const GN_ITEMS = [
  ['Broadway review: Billy Crystal in 860 - Time Out New York', 'https://www.timeout.com', 'https://www.timeout.com/newyork/news/broadway-review-billy-crystal-in-860-102226'],
  ["Review: 860, Billy Crystal's one-man show - TheaterMania", 'https://www.theatermania.com', 'https://www.theatermania.com/news/review-860-billy-crystals-one-man-show'],
  ['860 Broadway Review: Billy Crystal - New York Theatre Guide', 'https://www.newyorktheatreguide.com', 'https://www.newyorktheatreguide.com/reviews/860-broadway-review-billy-crystal'],
  ['860 review roundup: what the critics said - TheaterMania', 'https://www.theatermania.com', 'https://www.theatermania.com/news/860-broadway-review-roundup'],
  ['Billy Crystal 860 extends at the Barrymore - TheaterMania', 'https://www.theatermania.com', 'https://www.theatermania.com/news/860-extends-at-the-barrymore'],
];
const gnRss = (items) => `<rss><channel>${items.map((x, i) => `<item><title>${x[0]}</title><link>https://news.google.com/rss/articles/W${i}</link><pubDate>Thu, 23 Oct 2026 02:00:00 GMT</pubDate><source url="${x[1]}">s</source></item>`).join('')}</channel></rss>`;
const gnFetch = (items) => async (u) => {
  if (u.includes('/rss/search')) return gnRss(items);
  const m = u.match(/rss\/articles\/W(\d+)/);
  if (m) return { content: '<html></html>', finalUrl: items[Number(m[1])][2] };
  return '<html></html>';
};

test('google news: /news/ reviews from registry outlets are admitted; a /news/ roundup is rejected with a reason; a non-review story is not admitted', async () => {
  const T = Date.parse('2026-10-23T03:00:00Z');
  const r = await d.runDiscoveryPass({ show: SHOW, night: SHOW.openingDate, now: T, startedAt: T - 2 * 3600e3, adapters: [d.googleNewsAdapter({ now: () => T })], fetchText: gnFetch(GN_ITEMS) });
  const admitted = r.admitted.map((a) => d.canonicalUrl(a.url)).sort();
  assert.deepEqual(admitted, GN_ITEMS.slice(0, 3).map((x) => d.canonicalUrl(x[2])).sort(), JSON.stringify(r.rejected));
  assert.ok(!admitted.some((u) => /roundup|extends/.test(u)));
  assert.ok(r.rejected.some((x) => /roundup/.test(x.url) && x.reason), 'the roundup is rejected with a recorded reason, not dropped silently');
});

test('vettedOutlet opens /news/ only for a review slug; other news, roundups and unvetted finds stay refused', () => {
  const tm = 'https://www.theatermania.com/news/review-860-billy-crystals-one-man-show';
  assert.equal(d.nonReviewReason(tm), 'non-review-path');
  assert.equal(d.nonReviewReason(tm, { vettedOutlet: true }), null);
  assert.equal(d.nonReviewReason('https://www.theatermania.com/news/860-extends-at-the-barrymore', { vettedOutlet: true }), 'non-review-path');
  assert.equal(d.nonReviewReason('https://www.theatermania.com/news/860-broadway-review-roundup', { vettedOutlet: true }), 'non-review-path');
});

test('vettedOutlet: only a slug that leads with the review opens /news/ ("week-in-review" and "responds-to-review" do not)', () => {
  assert.equal(d.nonReviewReason('https://www.theatermania.com/news/week-in-review-860', { vettedOutlet: true }), 'non-review-path');
  assert.equal(d.nonReviewReason('https://www.theatermania.com/news/crystal-responds-to-review', { vettedOutlet: true }), 'non-review-path');
  assert.equal(d.nonReviewReason('https://www.timeout.com/newyork/news/broadway-review-billy-crystal-in-860-102226', { vettedOutlet: true }), null);
  // The aggregator-cited rule is unchanged.
  assert.equal(d.nonReviewReason('https://www.theatermania.com/news/crystal-responds-to-review', { aggregatorCited: true }), null);
});

test('a /news/ review an RSS feed rejected first is judged again when Google News finds it vetted', async () => {
  const tm = GN_ITEMS[1][2];
  const memo = { rejected: { [d.canonicalUrl(tm)]: { reason: 'non-review-path', attempts: 3 } } };
  const T = Date.parse('2026-10-23T03:00:00Z');
  const r = await d.runDiscoveryPass({ show: SHOW, night: SHOW.openingDate, now: T, startedAt: T - 2 * 3600e3, memo, adapters: [d.googleNewsAdapter({ now: () => T })], fetchText: gnFetch(GN_ITEMS.slice(0, 2)) });
  assert.ok(r.admitted.some((a) => d.canonicalUrl(a.url) === d.canonicalUrl(tm)), JSON.stringify(r));
  // An unvetted sighting of the same URL still stands rejected.
  const plain = { name: 'rss', phase: 'cheap', discover: async () => [{ url: tm, title: "Review: 860, Billy Crystal's one-man show", source: 'outlet-index' }] };
  const memo2 = { rejected: { [d.canonicalUrl(tm)]: { reason: 'non-review-path', attempts: 1 } } };
  const r2 = await d.runDiscoveryPass({ show: SHOW, night: SHOW.openingDate, now: T, startedAt: T - 2 * 3600e3, memo: memo2, adapters: [plain], fetchText: async () => '<html></html>' });
  assert.deepEqual(r2.admitted, []);
});

test('unwrap: a single publisher anchor beats a refused landed URL; the refused review-worded URL is only the last resort', () => {
  const src = 'https://www.theatermania.com';
  const article = 'https://www.theatermania.com/reviews/860-billy-crystal';
  const landedTag = 'https://www.theatermania.com/tag/860-review';
  assert.equal(d.publisherUrlFromWrapperPage(`<a href="${article}">x</a>`, src, landedTag, { vettedOutlet: true }), article);
  assert.equal(d.publisherUrlFromWrapperPage('', src, landedTag, { vettedOutlet: true }), landedTag);
  assert.equal(d.publisherUrlFromWrapperPage('', src, 'https://www.theatermania.com/account/login', { vettedOutlet: true }), null);
});

test('google news: a never-tried wrapper is opened before a retry of a failed one (budget rotates through the feed)', async () => {
  const xml = gnRss(GN_ITEMS.slice(0, 3));
  const opened = [];
  const fetchText = async (url) => {
    if (url.includes('/rss/search')) return xml;
    opened.push(url);
    return { content: '', finalUrl: null }; // every unwrap fails
  };
  const ad = d.googleNewsAdapter({ maxUnwrap: 1, now: () => Date.parse('2026-10-23T03:00:00Z') });
  for (let i = 0; i < 3; i++) await ad.discover({ show: SHOW, fetchText });
  assert.equal(new Set(opened).size, 3, `each pass should open a new wrapper first: ${opened.join(' ')}`);
  // Once every wrapper has been tried, retries resume (none is starved for good).
  await ad.discover({ show: SHOW, fetchText });
  assert.equal(opened.length, 4);
  assert.ok(opened.slice(0, 3).includes(opened[3]));
});
