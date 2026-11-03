import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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
