/**
 * BRO-7470: london-theatre sat in SKIP_OUTLETS ("dedicated scraper") with no
 * scraper behind it, so the first pass missed it on Ceilidh, Julius Caesar and
 * Dogstar (all later found by audit-aggregator-gap). It must be polled via its
 * /reviews listing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const poller = require('./outlet-listing-poller.js');
const { extractListingUrls } = require('./lib/outlet-listing-helpers');

test('london-theatre is not skipped by the listing poller', () => {
  assert.equal(poller.SKIP_OUTLETS.has('london-theatre'), false);
});

test('every SKIP_OUTLETS entry has a named owner scraper', () => {
  const owners = { broadwayworld: 1, 'london-box-office': 1, loureviews: 1 };
  for (const id of poller.SKIP_OUTLETS) assert.ok(owners[id], `${id} skipped without a known dedicated scraper`);
});

test('london-theatre has a listing-html strategy on /reviews', () => {
  const c = poller.OUTLET_STRATEGY_CONFIG['london-theatre'];
  assert.equal(c.strategy, 'listing-html');
  assert.match(c.url, /londontheatre\.co\.uk\/reviews$/);
});

test('listing fixture yields the missed Off-West End reviews', () => {
  const c = poller.OUTLET_STRATEGY_CONFIG['london-theatre'];
  const html = fs.readFileSync(new URL('./fixtures/londontheatre-reviews-listing.html', import.meta.url), 'utf8');
  const urls = extractListingUrls(html, 'londontheatre.co.uk').filter((i) => c.urlFilter.test(i.url)).map((i) => i.url);
  assert.ok(urls.some((u) => u.includes('/reviews/ceilidh-the-musical-review-shoreditch-town-hall')), 'Ceilidh');
  assert.ok(urls.some((u) => u.includes('/reviews/dogstar-review-hampstead-theatre')), 'Dogstar');
  assert.ok(!urls.some((u) => /\/reviews(\?|$)/.test(u)), 'index page itself excluded');
});
