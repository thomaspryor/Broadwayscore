import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// No live core data in the blocking batch (BRO-7101): an empty shows.json fixture.
process.on('exit', require('./shows-json-fixture.js').useShowsFixture([]));
const { selectApplicableSiteSearchOutlets, SITE_SEARCH_ENDPOINTS } = require('./site-search-discovery.js');

test('BRO-5617: both site-search branches reject producer news and retain reviews', async (t) => {
  const { searchOutletSite } = require('./site-search-discovery.js');
  const { createServer } = require('node:http');
  const { once } = require('node:events');
  const news = 'https://nypost.com/2026/10/14/scooter-braun-and-todrick-hall-join-forces-to-produce-star-studded-off-broadway-musical-midnight-to-rave-reviews/';
  const review = 'https://nypost.com/2026/10/14/midnight-review-a-rave-for-the-musical/';
  const original = SITE_SEARCH_ENDPOINTS.nypost;
  t.after(() => { SITE_SEARCH_ENDPOINTS.nypost = original; });

  const server = createServer((_req, res) => {
    res.end([news, review, news].map(url => `<a href="${url}">Article</a>`).join(''));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())));

  SITE_SEARCH_ENDPOINTS.nypost = { ...original, url: `http://127.0.0.1:${server.address().port}/` };
  assert.deepEqual((await searchOutletSite('nypost', 'Midnight')).map(r => r.url), [review]);

  for (const skipUrlFilter of [false, true]) {
    SITE_SEARCH_ENDPOINTS.nypost = {
      ...original,
      skipUrlFilter,
      fetchAndParse: async () => [news, { url: review }, news],
    };
    assert.deepEqual((await searchOutletSite('nypost', 'Midnight')).map(r => r.url), [review]);
  }
});

// Regression coverage for #767: gather-reviews.js never invoked the site-search arm,
// so Telegraph/Variety/The Stage/Independent/Parterre discovery only ran inside
// opening-night-poller.js. This exercises the selection logic gather-reviews.js's
// STEP 1c now uses, against the real SITE_SEARCH_ENDPOINTS registry (no mocks).

test('broadway market returns broadway-only + market-agnostic outlets, excludes west-end-only', () => {
  const ids = selectApplicableSiteSearchOutlets('broadway', { id: 'some-show', type: 'play' }, new Set());
  assert.ok(ids.includes('nypost'), 'nypost is broadway-scoped, should be included');
  assert.ok(ids.includes('vulture'), 'vulture has no market restriction, should be included');
  assert.ok(!ids.includes('whatsonstage'), 'whatsonstage is west-end-scoped, must not fire on Broadway shows');
  assert.ok(!ids.includes('times-uk'), 'times-uk is west-end-scoped, must not fire on Broadway shows');
});

test('west-end market returns Telegraph/WhatsOnStage/The Stage, excludes broadway-only', () => {
  const ids = selectApplicableSiteSearchOutlets('west-end', { id: 'some-we-show', type: 'play' }, new Set());
  assert.ok(ids.includes('telegraph'), 'telegraph should be searchable for West End shows (#720/#767)');
  assert.ok(ids.includes('whatsonstage'), 'whatsonstage should be searchable for West End shows');
  assert.ok(ids.includes('times-uk'), 'times-uk should be searchable for West End shows');
  assert.ok(!ids.includes('nypost'), 'nypost is broadway-scoped, must not fire on West End shows');
});

test('already-found outlets are excluded via their EFFECTIVE id (outletIdOverride)', () => {
  // 'vulture-opera' overrides to canonical 'vulture' — if an aggregator already found
  // vulture, the sibling endpoint must not re-fire either. (telegraph-search used to
  // carry this test; it is disabled since BRO-6898, so use the live registry sibling.)
  const opera = { id: 'x', type: 'opera' };
  const withoutFound = selectApplicableSiteSearchOutlets('broadway', opera, new Set());
  assert.ok(withoutFound.includes('vulture-opera'), 'positive control: sibling fires when nothing is found');

  const withFound = selectApplicableSiteSearchOutlets('broadway', opera, new Set(['vulture']));
  assert.ok(!withFound.includes('vulture'), 'canonical vulture must be excluded once found');
  assert.ok(!withFound.includes('vulture-opera'), 'sibling vulture-opera must also be excluded once vulture is found');
});

test('opera-gated outlets only fire when applies(show) passes', () => {
  const nonOpera = selectApplicableSiteSearchOutlets('broadway', { id: 'x', type: 'play' }, new Set());
  const opera = selectApplicableSiteSearchOutlets('broadway', { id: 'x', type: 'opera' }, new Set());
  const gatedIds = Object.keys(SITE_SEARCH_ENDPOINTS).filter(id => typeof SITE_SEARCH_ENDPOINTS[id].applies === 'function');
  assert.ok(gatedIds.length > 0, 'sanity: registry has at least one applies()-gated outlet');
  for (const id of gatedIds) {
    assert.ok(!nonOpera.includes(id), `${id} is applies()-gated and must not fire for a non-opera show`);
  }
});

test('includeJs=false restricts to SSR-only endpoints (cost-free layer)', () => {
  const all = selectApplicableSiteSearchOutlets('broadway', { id: 'x', type: 'play' }, new Set(), true);
  const ssrOnly = selectApplicableSiteSearchOutlets('broadway', { id: 'x', type: 'play' }, new Set(), false);
  const jsIds = Object.keys(SITE_SEARCH_ENDPOINTS).filter(id => SITE_SEARCH_ENDPOINTS[id].requiresJs);
  assert.ok(jsIds.length > 0, 'sanity: registry has at least one JS-rendered endpoint');
  for (const id of jsIds) {
    if (all.includes(id)) {
      assert.ok(!ssrOnly.includes(id), `${id} requires JS and must be excluded when includeJs=false`);
    }
  }
});

// BRO-4899: rent-west-end-2026 opening night — 5 T1/T2 reviews live on outlet
// section pages were never discovered (Guardian API 'test' key 401, Telegraph 402
// not falling back, Stage/Time Out only reachable via paid JS search).
import * as ssd4899 from './site-search-discovery.js';
import { test as test4899 } from 'node:test';
import assert4899 from 'node:assert/strict';

test4899('BRO-4899: extractGuardianRssReviewUrls keeps stage review links only', () => {
  const xml = `<link>https://www.theguardian.com/stage/theatre</link>
<link>https://www.theguardian.com/stage/2026/oct/09/rent-review-tom-stoppard-theatre</link>
<link>https://www.theguardian.com/politics/2026/oct/08/some-review-of-politics</link>
<link>https://www.theguardian.com/stage/2026/oct/08/brian-blessed-90-interview</link>`;
  assert4899.deepEqual(ssd4899.extractGuardianRssReviewUrls(xml), ['https://www.theguardian.com/stage/2026/oct/09/rent-review-tom-stoppard-theatre']);
  assert4899.deepEqual(ssd4899.extractGuardianRssReviewUrls(null), []);
});

test4899('BRO-4899: extractSectionLinks resolves relative hrefs and filters by path', () => {
  const html = '<a href="/reviews/rent-review-x">a</a><a href="/news/other">b</a><a href="/reviews/rent-review-x#c">c</a><a href="https://elsewhere.com/reviews/z">d</a>';
  assert4899.deepEqual(ssd4899.extractSectionLinks(html, 'https://www.thestage.co.uk', /^\/reviews\/[a-z0-9-]+$/i), ['https://www.thestage.co.uk/reviews/rent-review-x']);
});

test4899('BRO-4899: every WE T1/T2 press-night outlet has a non-JS (free-pass) discovery arm', () => {
  const E = ssd4899.SITE_SEARCH_ENDPOINTS;
  const free = new Set();
  for (const [id, ep] of Object.entries(E)) {
    if (!ep.requiresJs && (!ep.market || ep.market === 'west-end')) free.add(ep.outletIdOverride || id);
  }
  for (const outlet of ['guardian', 'telegraph', 'independent', 'thestage', 'timeout-london']) {
    assert4899.ok(free.has(outlet), `${outlet} has no free-pass west-end discovery arm`);
  }
});

// BRO-3399: the Daily Mail sitemap matcher glued hyphenated titles into one
// word ("spiderman") that could never be a substring of a real headline.
test('dailyMailHeadlineMatches: hyphenated title matches a hyphenated review headline', () => {
  const { dailyMailHeadlineMatches } = require('./site-search-discovery.js');
  // Fails on the old glued tokenizer: 'spiderman' is not in this headline.
  assert.equal(dailyMailHeadlineMatches('Spider-Man', 'Spider-Man: Turn Off the Dark review - web of woe'), true);
  assert.equal(dailyMailHeadlineMatches('Pre-Existing Condition', 'Pre-Existing Condition review: Off-Broadway in 2026'), true);
});

test('dailyMailHeadlineMatches: unrelated or non-review headlines do not match', () => {
  const { dailyMailHeadlineMatches } = require('./site-search-discovery.js');
  assert.equal(dailyMailHeadlineMatches('Pre-Existing Condition', 'The Other Show review: a West End hit'), false);
  // A hyphen split would have made 'man' a word, a substring of 'woman'.
  assert.equal(dailyMailHeadlineMatches('Spider-Man', 'Woman in Mind review: a West End triumph'), false);
  assert.equal(dailyMailHeadlineMatches('Spider-Man', 'Spider-Man crowds pack Times Square'), false, 'no review/theatre cue');
  assert.equal(dailyMailHeadlineMatches('', 'anything review'), false);
});

test('BRO-6766: Royal Opera House (west-end market) opera shows get every opera outlet', () => {
  const show = { id: 'hercules-off-west-end-2027', type: 'opera', venue: 'Royal Opera House', market: 'west-end' };
  const ids = selectApplicableSiteSearchOutlets('west-end', show, new Set());
  for (const want of ['bachtrack', 'operawire', 'seen-and-heard-international', 'artsdesk', 'guardian', 'times-uk', 'opera-today', 'thestage-section']) {
    assert.ok(ids.includes(want), `ROH opera show must search ${want}; got ${ids.join(',')}`);
  }
  // a West End play must not pick up the opera-only outlets
  const play = selectApplicableSiteSearchOutlets('west-end', { id: 'x', type: 'play' }, new Set());
  assert.ok(!play.includes('operawire'));
});

test('BRO-6766: Opera Today is an opera-only, title-validated endpoint that rejects regional-house URLs', async () => {
  const { SITE_SEARCH_ENDPOINTS } = require('./site-search-discovery.js');
  const { hasNonMetOperaUrlMarker } = require('./content-filters.js');
  const ep = SITE_SEARCH_ENDPOINTS['opera-today'];
  assert.ok(ep, 'opera-today endpoint registered');
  assert.equal(ep.applies({ type: 'opera' }), true);
  assert.equal(ep.applies({ type: 'play' }), false);
  for (const slug of ['tosca-at-glimmerglass', 'tosca-at-garsington', 'tosca-at-opera-holland-park']) {
    assert.equal(hasNonMetOperaUrlMarker(`https://operatoday.com/2026/07/${slug}/`, 'eno').rejected, true, slug);
  }
  assert.equal(hasNonMetOperaUrlMarker('https://operatoday.com/2026/11/cosi-fan-tutte-review/', 'eno').rejected, false);
});

test('telegraph-search is disabled: no provider call is made (BRO-6898)', async () => {
  const { searchOutletSite } = require('./site-search-discovery.js');
  const cfg = SITE_SEARCH_ENDPOINTS['telegraph-search'];
  assert.ok(cfg, 'entry still exists so sibling-exclusion logic keeps working');
  assert.equal(cfg.applies({ type: 'play' }), false);
  const r = await searchOutletSite('telegraph-search', 'Hamilton', { show: { type: 'musical' }, skipJs: false });
  assert.deepEqual(r, []);
});

test('telegraph section index stays selected while telegraph-search is excluded (BRO-6898)', () => {
  const ids = selectApplicableSiteSearchOutlets('broadway', { type: 'musical' }, new Set(), true);
  assert.ok(ids.includes('telegraph'));
  assert.ok(!ids.includes('telegraph-search'));
});

test('ew site-search tries Scrapingdog plain page first; others stay on ScrapingBee (BRO-6908)', async () => {
  const { fetchJsSearchHtml } = require('./site-search-discovery.js');
  const ew = SITE_SEARCH_ENDPOINTS.ew;
  assert.equal(ew.fetchVia, 'scrapingdog-page');
  assert.equal(ew.requiresJs, true); // still gated by skipJs and the JS tier
  // Live test 2026-11-03: Scrapingdog cannot read these search pages. Reroute only with new evidence.
  for (const id of ['hollywood-reporter', 'deadline', 'timeout']) {
    assert.equal(SITE_SEARCH_ENDPOINTS[id].fetchVia, undefined, id);
  }

  const good = '<a href="https://ew.com/theater/hamilton-review-123">x</a>';
  const calls = [];
  const sb = async () => { calls.push('sb'); return 'SB-HTML'; };
  const sdOk = async () => { calls.push('sd'); return { content: good, source: 'scrapingdog' }; };
  assert.equal(await fetchJsSearchHtml(ew, 'u', { sdFetch: sdOk, sbFetch: sb }), good);
  assert.deepEqual(calls, ['sd']);

  for (const [name, sd] of [
    ['null (capped or unavailable)', async () => null],
    ['empty content', async () => ({ content: '' })],
    ['shell with no matching link', async () => ({ content: '<html>loading</html>' })],
    ['throws', async () => { throw new Error('boom'); }],
  ]) {
    calls.length = 0;
    assert.equal(await fetchJsSearchHtml(ew, 'u', { sdFetch: sd, sbFetch: sb }), 'SB-HTML', name);
    assert.ok(calls.includes('sb'), name);
  }

  calls.length = 0;
  const sdNever = async () => { calls.push('sd'); return { content: good }; };
  assert.equal(await fetchJsSearchHtml(SITE_SEARCH_ENDPOINTS.deadline, 'u', { sdFetch: sdNever, sbFetch: sb }), 'SB-HTML');
  assert.deepEqual(calls, ['sb']);
});

test('ew Scrapingdog page needs the query echoed, and SCRAPER_USE_SCRAPINGDOG=0 skips it (BRO-6908)', async (t) => {
  const { fetchJsSearchHtml } = require('./site-search-discovery.js');
  const ew = SITE_SEARCH_ENDPOINTS.ew;
  const url = 'https://ew.com/search/?q=Hamilton+broadway+review';
  const nav = '<a href="https://ew.com/tv/tv-reviews-recommendations/">TV reviews</a> Hamilton';
  const real = '<a href="https://ew.com/theater/hamilton-review-1">Hamilton review</a> Hamilton Hamilton';
  const calls = [];
  const sb = async () => { calls.push('sb'); return 'SB-HTML'; };
  assert.equal(await fetchJsSearchHtml(ew, url, { sdFetch: async () => ({ content: nav }), sbFetch: sb }), 'SB-HTML');
  assert.equal(await fetchJsSearchHtml(ew, url, { sdFetch: async () => ({ content: real }), sbFetch: sb }), real);
  assert.deepEqual(calls, ['sb']);

  const prev = process.env.SCRAPER_USE_SCRAPINGDOG;
  t.after(() => { if (prev === undefined) delete process.env.SCRAPER_USE_SCRAPINGDOG; else process.env.SCRAPER_USE_SCRAPINGDOG = prev; });
  process.env.SCRAPER_USE_SCRAPINGDOG = '0';
  let sdCalled = false;
  assert.equal(await fetchJsSearchHtml(ew, url, { sdFetch: async () => { sdCalled = true; return { content: real }; }, sbFetch: sb }), 'SB-HTML');
  assert.equal(sdCalled, false);
});

test('BRO-7532: free WP search hit skips the paid render; empty, blocked, junk, stale and throws fall back to it', async (t) => {
  const { searchOutletSite } = require('./site-search-discovery.js');
  const review = 'https://deadline.com/2025/10/ragtime-broadway-review-1236583715/';
  const paidReview = 'https://deadline.com/2025/10/ragtime-paid-render-review-1/';
  const paidHtml = `<a href="${paidReview}">x</a>`;
  const run = async (freeFetch, opening = '2025-10-16') => {
    let paid = 0;
    const outcomes = {};
    const urls = (await searchOutletSite('deadline', 'Ragtime', {
      openingDate: opening, outcomes,
      _deps: { freeFetch, sbFetch: async () => { paid++; return paidHtml; }, marketHistoryCounts: null }, // BRO-8268 gate off: hermetic
    })).map(r => r.url);
    return { urls, paid, outcomes };
  };
  // search endpoint answers with `items`; posts/<id> answers with a date
  const wp = (items, date = '2025-10-16T20:00:00') => async (u) => /\/posts\//.test(u)
    ? { status: 200, body: JSON.stringify({ id: 1, date }) }
    : { status: 200, body: JSON.stringify(items) };
  const hit = [{ id: 1, url: review, title: 'Ragtime Review' }];
  const ok = (body, status = 200) => async () => ({ status, body });

  let r = await run(wp(hit));
  assert.deepEqual([r.urls, r.paid], [[review], 0]);
  assert.equal(r.outcomes.deadline, 'found', 'validated free hit is recorded found');

  for (const [label, ff] of [
    ['empty array', ok('[]')],
    ['no review-shaped hit', ok(JSON.stringify([{ id: 2, url: 'https://deadline.com/2025/10/something-else-1/' }]))],
    ['403', ok('Forbidden', 403)],
    ['HTML body', ok('<html>blocked</html>')],
    ['network error', async () => { throw new Error('ECONNRESET'); }],
    ['stale production (2009 post date)', wp(hit, '2009-11-01T00:00:00')],
    ['post date lookup fails', async (u) => { if (/\/posts\//.test(u)) throw new Error('x'); return { status: 200, body: JSON.stringify(hit) }; }],
    ['hit without an id', wp([{ url: review }])],
    ['film review sharing the title', wp([{ id: 3, url: 'https://deadline.com/2025/10/ragtime-broadway-film-review-1236/' }])],
    ['West End review of the same title', wp([{ id: 4, url: 'https://deadline.com/2025/10/ragtime-west-end-review-1/' }])],
  ]) {
    r = await run(ff);
    assert.deepEqual([r.urls, r.paid], [[paidReview], 1], `${label} must use today's paid render`);
  }
  r = await run(wp(hit), null);
  assert.equal(r.paid, 1, 'unknown opening date cannot prove currency, so paid render decides');

  process.env.FREE_WP_SEARCH_DISABLED = '1';
  t.after(() => { delete process.env.FREE_WP_SEARCH_DISABLED; });
  r = await run(wp(hit));
  assert.equal(r.paid, 1, 'kill switch restores the paid-only behaviour');
});

test('BRO-7531: a clean free no-match skips the paid render for off-Broadway / off-West-End only', async (t) => {
  const { searchOutletSite } = require('./site-search-discovery.js');
  const paidReview = 'https://deadline.com/2026/11/petra-paid-render-review-1/';
  const paidHtml = `<a href="${paidReview}">x</a>`;
  // The canary ("Broadway review") answers with a row unless a case overrides it.
  const canary = (u) => /search=Broadway%20review/.test(u);
  const run = async (freeFetch, show, opening = '2026-11-10', { canaryAnswer = { status: 200, body: JSON.stringify([{ id: 1, url: 'https://deadline.com/2026/11/x-1/', link: 'https://deadline.com/2026/11/x-1/' }]) }, random = () => 0.99 } = {}) => {
    let paid = 0;
    const outcomes = {};
    const asked = [];
    const urls = (await searchOutletSite('deadline', 'Petra', {
      openingDate: opening, outcomes, show,
      _deps: { freeFetch: async (u) => { asked.push(u); return canary(u) ? canaryAnswer : freeFetch(u); }, sbFetch: async () => { paid++; return paidHtml; }, random, marketHistoryCounts: null }, // BRO-8268 gate off: this test is about BRO-7531
    })).map(r => r.url);
    return { urls, paid, outcomes, asked };
  };
  const ob = { id: 'petra-off-broadway-2026', category: 'off-broadway' };
  const owe = { id: 'petra-off-west-end-2026', category: 'off-west-end' };
  const json = (v) => ({ status: 200, body: JSON.stringify(v) });
  const noise = (n) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, url: `https://deadline.com/2026/11/box-office-weekend-${i}-1/`, link: `https://deadline.com/2026/11/box-office-weekend-${i}-1/` }));
  const bounded = (u) => /\/wp\/v2\/posts\?/.test(u);
  const candidate0 = () => ({ id: 9, url: 'https://deadline.com/2026/11/petra-something-1/', link: 'https://deadline.com/2026/11/petra-something-1/' });

  // 1. short page, nothing the paid filter would accept: the no-match stands
  let r = await run(async () => json([]), ob);
  assert.deepEqual([r.urls, r.paid, r.outcomes.deadline], [[], 0, 'confirmed-empty'], 'empty answer for an off-Broadway show skips the paid render');
  r = await run(async () => json(noise(3)), owe);
  assert.deepEqual([r.urls, r.paid], [[], 0], 'non-review noise for an off-West-End show skips the paid render');
  assert.equal(r.asked.some(bounded), false, 'a short clean page needs no second free request');
  assert.equal(r.asked.some(canary), false, 'a non-empty answer needs no canary');
  r = await run(async () => json(noise(3)), ob, null);
  assert.deepEqual([r.urls, r.paid], [[], 0], 'a short clean page decides without an opening date');

  // 2. full page (common title): one date-bounded free re-ask decides
  r = await run(async (u) => json(bounded(u) ? noise(7) : noise(20)), ob);
  assert.deepEqual([r.urls, r.paid], [[], 0], 'full page + complete clean bounded answer skips the paid render');
  const b = r.asked.find(bounded);
  assert.match(b, /after=2026-09-26T00:00:00&before=2027-03-10T00:00:00&per_page=100/, 'bounded to opening -45d .. +120d');

  // 2b. BRO-7532 recheck: no opening date yet, but previews have started. The
  // previews date anchors the bounded re-ask, so a full page can still be proven clean.
  const day = 86400000;
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const prevMs = Date.parse(isoDay(Date.now() - 6 * day)); // previews began 6 days ago (relative, never goes stale)
  const obPreviews = { ...ob, previewsStartDate: isoDay(prevMs) };
  r = await run(async (u) => json(bounded(u) ? noise(7) : noise(20)), obPreviews, null);
  assert.deepEqual([r.urls, r.paid], [[], 0], 'full page + previews date + clean bounded answer skips the paid render');
  assert.ok(r.asked.find(bounded).includes(`after=${isoDay(prevMs - 45 * day)}T00:00:00&before=${isoDay(prevMs + 120 * day)}T00:00:00`), 'bounded to previews -45d .. +120d');
  r = await run(async (u) => json(bounded(u) ? noise(7) : noise(20)), { ...ob, previewsStartDate: isoDay(Date.now() - 200 * day) }, null);
  assert.equal(r.paid, 1, 'previews began 200 days ago with no opening date: paid render as before');
  r = await run(async (u) => json(bounded(u) ? [candidate0()] : noise(20)), obPreviews, null);
  assert.deepEqual([r.urls, r.paid], [[paidReview], 1], 'previews-anchored bounded answer holding a candidate keeps the paid render');
  r = await run(async () => json(noise(20)), { ...ob, previewsStartDate: 'TBA' }, null);
  assert.equal(r.paid, 1, 'unparseable previews date: no anchor, paid render as before');

  // 3. anything unclear keeps the paid render, exactly as before
  const candidate = { id: 9, url: 'https://deadline.com/2026/11/petra-something-1/', link: 'https://deadline.com/2026/11/petra-something-1/' };
  for (const [label, ff, show, opening, opts] of [
    ['short page holding a post the paid filter would accept', async () => json([candidate]), ob],
    ['bounded answer holding a post the paid filter would accept', async (u) => json(bounded(u) ? [candidate] : noise(20)), ob],
    ['bounded answer that fills its page', async (u) => json(bounded(u) ? noise(100) : noise(20)), ob],
    ['bounded request blocked', async (u) => (bounded(u) ? { status: 403, body: 'Forbidden' } : json(noise(20))), ob],
    ['bounded request returns HTML', async (u) => (bounded(u) ? { status: 200, body: '<html>challenge</html>' } : json(noise(20))), ob],
    ['bounded request throws', async (u) => { if (bounded(u)) throw new Error('ECONNRESET'); return json(noise(20)); }, ob],
    ['full page and no opening date to bound by', async () => json(noise(20)), ob, null],
    ['free search blocked', async () => ({ status: 403, body: 'Forbidden' }), ob],
    ['free search returns HTML', async () => ({ status: 200, body: '<html>challenge</html>' }), ob],
    ['empty answer while the canary is empty too (endpoint broken)', async () => json([]), ob, undefined, { canaryAnswer: json([]) }],
    ['empty answer while the canary is blocked', async () => json([]), ob, undefined, { canaryAnswer: { status: 403, body: 'Forbidden' } }],
    ['empty bounded answer while the posts canary is empty', async (u) => json(bounded(u) ? [] : noise(20)), ob, undefined, { canaryAnswer: json([]) }],
    ['full page whose rows lost their links in parsing', async () => json(Array.from({ length: 20 }, (_, i) => ({ id: i }))), ob, null],
    ['the audit sample', async () => json(noise(3)), ob, undefined, { random: () => 0.01 }],
    ['Broadway show', async () => json([]), { id: 'petra-2026', category: 'broadway' }],
    ['West End show', async () => json([]), { id: 'petra-west-end-2026', category: 'west-end' }],
    ['show with no category yet', async () => json([]), { id: 'petra-2026' }],
    ['no show object', async () => json([]), null],
  ]) {
    r = await run(ff, show, opening === undefined ? '2026-11-10' : opening, opts);
    assert.deepEqual([r.urls, r.paid], [[paidReview], 1], `${label} must keep the paid render`);
  }

  // 4. kill switch
  process.env.FREE_WP_NO_MATCH_PAID = '1';
  t.after(() => { delete process.env.FREE_WP_NO_MATCH_PAID; });
  r = await run(async () => json([]), ob);
  assert.equal(r.paid, 1, 'FREE_WP_NO_MATCH_PAID=1 restores the paid render after every no-match');
});

test('BRO-7532: only deadline and hollywood-reporter carry freeWp, each with a paid-render config intact', () => {
  for (const [id, cfg] of Object.entries(SITE_SEARCH_ENDPOINTS)) {
    if (cfg.freeWp) {
      assert.ok(['deadline', 'hollywood-reporter'].includes(id));
      assert.equal(cfg.requiresJs, true);
      assert.ok(cfg.linkPattern && cfg.url);
    }
  }
  assert.ok(SITE_SEARCH_ENDPOINTS.deadline.freeWp && SITE_SEARCH_ENDPOINTS['hollywood-reporter'].freeWp);
});

test('BRO-8323: JS site-search works with no ScrapingBee: Playwright then Scrapingdog plain, SB still first', async (t) => {
  const { fetchJsSearchHtml, rescueJsSearchHtml } = require('./site-search-discovery.js');
  const dl = SITE_SEARCH_ENDPOINTS.deadline;
  const url = 'https://deadline.com/?s=Hamilton+review';
  const good = '<a href="https://deadline.com/2026/11/hamilton-review-123/">x</a>';
  const shell = '<html>loading</html>';
  const noKey = async () => { throw new Error('No ScrapingBee key'); };
  const calls = [];
  const pw = async () => { calls.push('pw'); return { content: good, source: 'playwright' }; };
  const sd = async () => { calls.push('sd'); return { content: good }; };

  // SB key absent: the free render answers, and Scrapingdog is never paid.
  assert.equal(await fetchJsSearchHtml(dl, url, { sbFetch: noKey, pwFetch: pw, sdPlainFetch: sd }), good);
  assert.deepEqual(calls, ['pw']);

  // SB empty or rejecting counts the same as absent; Playwright shell then SD plain.
  calls.length = 0;
  const pwShell = async () => { calls.push('pw'); return { content: shell }; };
  assert.equal(await fetchJsSearchHtml(dl, url, { sbFetch: async () => '', pwFetch: pwShell, sdPlainFetch: sd }), good);
  assert.deepEqual(calls, ['pw', 'sd']);

  // SB working: unchanged, no rescue call at all (Broadway behaviour with the key present).
  calls.length = 0;
  assert.equal(await fetchJsSearchHtml(dl, url, { sbFetch: async () => 'SB-HTML', pwFetch: pw, sdPlainFetch: sd }), 'SB-HTML');
  assert.deepEqual(calls, []);

  // Everything fails: the original SB error surfaces so the caller reports it as before.
  await assert.rejects(fetchJsSearchHtml(dl, url, { sbFetch: noKey, pwFetch: pwShell, sdPlainFetch: async () => null }), /No ScrapingBee key/);

  // Kill switch and the Scrapingdog off switch.
  const prev = { r: process.env.SB_RESCUE_DISABLED, s: process.env.SCRAPER_USE_SCRAPINGDOG };
  t.after(() => { for (const [k, v] of [['SB_RESCUE_DISABLED', prev.r], ['SCRAPER_USE_SCRAPINGDOG', prev.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.SB_RESCUE_DISABLED = '1';
  assert.equal(await rescueJsSearchHtml(dl, url, { pwFetch: pw }), '');
  delete process.env.SB_RESCUE_DISABLED;
  process.env.SCRAPER_USE_SCRAPINGDOG = '0';
  calls.length = 0;
  assert.equal(await rescueJsSearchHtml(dl, url, { pwFetch: pwShell, sdPlainFetch: sd }), '');
  assert.deepEqual(calls, ['pw']);
});
