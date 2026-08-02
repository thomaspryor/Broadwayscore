import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectApplicableSiteSearchOutlets, SITE_SEARCH_ENDPOINTS } = require('./site-search-discovery.js');

// Regression coverage for #767: gather-reviews.js never invoked the site-search arm,
// so Telegraph/Variety/The Stage/Independent/Parterre discovery only ran inside
// opening-night-poller.js. This exercises the shared selection logic both callers
// now use, against the real SITE_SEARCH_ENDPOINTS registry (no mocks).

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
