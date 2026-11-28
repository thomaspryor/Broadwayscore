/**
 * BRO-7171 Stage 2b: Google now hands scraped SERPs opaque redirect links
 * (google.com/url?q=CAES... from Scrapingdog, /goto?url=CAES... from Bright
 * Data). No target URL is inside them and fetching one returns a JS interstitial,
 * so url-discovery must recover the target from the result's other fields or drop
 * the result, never pass the token on. Drives the real chain with axios stubbed.
 * Run: node --test scripts/lib/serp-opaque-links.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-opaque-'));
process.env.SCRAPINGDOG_API_KEY = 'sd-test';
process.env.SCRAPER_USE_SCRAPINGDOG = '1';
process.env.BD_SERP_CACHE_DIR = path.join(tmp, 'serp-cache');
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(tmp, 'ledger.jsonl');
process.env.BD_BREAKER_STATE_PATH = path.join(tmp, 'bd-breaker.json');
process.env.SD_BREAKER_STATE_PATH = path.join(tmp, 'sd-breaker.json');
process.env.SB_BREAKER_STATE_PATH = path.join(tmp, 'sb-breaker.json');
delete process.env.SCRAPER_SPEND_PURPOSE;
delete process.env.SERP_QUERY_BUDGET;

const require = createRequire(import.meta.url);
const axios = require('axios');
const OPAQUE = 'https://www.google.com/url?opi=89978449&q=CAEShQEBxCJF1-2RE6svdEhmuGuh&sa=U&ved=2ahU';
const GOTO = '/goto?url=CAEShwEBxCJF10jkaFSaSa8rvuMsZydL3mF7Utin2';

let sdOrganic = [];
let bdOrganic = [];
const calls = [];
axios.get = async (url) => {
  calls.push(String(url));
  if (String(url).includes('scrapingdog')) return { status: 200, data: { organic_results: sdOrganic } };
  return { status: 200, data: { organic_results: [] } };
};
axios.post = async (url) => {
  calls.push(String(url));
  return { status: 200, data: { organic: bdOrganic } };
};

const U = require('./unresolvable-url.js');
const ud = require('./url-discovery.js');
const serpCache = require('./serp-cache.js');
const log = () => {};
let n = 0;
const run = (query = `"Opaque Probe Show" review ${n++}`) => ud._serpWithChainForTests(query, 'sb-key', 'bd-key', log, null, false);

beforeEach(() => {
  calls.length = 0;
  sdOrganic = [];
  bdOrganic = [];
  ud._resetSerpQueryCountForTests();
});

test('opaque detection: Google tokens are opaque, a /url?q=https://... wrapper and a real link are not', () => {
  assert.equal(U.isOpaqueGoogleRedirect(OPAQUE), true);
  assert.equal(U.isOpaqueGoogleRedirect(GOTO), true);
  assert.equal(U.isOpaqueGoogleRedirect('https://www.google.co.uk/url?q=CAESxyz'), true);
  assert.equal(U.isOpaqueGoogleRedirect('https://www.google.com/url?q=https://www.thestage.co.uk/reviews/x'), false);
  assert.equal(U.isOpaqueGoogleRedirect('https://www.dailymail.co.uk/tvshowbiz/article-1/x.html'), false);
  assert.equal(U.isUnresolvableRedirectUrl(OPAQUE), true, 'shared guard covers the absolute form too');
});

test('displayed link: an untruncated breadcrumb rebuilds the url; truncated or host-only does not', () => {
  assert.equal(U.urlFromDisplayedLink('https://www.londontheatre1.com › reviews › titanique-criterion-theatre-review'), 'https://www.londontheatre1.com/reviews/titanique-criterion-theatre-review');
  assert.equal(U.urlFromDisplayedLink('https://www.dailymail.co.uk › tvshowbiz › article-1 › Strong-Manville-f...'), null);
  assert.equal(U.urlFromDisplayedLink('https://www.dailymail.co.uk › tvshowbiz › Strong…'), null);
  assert.equal(U.urlFromDisplayedLink('https://www.dailymail.co.uk'), null);
  assert.equal(U.urlFromDisplayedLink('dailymail.co.uk › x'), null, 'no scheme: not trusted');
  assert.equal(U.urlFromDisplayedLink(undefined), null);
});

test('resolveSerpLink: real link wins, then a real redirect_link, then the breadcrumb, else null', () => {
  assert.deepEqual(U.resolveSerpLink({ link: 'https://a.com/x', redirect_link: OPAQUE }), { url: 'https://a.com/x', reconstructed: false });
  assert.deepEqual(U.resolveSerpLink({ link: 'https://www.google.com/url?q=https%3A%2F%2Fb.com%2Fy&sa=U' }), { url: 'https://b.com/y', reconstructed: false });
  assert.deepEqual(U.resolveSerpLink({ link: OPAQUE, displayed_link: 'https://c.com › reviews › z-review' }), { url: 'https://c.com/reviews/z-review', reconstructed: true });
  assert.equal(U.resolveSerpLink({ link: OPAQUE, displayed_link: 'https://c.com › reviews › z...' }), null);
  assert.equal(U.resolveSerpLink({ link: GOTO }), null);
});

test('chain: opaque Scrapingdog links never reach the caller; breadcrumbs are recovered', async () => {
  sdOrganic = [
    { link: OPAQUE, displayed_link: 'https://www.londontheatre1.com › reviews › titanique-criterion-theatre-review', title: 'Titanique review' },
    { link: OPAQUE, displayed_link: 'https://www.nytimes.com › 2026/04/12 › theater › titanique-revi...', title: 'NYT' },
    { link: 'https://www.reddit.com/r/Broadway/x', title: 'reddit' },
  ];
  const r = await run();
  const urls = r.results.map((x) => x.url);
  assert.deepEqual(urls, ['https://www.londontheatre1.com/reviews/titanique-criterion-theatre-review', 'https://www.reddit.com/r/Broadway/x']);
  assert.equal(r.results[0].urlReconstructed, true);
  assert.ok(!urls.some((u) => /google\.|^\//.test(u)));
});

test('chain: an all-opaque Scrapingdog answer is not authoritative-empty; Bright Data is asked and its /goto links dropped', async () => {
  sdOrganic = [{ link: OPAQUE, displayed_link: 'https://x.com › a › b...' }, { link: OPAQUE }];
  bdOrganic = [{ link: GOTO, title: 'g' }, { link: 'https://www.dailymail.co.uk/tvshowbiz/article-2/review.html', title: 'Mail review' }];
  const r = await run();
  assert.ok(calls.some((c) => c.includes('brightdata')), 'fell through to Bright Data');
  assert.deepEqual(r.results.map((x) => x.url), ['https://www.dailymail.co.uk/tvshowbiz/article-2/review.html']);
  assert.notEqual(r.provider, 'scrapingdog-empty');
});

test('chain: a genuinely empty Scrapingdog answer stays authoritative (unchanged)', async () => {
  sdOrganic = [];
  const r = await run();
  assert.equal(r.provider, 'scrapingdog-empty');
  assert.ok(!calls.some((c) => c.includes('brightdata')));
});

test('cache: opaque results cached before the fix are filtered on read; all-opaque cache is a miss', async () => {
  const mixed = `"Cached Opaque Show" review ${n++}`;
  serpCache.set(mixed, { geo: 'us', dateMin: '', dateMax: '' }, { results: [{ url: OPAQUE }, { url: 'https://real.com/review' }], provider: 'scrapingdog' });
  const a = await run(mixed);
  assert.deepEqual(a.results.map((x) => x.url), ['https://real.com/review']);
  assert.equal(calls.length, 0, 'mixed cache still served');

  const allOpaque = `"All Opaque Cached Show" review ${n++}`;
  serpCache.set(allOpaque, { geo: 'us', dateMin: '', dateMax: '' }, { results: [{ url: OPAQUE }, { url: GOTO }], provider: 'scrapingdog' });
  sdOrganic = [{ link: 'https://live.com/review', title: 'live' }];
  const b = await run(allOpaque);
  assert.deepEqual(b.results.map((x) => x.url), ['https://live.com/review'], 'went live instead of serving tokens');
});

// ship-check fixes (BRO-7171 Stage 2b)
test('resolveSerpLink only unwraps a google host or a relative link, never a url in a real link\'s query', () => {
  assert.deepEqual(U.resolveSerpLink({ link: 'https://www.nytimes.com/a?ref=google.com&url=https://evil.com/x' }), { url: 'https://www.nytimes.com/a?ref=google.com&url=https://evil.com/x', reconstructed: false });
  assert.deepEqual(U.resolveSerpLink({ link: '/url?q=https://real.com/review&sa=U' }), { url: 'https://real.com/review', reconstructed: false });
});

test('breadcrumb rebuild needs a slug-like last segment (site labels are not paths)', () => {
  assert.equal(U.urlFromDisplayedLink('https://www.timeout.com › London › Theatre'), null);
  assert.equal(U.urlFromDisplayedLink('https://www.timeout.com › london › theatre'), null);
  assert.equal(U.urlFromDisplayedLink('https://nystagereview.com › 2026/04/12 › titanique-what-did-i-miss'), 'https://nystagereview.com/2026/04/12/titanique-what-did-i-miss');
});

test('dropUnresolvableSerpResults unwraps google /url?q=https wrappers instead of dropping them', () => {
  const r = U.dropUnresolvableSerpResults([{ url: '/url?q=https://a.com/review' }, { url: 'https://www.google.com/url?q=https%3A%2F%2Fb.com%2Fr' }, { url: GOTO }]);
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.com/review', 'https://b.com/r']);
  assert.equal(r.dropped, 1);
});

test('chain: an all-token Bright Data answer is not cached as an empty answer', async () => {
  const query = `"All Token BD Show" review ${n++}`;
  sdOrganic = [{ link: OPAQUE }];
  bdOrganic = [{ link: GOTO }, { link: GOTO + 'x' }];
  const first = await run(query);
  assert.deepEqual(first.results, []);
  calls.length = 0;
  sdOrganic = [{ link: 'https://live.com/now', title: 'live' }];
  const again = await run(query);
  assert.ok(calls.length > 0, 'asked live again, no cached empty');
  assert.deepEqual(again.results.map((x) => x.url), ['https://live.com/now']);
});
