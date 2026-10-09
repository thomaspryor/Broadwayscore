import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectApplicableSiteSearchOutlets, SITE_SEARCH_ENDPOINTS } = require('./site-search-discovery.js');

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
  // 'telegraph-search' overrides to canonical 'telegraph' — if an aggregator already
  // found telegraph, the sibling search-index endpoint must not re-fire either.
  const withoutFound = selectApplicableSiteSearchOutlets('west-end', { id: 'x', type: 'play' }, new Set());
  assert.ok(withoutFound.includes('telegraph-search') || withoutFound.includes('telegraph'));

  const alreadyFound = new Set(['telegraph']);
  const withFound = selectApplicableSiteSearchOutlets('west-end', { id: 'x', type: 'play' }, alreadyFound);
  assert.ok(!withFound.includes('telegraph'), 'canonical telegraph must be excluded once found');
  assert.ok(!withFound.includes('telegraph-search'), 'sibling telegraph-search must also be excluded once telegraph is found');
});

test('opera-gated outlets only fire when applies(show) passes', () => {
  const nonOpera = selectApplicableSiteSearchOutlets('broadway', { id: 'x', type: 'play' }, new Set());
  const opera = selectApplicableSiteSearchOutlets('broadway', { id: 'x', type: 'opera' }, new Set());
  const operaOnlyIds = Object.keys(SITE_SEARCH_ENDPOINTS).filter(id => typeof SITE_SEARCH_ENDPOINTS[id].applies === 'function');
  assert.ok(operaOnlyIds.length > 0, 'sanity: registry has at least one applies()-gated outlet');
  for (const id of operaOnlyIds) {
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
