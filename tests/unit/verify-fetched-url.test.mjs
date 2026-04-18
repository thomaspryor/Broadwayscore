/**
 * Unit tests for verifyFetchedUrl (Pattern Card #5)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { verifyFetchedUrl } = require('../../scripts/lib/scraper');

describe('verifyFetchedUrl', () => {
  describe('homepage title detection', () => {
    test('BWW homepage title → not verified', () => {
      const html = '<html><head><title>BroadwayWorld: Latest News...</title></head></html>';
      const url = 'https://www.broadwayworld.com/article/Review-Roundup-PROOF-20260416';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'title_matches_homepage');
    });

    test('WSJ homepage title → not verified', () => {
      const html = '<html><head><title>The Wall Street Journal</title></head></html>';
      const url = 'https://www.wsj.com/articles/proof-review-2026';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'title_matches_homepage');
    });

    test('homepage title check skipped for root URL requests', () => {
      const html = '<html><head><title>BroadwayWorld: Latest News...</title></head></html>';
      const url = 'https://www.broadwayworld.com/';
      const result = verifyFetchedUrl(html, url);
      assert.notEqual(result.reason, 'title_matches_homepage');
    });

    test('article title does not trigger homepage detection', () => {
      const html = '<html><head><title>Proof Review: A Captivating Production</title><link rel="canonical" href="https://www.broadwayworld.com/article/proof-review"></head></html>';
      const url = 'https://www.broadwayworld.com/article/proof-review';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
    });
  });

  describe('canonical URL verification', () => {
    test('no canonical tag → passes through (cannot verify but cannot disprove)', () => {
      const html = '<html><head><title>Proof Review</title></head><body>content</body></html>';
      const url = 'https://www.broadwayworld.com/article/Review-Roundup-PROOF-20260416';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
      assert.equal(result.reason, 'no_canonical');
    });

    test('canonical URL matches → verified', () => {
      const html = '<html><head><link rel="canonical" href="https://www.broadwayworld.com/article/proof"></head></html>';
      const url = 'https://www.broadwayworld.com/article/proof';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });

    test('og:url fallback when no canonical link', () => {
      const html = '<html><head><meta property="og:url" content="https://www.broadwayworld.com/article/proof"></head></html>';
      const url = 'https://www.broadwayworld.com/article/proof';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });

    test('same-domain path mismatch → url_mismatch', () => {
      const html = '<html><head><link rel="canonical" href="https://www.broadwayworld.com/"></head></html>';
      const url = 'https://www.broadwayworld.com/article/Review-Roundup-PROOF-20260416';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('trailing slash difference is normalized', () => {
      const html = '<html><head><link rel="canonical" href="https://example.com/article/proof/"></head></html>';
      const url = 'https://example.com/article/proof';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });

    test('utm_* params stripped in comparison', () => {
      const html = '<html><head><link rel="canonical" href="https://example.com/article/proof?utm_source=google&utm_medium=cpc"></head></html>';
      const url = 'https://example.com/article/proof';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });
  });

  describe('domain alias handling', () => {
    test('vulture.com → nymag.com alias → verified', () => {
      const html = '<html><head><link rel="canonical" href="https://www.nymag.com/article/foo"></head></html>';
      const url = 'https://www.vulture.com/article/foo';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });

    test('amp subdomain → verified', () => {
      const html = '<html><head><link rel="canonical" href="https://amp.nytimes.com/review/foo"></head></html>';
      const url = 'https://www.nytimes.com/review/foo';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });

    test('completely unrelated domain → url_mismatch', () => {
      const html = '<html><head><link rel="canonical" href="https://www.rottentomatoes.com/m/proof"></head></html>';
      const url = 'https://www.broadwayworld.com/article/proof';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });
  });

  describe('edge cases', () => {
    test('missing input → not verified', () => {
      assert.equal(verifyFetchedUrl('', 'https://example.com/foo').verified, false);
      assert.equal(verifyFetchedUrl(null, 'https://example.com/foo').verified, false);
      assert.equal(verifyFetchedUrl('<html></html>', '').verified, false);
    });
  });
});
