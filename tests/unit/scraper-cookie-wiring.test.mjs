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
 * Strategy: monkey-patch https.get / https.request to capture args without
 * actually making network calls. Assert Cookie header / cookies param shows up
 * where expected. Responses are stubbed 404 so each fetch returns null cleanly.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'module';

// IMPORTANT: scraper.js caches BRIGHTDATA_TOKEN / SCRAPINGBEE_API_KEY at module
// load time. Set placeholders here BEFORE requiring the module so each backend
// will attempt an https call (which our monkey-patched stubs then capture).
process.env.BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN || 'test-bd-token';
process.env.SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || 'test-sb-key';

const require = createRequire(import.meta.url);
const https = require('https');
const scraper = require('../../scripts/lib/scraper');
const cookieLoader = require('../../scripts/lib/cookie-loader');

const origGet = https.get;
const origRequest = https.request;

let capturedGets = [];
let capturedRequests = [];

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
}

function restoreStubs() {
  https.get = origGet;
  https.request = origRequest;
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
      // Should not have dispatched any request
      assert.equal(capturedGets.length, 0);
    });

    test('sends Cookie header when WSJ cookies present', async () => {
      setBundleEnv({
        wsj: [
          { name: 'sess', value: 'abc123', domain: '.wsj.com', path: '/' },
          { name: 'tok', value: 'xyz789', domain: '.wsj.com', path: '/' },
        ],
      });

      await scraper.fetchWithCookiesPlain('https://www.wsj.com/articles/proof-review');

      assert.equal(capturedGets.length, 1, 'one https.get call expected');
      const call = capturedGets[0];
      assert.ok(call.opts.headers, 'opts.headers should exist');
      assert.ok(call.opts.headers.Cookie, 'Cookie header should be set');
      assert.ok(/sess=abc123/.test(call.opts.headers.Cookie), `Cookie should include sess=abc123 (got: ${call.opts.headers.Cookie})`);
      assert.ok(/tok=xyz789/.test(call.opts.headers.Cookie), `Cookie should include tok=xyz789 (got: ${call.opts.headers.Cookie})`);
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

      assert.equal(capturedGets.length, 1);
      const sbUrl = capturedGets[0].url;
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

      assert.equal(capturedGets.length, 1);
      const sbUrl = capturedGets[0].url;
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
