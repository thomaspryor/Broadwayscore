/**
 * Tests for scripts/lib/serp-slug-discovery.js after refactor to use the
 * shared serpQuery() / SERP cache (commit on 2026-05-17).
 *
 * Pre-refactor: had its own raw BD SERP fetch+poll. Post-refactor: delegates
 * to url-discovery.js::serpQuery which goes through serp-cache.js.
 *
 * The tests stub out serpQuery via the module cache so we can exercise the
 * slug-extraction logic without hitting the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Stub serpQuery on the url-discovery module BEFORE serp-slug-discovery is required.
const urlDiscoveryPath = require.resolve('../../scripts/lib/url-discovery.js');
let _mockResults = [];
let _capturedQuery = null;
let _capturedOptions = null;
require.cache[urlDiscoveryPath] = {
  id: urlDiscoveryPath,
  filename: urlDiscoveryPath,
  loaded: true,
  exports: {
    serpQuery: async (query, options) => {
      _capturedQuery = query;
      _capturedOptions = options;
      return _mockResults;
    },
  },
};

// Ensure at least one provider key is set so the early-return doesn't fire.
process.env.BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN || 'test-token';

const { discoverSlug, batchDiscoverSlugs } = require('../../scripts/lib/serp-slug-discovery.js');

test('extracts slug from matching SERP result (pathPrefix mode)', async () => {
  _mockResults = [
    { url: 'https://seatplan.com/london/hamilton/', title: 'Hamilton tickets — SeatPlan' },
  ];
  const slug = await discoverSlug('seatplan.com', 'Hamilton', 'london');
  assert.equal(slug, 'hamilton');
});

test('extracts slug from last path segment when no pathPrefix', async () => {
  _mockResults = [
    { url: 'https://londonboxoffice.co.uk/cabaret-at-the-kit-kat-club-tickets', title: 'Cabaret at the Kit Kat Club tickets' },
  ];
  const slug = await discoverSlug('londonboxoffice.co.uk', 'Cabaret at the Kit Kat Club');
  assert.equal(slug, 'cabaret-at-the-kit-kat-club');
});

test('strips -tickets suffix', async () => {
  _mockResults = [
    { url: 'https://seatplan.com/london/wicked-tickets/', title: 'Wicked tickets' },
  ];
  const slug = await discoverSlug('seatplan.com', 'Wicked', 'london');
  assert.equal(slug, 'wicked');
});

test('rejects wrong-show results via title validation', async () => {
  // SERP returns a Mary Poppins page despite the query being "Black Is The Color"
  _mockResults = [
    { url: 'https://seatplan.com/london/mary-poppins/', title: 'Mary Poppins tickets' },
  ];
  const slug = await discoverSlug('seatplan.com', 'Black Is The Color', 'london');
  assert.equal(slug, null);
});

test('accepts results with ≥50% of meaningful title words present', async () => {
  // Query "King Lear at the Globe" → meaningful words: ['king','lear','globe'] (the/at filtered)
  // Result title has 2/3 words → 67% → matches.
  _mockResults = [
    { url: 'https://seatplan.com/london/king-lear/', title: 'King Lear at the Globe Theatre' },
  ];
  const slug = await discoverSlug('seatplan.com', 'King Lear at the Globe', 'london');
  assert.equal(slug, 'king-lear');
});

test('skips news/blog/post URLs even if title matches', async () => {
  _mockResults = [
    { url: 'https://seatplan.com/news/hamilton-review', title: 'Hamilton review' },
    { url: 'https://seatplan.com/london/hamilton/', title: 'Hamilton tickets' },
  ];
  const slug = await discoverSlug('seatplan.com', 'Hamilton', 'london');
  assert.equal(slug, 'hamilton'); // jumps to the ticket page, not the news page
});

test('returns null when no results match the site domain', async () => {
  _mockResults = [
    { url: 'https://other-site.com/hamilton', title: 'Hamilton tickets' },
  ];
  const slug = await discoverSlug('seatplan.com', 'Hamilton', 'london');
  assert.equal(slug, null);
});

test('returns null when SERP returns empty array', async () => {
  _mockResults = [];
  const slug = await discoverSlug('seatplan.com', 'Hamilton', 'london');
  assert.equal(slug, null);
});

test('query format unchanged from pre-refactor', async () => {
  _mockResults = [];
  await discoverSlug('seatplan.com', 'Hamilton', 'london');
  assert.equal(_capturedQuery, 'site:seatplan.com "Hamilton" tickets');
});

test('passes geo:gb to serpQuery (preserves UK geo from pre-refactor)', async () => {
  // Ship-check P1: all slug-discovery callers target UK-only sites. Pre-refactor
  // hardcoded gl=gb to BD. Post-refactor must keep that semantic via the explicit
  // geo option (query string doesn't contain "West End" trigger).
  _mockResults = [];
  _capturedOptions = null;
  await discoverSlug('seatplan.com', 'Hamilton', 'london');
  assert.ok(_capturedOptions, 'serpQuery should have been called with options');
  assert.equal(_capturedOptions.geo, 'gb', 'geo must be forced to gb for UK sites');
});

// batchDiscoverSlugs() logs progress via console.log. When node's test runner
// parses TAP output across the full multi-hundred-file CI batch, raw stdout
// from application code interleaved with the runner's own reporting stream
// corrupts the TAP framing ("Unable to deserialize cloned data due to invalid
// or unsupported version") — reproduces only at CI batch scale, not when
// running this file solo. Suppress console.log for the duration of these
// calls, matching the convention used elsewhere in tests/unit/.
function withSilencedConsole(fn) {
  const orig = console.log;
  console.log = () => {};
  return Promise.resolve(fn()).finally(() => { console.log = orig; });
}

test('batchDiscoverSlugs: no budget passed processes all shows (default behavior unchanged)', async () => {
  _mockResults = [
    { url: 'https://seatplan.com/london/hamilton/', title: 'Hamilton tickets' },
  ];
  const shows = [
    { id: 'hamilton', title: 'Hamilton' },
    { id: 'wicked', title: 'Wicked' },
    { id: 'six', title: 'Six' },
  ];
  const discovered = await withSilencedConsole(() => batchDiscoverSlugs('seatplan.com', shows, 'london', 0));
  // All 3 shows queried (mocked SERP always returns the Hamilton result, so
  // Wicked/Six fail title validation and return null — but the loop still runs).
  assert.equal(discovered.size, 1);
});

test('batchDiscoverSlugs: budget.exceeded() true from the start stops before any show is processed', async () => {
  let calls = 0;
  const originalQuery = _mockResults;
  _mockResults = [{ url: 'https://seatplan.com/london/hamilton/', title: 'Hamilton tickets' }];
  const shows = [
    { id: 'hamilton', title: 'Hamilton' },
    { id: 'wicked', title: 'Wicked' },
  ];
  const budget = { minutes: 5, exceeded: () => { calls++; return true; } };
  const discovered = await withSilencedConsole(() => batchDiscoverSlugs('seatplan.com', shows, 'london', 0, budget));
  assert.equal(discovered.size, 0);
  assert.ok(calls >= 1, 'budget.exceeded() should have been checked');
  _mockResults = originalQuery;
});

test('batchDiscoverSlugs: budget exceeding mid-batch stops remaining shows', async () => {
  _mockResults = [{ url: 'https://seatplan.com/london/hamilton/', title: 'Hamilton tickets' }];
  const shows = [
    { id: 'hamilton', title: 'Hamilton' },
    { id: 'wicked', title: 'Hamilton' }, // reuse title so it'd match if queried
    { id: 'six', title: 'Hamilton' },
  ];
  let checkCount = 0;
  // exceeded() false on the first check (show 0 processes), true from the second check onward.
  const budget = { minutes: 5, exceeded: () => { checkCount++; return checkCount > 1; } };
  const discovered = await withSilencedConsole(() => batchDiscoverSlugs('seatplan.com', shows, 'london', 0, budget));
  assert.equal(discovered.size, 1, 'only the first show should have been processed before the budget stopped the loop');
  assert.ok(discovered.has('hamilton'));
});

test('returns null when no SERP provider keys set', async () => {
  const savedBD = process.env.BRIGHTDATA_TOKEN;
  const savedSB = process.env.SCRAPINGBEE_API_KEY;
  delete process.env.BRIGHTDATA_TOKEN;
  delete process.env.SCRAPINGBEE_API_KEY;
  // Need to re-require to pick up env change
  delete require.cache[require.resolve('../../scripts/lib/serp-slug-discovery.js')];
  const { discoverSlug: ds2 } = require('../../scripts/lib/serp-slug-discovery.js');
  const slug = await ds2('seatplan.com', 'Hamilton', 'london');
  assert.equal(slug, null);
  // Restore
  if (savedBD) process.env.BRIGHTDATA_TOKEN = savedBD;
  if (savedSB) process.env.SCRAPINGBEE_API_KEY = savedSB;
});
