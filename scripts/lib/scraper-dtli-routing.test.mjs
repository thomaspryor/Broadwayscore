// BRO-4244: offline transport tests for the real fetchPage and DTLI parser.
// Live provider parity is checked separately against real DTLI pages.
// scripts/scraper-dtli-routing.test.mjs imports this for the card's command;
// CI runs this file through its existing scripts/lib test glob.
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const scratch = mkdtempSync(path.join(tmpdir(), 'dtli-routing-'));
const env = {
  SCRAPINGDOG_API_KEY: 'test-key',
  SCRAPER_USE_SCRAPINGDOG: '1',
  BRIGHTDATA_TOKEN: 'test-key',
  SCRAPINGBEE_API_KEY: 'test-key',
  SD_CAPS_DISABLED: '1',
  BD_CAPS_DISABLED: '1',
  SCRAPER_SPEND_LEDGER_PATH: path.join(scratch, 'ledger.jsonl'),
  SCRAPER_URL_MISMATCH_AUDIT_PATH: path.join(scratch, 'url-mismatches.json'),
};
const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const { extractReviewsFromDTLI } = require('../extract-dtli-reviews.js');

// Invented excerpts only. Exercise standard, poster, and mixed review blocks.
function page(slug, title, classes = ['review-item']) {
  return `<html><head><title>${title} - Did They Like It?</title>
<link rel="canonical" href="https://didtheylikeit.com/shows/${slug}/"></head>
<body><h1>${title}</h1>${classes.map((cls, i) => `
<div class="${cls}">
  <div class="review_image"><div>TheaterMania</div></div>
  <h2 class="review-item-critic-name">Test Critic ${i}</h2>
  <h3 class="review-item-date">October 1, 2026</h3>
  <img alt="BigThumbs_Up">
  <p class="paragraph">An invented excerpt long enough to exercise the real DTLI review parser.</p>
  <a href="https://www.theatermania.com/reviews/test-${i}/" class="button-pink review-item-button">Read Full Review</a>
</div>`).join('')}</body></html>`;
}

const cases = [
  { slug: 'hamilton', title: 'Hamilton', classes: ['review-item'] },
  { slug: 'company-2', title: 'Company', classes: ['poster-review-item'] },
  { slug: 'oh-mary', title: 'OH, MARY!', classes: ['review-item', 'poster-review-item'] },
];
let scraper;
let calls;
let originalFetch;
let originalGet;
let originalRequest;
let paidHtml;

beforeEach(() => {
  delete require.cache[require.resolve('./scraper.js')];
  scraper = require('./scraper.js');
  calls = [];
  paidHtml = page('hamilton', 'Hamilton');
  originalFetch = global.fetch;
  originalGet = https.get;
  originalRequest = https.request;
  // Mock both paid-provider transports, including the asynchronous quota probe.
  https.get = (apiUrl, options, callback) => {
    const api = new URL(apiUrl);
    calls.push(api);
    const req = new EventEmitter();
    req.destroy = () => {};
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    process.nextTick(() => {
      callback(res);
      res.emit('data', api.pathname === '/account' ? '{}' : paidHtml);
      res.emit('end');
    });
    return req;
  };
  https.request = (apiUrl, options, callback) => {
    const api = new URL(apiUrl);
    calls.push(api);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        callback(res);
        res.emit('data', paidHtml);
        res.emit('end');
      });
    };
    return req;
  };
});

afterEach(async () => {
  await scraper.cleanup();
  global.fetch = originalFetch;
  https.get = originalGet;
  https.request = originalRequest;
});

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

for (const { slug, title, classes } of cases) {
  test(`DTLI direct fetch preserves complete ${slug} HTML and parsed reviews`, async () => {
    const html = page(slug, title, classes);
    let directCalls = 0;
    global.fetch = async (url, options) => {
      directCalls++;
      assert.equal(url, `https://didtheylikeit.com/shows/${slug}/`);
      assert.ok(options.signal, 'direct transport has a deadline');
      return new Response(html, { status: 200 });
    };
    const result = await scraper.fetchPage(`https://didtheylikeit.com/shows/${slug}/`);
    assert.equal(result.source, 'direct');
    assert.equal(result.format, 'html');
    assert.equal(result.content, html, 'provider must preserve every byte');
    assert.equal(directCalls, 1);
    assert.equal(calls.length, 0, 'successful direct fetch makes no paid or quota calls');
    const parsed = extractReviewsFromDTLI(result.content, slug);
    assert.equal(parsed.length, classes.length);
    assert.ok(parsed.every(review => review.dtliExcerpt.includes('invented excerpt')));
    assert.ok(parsed.every(review => review.url.startsWith('https://www.theatermania.com/')));
    assert.ok(parsed.every(review => review.dtliThumb === 'Up'));
  });
}

for (const [label, response] of [
  ['HTTP 403', () => new Response('Forbidden', { status: 403 })],
  ['HTTP 404', () => new Response('Not found', { status: 404 })],
  ['Cloudflare HTTP 200', () => new Response('<html><title>Just a moment...</title></html>')],
  ['empty HTML', () => new Response('')],
  ['page shell without reviews', () => new Response('<html><title>Hamilton - Did They Like It?</title><body>Loading reviews</body></html>')],
  ['truncated HTML', () => new Response(page('hamilton', 'Hamilton').replace('</html>', ''))],
  ['network failure', () => { throw new Error('connection reset'); }],
  ['timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }],
]) {
  test(`DTLI ${label} falls through to the existing provider chain`, async () => {
    global.fetch = async () => response();
    const result = await scraper.fetchPage('https://didtheylikeit.com/shows/hamilton/');
    assert.equal(result.source, 'brightdata');
    assert.equal(result.content, paidHtml);
    assert.deepEqual(calls.map(call => call.hostname), ['api.brightdata.com'], 'retain the DTLI Scrapingdog skip');
  });
}

// BRO-7532 recheck: DTLI answers an unopened show with its own "Page not found"
// document, which the paid chain fetched (and returned as a success) every poll.
const dtli404 = '<html><head><title>Page not found - Did They Like It?</title></head><body><h1>Page not found</h1>' + 'site chrome '.repeat(1200) + '</body></html>';

test('DTLI genuine 404 document is answered directly, no paid call', async () => {
  global.fetch = async () => new Response(dtli404, { status: 404 });
  const result = await scraper.fetchPage('https://didtheylikeit.com/shows/hamilton/', { skipVerify: true });
  assert.equal(result.source, 'direct');
  assert.equal(result.content, dtli404);
  assert.equal(calls.length, 0, 'no paid or quota calls for a page DTLI has not created');
  assert.equal(extractReviewsFromDTLI(result.content, 'hamilton').length, 0);
});

test('DTLI_DIRECT_404_PAID=1 restores the paid chain after a direct 404', async (t) => {
  process.env.DTLI_DIRECT_404_PAID = '1';
  t.after(() => { delete process.env.DTLI_DIRECT_404_PAID; });
  global.fetch = async () => new Response(dtli404, { status: 404 });
  const result = await scraper.fetchPage('https://didtheylikeit.com/shows/hamilton/');
  assert.equal(result.source, 'brightdata');
});

test('wrong canonical falls back even when direct HTML contains reviews', async () => {
  global.fetch = async () => new Response(page('wicked', 'Wicked'));
  const result = await scraper.fetchPage('https://didtheylikeit.com/shows/hamilton/');
  assert.equal(result.source, 'brightdata');
  assert.equal(result.content, paidHtml);
});

test('www DTLI show pages use the same direct route', async () => {
  global.fetch = async () => new Response(paidHtml);
  assert.equal((await scraper.fetchPage('https://www.didtheylikeit.com/shows/hamilton/')).source, 'direct');
  assert.equal(calls.length, 0);
});

test('explicit preferPlaywright retains the caller-selected route', async () => {
  global.fetch = async () => assert.fail('explicit browser preference must skip direct fetch');
  // No real browser launch: fail the first tier and verify the usual fallback.
  scraper.__setChromiumForTest({ launch: async () => { throw new Error('test browser unavailable'); } });
  assert.equal((await scraper.fetchPage('https://didtheylikeit.com/shows/hamilton/', { preferPlaywright: true })).source, 'brightdata');
});

for (const url of [
  'https://example.com/shows/hamilton/',
  'https://didtheylikeit.com.example.com/shows/hamilton/',
  'https://didtheylikeit.com/',
  'https://didtheylikeit.com/shows/',
  'https://didtheylikeit.com/shows-sitemap.xml',
  'http://didtheylikeit.com/shows/hamilton/',
]) {
  test(`existing routing remains unchanged for ${url}`, async () => {
    global.fetch = async () => assert.fail('direct route must be limited to HTTPS DTLI show pages');
    paidHtml = paidHtml.replace('https://didtheylikeit.com/shows/hamilton/', url);
    assert.equal((await scraper.fetchPage(url)).source,
      new URL(url).hostname.replace(/^www\./, '') === 'didtheylikeit.com' ? 'brightdata' : 'scrapingdog');
  });
}

// BRO-7532: theatre.reviews round-ups try one direct GET first, then the unchanged paid chain.
const trUrl = 'https://theatre.reviews/reviews-roundup/cleansed-reviews/';
const trPage = `<html><head><title>Cleansed reviews</title></head><body><h1>Cleansed reviews</h1>${'<p>⭑⭑⭑⭑ Invented critic quote about the production that is long enough to look like a real round-up page body.</p>'.repeat(12)}</body></html>`;

test('theatre.reviews round-up: real direct 200 makes no paid call', async () => {
  global.fetch = async () => new Response(trPage, { status: 200 });
  const result = await scraper.fetchPage(trUrl, { skipVerify: true });
  assert.equal(result.source, 'direct');
  assert.equal(result.content, trPage);
  assert.equal(calls.length, 0);
});

for (const [label, response] of [
  ['HTTP 403', () => new Response('Forbidden', { status: 403 })],
  ['HTTP 404', () => new Response(trPage, { status: 404 })],
  ['200 without a star marker (interstitial)', () => new Response('<html>cleantalk apbct check</html>', { status: 200 })],
  ['network failure', () => { throw new Error('connection reset'); }],
]) {
  test(`theatre.reviews ${label} falls through to the paid chain`, async () => {
    global.fetch = async () => response();
    paidHtml = trPage;
    const result = await scraper.fetchPage(trUrl, { skipVerify: true });
    assert.notEqual(result.source, 'direct');
    assert.ok(calls.length > 0, 'paid chain ran');
  });
}

test('theatre.reviews non-round-up paths keep their existing route', async () => {
  global.fetch = async () => assert.fail('direct route is limited to /reviews-roundup/');
  paidHtml = trPage;
  const result = await scraper.fetchPage('https://theatre.reviews/category/reviews-roundup/', { skipVerify: true });
  assert.notEqual(result.source, 'direct');
  assert.ok(calls.length > 0, 'paid chain ran');
});

test('theatre.reviews round-up redirected to another path falls through to the paid chain', async () => {
  global.fetch = async () => { const r = new Response(trPage, { status: 200 }); Object.defineProperty(r, 'url', { value: 'https://theatre.reviews/login/' }); return r; };
  paidHtml = trPage;
  const result = await scraper.fetchPage(trUrl, { skipVerify: true });
  assert.notEqual(result.source, 'direct');
  assert.ok(calls.length > 0);
});
