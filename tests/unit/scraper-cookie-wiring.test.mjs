/**
 * Integration tests for cookie-loader wiring into scripts/lib/scraper.js.
 *
 * Rationale: scripts/lib/cookie-loader.js was orphaned for months — the maps
 * existed but nothing in the scraper fallback chain actually attached cookies to
 * outbound requests. This test freezes the contract: when cookies are present
 * for a URL's domain, each of the three backends (plain HTTPS, Bright Data,
 * ScrapingBee) must propagate them. Without this guard, future refactors can
 * silently drop cookies again and paywalls go dark.
 *
 * Strategy:
 *   - Plain path (fetch-plain.js, uses global fetch / undici): undici MockAgent
 *     intercepts at the undici layer. Survives refactors between fetch() and
 *     undici.request() — both go through the same dispatcher.
 *   - Bright Data + ScrapingBee paths (still use https.get / https.request):
 *     monkey-patch https.* and capture call args. Keep as-is until those callers
 *     migrate too.
 *
 * Migration history: 432a4bbf35 swapped fetchWithCookiesPlain from https.get
 * to global fetch (DataDome TLS fingerprinting bypass). The first test patch
 * (6df524db96) monkey-patched globalThis.fetch — survived that one migration
 * but would break the next (e.g., undici.request, axios). MockAgent is the
 * blessed undici-layer interception that survives any client that ultimately
 * routes through undici's dispatcher.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'module';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

// IMPORTANT: scraper.js caches BRIGHTDATA_TOKEN / SCRAPINGBEE_API_KEY at module
// load time. Set placeholders here BEFORE requiring the module so each backend
// will attempt an https call (which our monkey-patched stubs then capture).
process.env.BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN || 'test-bd-token';
process.env.SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || 'test-sb-key';

// Neutralize the Bright Data daily cost breaker for this file.
//
// fetchWithBrightData() consults consultBrightData() (scripts/lib/scraper.js,
// just above the try block) BEFORE it builds a request, and returns null when
// the zone's daily breaker has tripped. The breaker's state lives in
// data/audit/bd-circuit-breaker.json — a GIT-TRACKED file that an hourly cron
// commits with real production spend. So without this line the outcome of a
// pure cookie-wiring unit test depends on how much Bright Data quota the site
// happened to burn today: on 2026-08-14 the file said 2768 billed against a
// 2250 ceiling, fetchWithBrightData early-returned, both BD tests captured
// zero https.request calls, and Unit Tests went red on main for a reason that
// had nothing to do with cookies. It would have gone green again by itself the
// next UTC day, which is worse than a stable failure — the test was a coin
// flip on live cost data.
//
// This file asserts that cookies reach body.headers.Cookie. The cost breaker
// is a different contract with its own tests (scripts/lib/brightdata-caps.test.mjs).
process.env.BD_CAPS_DISABLED = '1';

const require = createRequire(import.meta.url);
const https = require('https');
const scraper = require('../../scripts/lib/scraper');
const cookieLoader = require('../../scripts/lib/cookie-loader');

const origGet = https.get;
const origRequest = https.request;
const origDispatcher = getGlobalDispatcher();

let capturedGets = [];           // https.get stub (SB path)
// The SB *scrape* GETs only. Sprint 1 of the scraping-cost work (commit
// 6625731b034) made fetchWithScrapingBee fire checkScrapingBeeCredits() as a
// fire-and-forget proactive exhaustion check, which issues its own https.get to
// .../api/v1/usage. These assertions were written before that existed and
// counted "exactly one GET", so they broke on a behavior change that is
// correct. Filter to the scrape endpoint instead of counting every GET —
// counting raw dispatches made this test brittle to any new side-channel call.
const scrapeGets = () => capturedGets.filter((g) => !/\/api\/v1\/usage/.test(g.url));

let capturedRequests = [];        // https.request stub (BD path)
let capturedUndiciRequests = []; // undici/fetch MockAgent (plain path)
let mockAgent = null;

function fakeResponse(statusCode = 404, body = '') {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = {};
  res.resume = () => {};
  setImmediate(() => {
    res.emit('data', body);
    res.emit('end');
  });
  return res;
}

function installStubs() {
  capturedGets = [];
  capturedRequests = [];
  capturedUndiciRequests = [];

  https.get = (url, optsOrCb, cb) => {
    let opts = optsOrCb;
    let callback = cb;
    if (typeof optsOrCb === 'function') {
      callback = optsOrCb;
      opts = {};
    }
    const urlStr = typeof url === 'string' ? url : url.href || String(url);
    capturedGets.push({ url: urlStr, opts: opts || {} });

    const req = new EventEmitter();
    req.destroy = () => {};
    req.setTimeout = () => {};
    setImmediate(() => { if (callback) callback(fakeResponse(404, '')); });
    return req;
  };

  https.request = (url, optsOrCb, cb) => {
    let opts = optsOrCb;
    let callback = cb;
    if (typeof optsOrCb === 'function') {
      callback = optsOrCb;
      opts = {};
    }
    const urlStr = typeof url === 'string' ? url : url.href || String(url);
    const captured = { url: urlStr, opts: opts || {}, body: null };
    capturedRequests.push(captured);

    const req = new EventEmitter();
    req.end = (body) => {
      captured.body = body;
      setImmediate(() => { if (callback) callback(fakeResponse(404, '')); });
    };
    req.destroy = () => {};
    req.setTimeout = () => {};
    return req;
  };

  // undici MockAgent intercepts global fetch and undici.request at the dispatcher
  // layer. Use a catch-all interceptor that records every request and returns 404.
  // Survives refactors within the fetch/undici client family — only breaks if the
  // codebase migrates to a non-undici HTTP client (axios, etc.) which is unlikely.
  mockAgent = new MockAgent({ connections: 1 });
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  // Pool any origin we expect to hit. Interceptors are registered per (origin, path)
  // and reply with a 404 stub while capturing the request shape for assertions.
  for (const origin of ['https://www.wsj.com', 'https://example.com']) {
    const pool = mockAgent.get(origin);
    pool.intercept({ path: () => true, method: 'GET' }).reply(404, '', {
      headers: { 'content-type': 'text/html' },
    }).persist().times(10);
    // MockPool's onRequest hook isn't directly exposed for capture; instead we
    // wrap the underlying intercept. Since intercept returns a synchronous reply,
    // we capture via a thin override on dispatcher.dispatch below.
  }

  // Wrap dispatcher.dispatch to capture each outbound request (url + headers).
  const origDispatch = mockAgent.dispatch.bind(mockAgent);
  mockAgent.dispatch = (opts, handler) => {
    // opts has .origin (or .url), .path, .method, .headers
    const url = (opts.origin || '') + (opts.path || '');
    const headers = {};
    if (opts.headers) {
      if (Array.isArray(opts.headers)) {
        for (let i = 0; i < opts.headers.length; i += 2) {
          headers[opts.headers[i]] = opts.headers[i + 1];
        }
      } else if (typeof opts.headers === 'object') {
        Object.assign(headers, opts.headers);
      }
    }
    capturedUndiciRequests.push({ url, opts: { headers }, method: opts.method });
    return origDispatch(opts, handler);
  };
}

function restoreStubs() {
  https.get = origGet;
  https.request = origRequest;
  if (mockAgent) {
    mockAgent.close().catch(() => {});
    mockAgent = null;
  }
  setGlobalDispatcher(origDispatcher);
}

function setBundleEnv(bundleObj) {
  const encoded = Buffer.from(JSON.stringify(bundleObj)).toString('base64');
  process.env.COOKIES_BUNDLE_WSJ = encoded;
  cookieLoader.clearCache();
}

function clearBundleEnv() {
  delete process.env.COOKIES_BUNDLE_WSJ;
  delete process.env.WSJ_COOKIES;
  cookieLoader.clearCache();
}

describe('scraper cookie wiring', () => {
  beforeEach(() => {
    installStubs();
  });

  afterEach(() => {
    restoreStubs();
    clearBundleEnv();
  });

  describe('fetchWithCookiesPlain', () => {
    test('returns null when no cookies for domain', async () => {
      clearBundleEnv();
      const result = await scraper.fetchWithCookiesPlain('https://example.com/any');
      assert.equal(result, null);
      // Should not have dispatched any request (neither https.get nor undici)
      assert.equal(scrapeGets().length, 0);
      assert.equal(capturedUndiciRequests.length, 0);
    });

    test('sends Cookie header when WSJ cookies present', async () => {
      setBundleEnv({
        wsj: [
          { name: 'sess', value: 'abc123', domain: '.wsj.com', path: '/' },
          { name: 'tok', value: 'xyz789', domain: '.wsj.com', path: '/' },
        ],
      });

      await scraper.fetchWithCookiesPlain('https://www.wsj.com/articles/proof-review');

      // Captured via undici MockAgent (plain path uses global fetch / undici).
      assert.equal(capturedUndiciRequests.length, 1, 'one undici dispatch expected');
      const call = capturedUndiciRequests[0];
      assert.ok(call.opts.headers, 'request headers should exist');
      const cookie = call.opts.headers.Cookie || call.opts.headers.cookie;
      assert.ok(cookie, 'Cookie header should be set');
      assert.ok(/sess=abc123/.test(cookie), `Cookie should include sess=abc123 (got: ${cookie})`);
      assert.ok(/tok=xyz789/.test(cookie), `Cookie should include tok=xyz789 (got: ${cookie})`);
    });
  });

  describe('fetchWithBrightData', () => {
    test('includes Cookie in body.headers when cookies present', async () => {
      setBundleEnv({
        wsj: [{ name: 'sess', value: 'abc123', domain: '.wsj.com', path: '/' }],
      });

      await scraper.fetchWithBrightData('https://www.wsj.com/articles/proof-review');

      assert.equal(capturedRequests.length, 1, 'one https.request call expected');
      const parsed = JSON.parse(capturedRequests[0].body);
      assert.ok(parsed.headers, 'BD body.headers should exist when cookies present');
      assert.ok(parsed.headers.Cookie, 'BD body.headers.Cookie should be set');
      assert.ok(/sess=abc123/.test(parsed.headers.Cookie));
    });

    test('omits headers field when no cookies (backward compat)', async () => {
      clearBundleEnv();

      await scraper.fetchWithBrightData('https://example.com/any');

      assert.equal(capturedRequests.length, 1);
      const parsed = JSON.parse(capturedRequests[0].body);
      assert.equal(parsed.headers, undefined, 'BD body.headers should not exist when no cookies');
      assert.equal(parsed.format, 'raw');
      assert.equal(parsed.url, 'https://example.com/any');
    });
  });

  describe('fetchWithScrapingBee', () => {
    test('appends cookies param to SB URL when cookies present', async () => {
      setBundleEnv({
        wsj: [{ name: 'sess', value: 'abc123', domain: '.wsj.com', path: '/' }],
      });

      await scraper.fetchWithScrapingBee('https://www.wsj.com/articles/proof-review');

      assert.equal(scrapeGets().length, 1);
      const sbUrl = scrapeGets()[0].url;
      assert.ok(/[?&]cookies=/.test(sbUrl), `SB URL should include cookies param (got: ${sbUrl})`);
      // cookie header value is URL-encoded in the param
      const match = sbUrl.match(/[?&]cookies=([^&]+)/);
      assert.ok(match, 'cookies param should have a value');
      const decoded = decodeURIComponent(match[1]);
      assert.ok(/sess=abc123/.test(decoded), `decoded cookies param should include sess=abc123 (got: ${decoded})`);
    });

    test('no cookies param when no cookies for domain', async () => {
      clearBundleEnv();

      await scraper.fetchWithScrapingBee('https://example.com/any');

      assert.equal(scrapeGets().length, 1);
      const sbUrl = scrapeGets()[0].url;
      assert.equal(/[?&]cookies=/.test(sbUrl), false, 'SB URL should not include cookies param');
    });
  });

  describe('cookie-loader integration', () => {
    test('buildCookieHeaderForUrl returns joined pairs for cookie-gated domain', () => {
      setBundleEnv({
        wsj: [
          { name: 'a', value: '1', domain: '.wsj.com' },
          { name: 'b', value: '2', domain: '.wsj.com' },
        ],
      });
      const header = cookieLoader.buildCookieHeaderForUrl('https://www.wsj.com/articles/foo');
      assert.ok(header, 'header should exist');
      assert.ok(/a=1/.test(header));
      assert.ok(/b=2/.test(header));
    });

    test('hasCookiesForUrl returns the matched domain key', () => {
      setBundleEnv({
        wsj: [{ name: 'a', value: '1', domain: '.wsj.com' }],
      });
      assert.equal(cookieLoader.hasCookiesForUrl('https://www.wsj.com/articles/foo'), 'wsj.com');
      assert.equal(cookieLoader.hasCookiesForUrl('https://example.com/'), null);
    });
  });
});
