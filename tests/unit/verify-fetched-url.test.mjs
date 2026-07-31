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

    // Regression for 2026-04-24 NY Post 2019 backfill:
    // SERP URL had HTML-encoded `&amp;utm_*` params that parse as keys
    // `amp;utm_campaign` / `amp;utm_source`. Pre-fix regex /^utm_|^fbclid/
    // didn't strip them, so ink-2019 burned Cookie-plain → BD → SB → Playwright.
    test('HTML-encoded &amp;utm_* tracking params do not break match', () => {
      const html = '<html><head><link rel="canonical" href="https://nypost.com/2019/04/24/ink-review-broadways-latest-is-a-scrappy-seductive-tabloid-tale/"></head></html>';
      const url = 'https://nypost.com/2019/04/24/ink-review-broadways-latest-is-a-scrappy-seductive-tabloid-tale/?utm_medium=SocialFlow&amp;utm_campaign=SocialFlow&amp;utm_source=NYPTwitter';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });

    // Regression for kiss-me-kate-2019 (same backfill):
    // Request URL was http://, canonical returned https://. Previous normalizer
    // kept `parsed.toString()` which retained the scheme → mismatch.
    test('http request vs https canonical (scheme diff) does not break match', () => {
      const html = '<html><head><link rel="canonical" href="https://nypost.com/2019/03/14/raunchy-gutsy-kiss-me-kate-showcases-glorious-kelli-ohara/"></head></html>';
      const url = 'http://nypost.com/2019/03/14/raunchy-gutsy-kiss-me-kate-showcases-glorious-kelli-ohara/';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });

    // Non-utm tracking params (gclid, ref, share, etc.) should also not break match
    // since canonical URLs are query-free by convention.
    test('gclid / non-utm tracking params do not break match', () => {
      const html = '<html><head><link rel="canonical" href="https://example.com/article/proof"></head></html>';
      const url = 'https://example.com/article/proof?gclid=abc123&ref=twitter&share=fb';
      assert.equal(verifyFetchedUrl(html, url).verified, true);
    });

    test('hash fragment ignored', () => {
      const html = '<html><head><link rel="canonical" href="https://example.com/article/proof"></head></html>';
      const url = 'https://example.com/article/proof#section-2';
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

  // Regressions for task #702 (audit: data/audit/url-mismatch-suspects.json,
  // 7,114 entries, 6,301 across these two hosts burning the full provider chain).
  describe('invisible Unicode and same-host suffix redirects (task #702)', () => {
    test('theatre.reviews trailing U+200E LEFT-TO-RIGHT MARK → verified true', () => {
      const html = '<html><head><link rel="canonical" href="https://theatre.reviews/reviews-roundup/the-truth-apollo-reviews/‎"></head></html>';
      const url = 'https://theatre.reviews/reviews-roundup/the-truth-apollo-reviews/';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
    });

    test('didtheylikeit.com short slug → full canonical slug suffix → verified true', () => {
      const html = '<html><head><link rel="canonical" href="https://didtheylikeit.com/shows/the-gin-game-review/"></head></html>';
      const url = 'https://didtheylikeit.com/shows/the-gin-game/';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
    });

    test('didtheylikeit.com hamlet → hamlet-a-version-review → verified true', () => {
      const html = '<html><head><link rel="canonical" href="https://didtheylikeit.com/shows/hamlet-a-version-review/"></head></html>';
      const url = 'https://didtheylikeit.com/shows/hamlet/';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
    });

    test('same-host but nested under an unrelated slug → still url_mismatch', () => {
      // Real audit entry: /shows/well/ resolved to a page filed under a totally
      // different show's directory ("its-only-a-play/..."). Different directory
      // depth AND unrelated content — must NOT be treated as a suffix redirect.
      const html = '<html><head><link rel="canonical" href="https://didtheylikeit.com/shows/its-only-a-play/well-did-whats-his-name-like-it/"></head></html>';
      const url = 'https://didtheylikeit.com/shows/well/';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('genuine cross-host mismatch still rejected after normalization changes', () => {
      const html = '<html><head><link rel="canonical" href="https://www.rottentomatoes.com/m/the-gin-game"></head></html>';
      const url = 'https://didtheylikeit.com/shows/the-gin-game/';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('same-host shorter actual path (homepage-like) is still a mismatch, not a suffix', () => {
      const html = '<html><head><link rel="canonical" href="https://didtheylikeit.com/shows/"></head></html>';
      const url = 'https://didtheylikeit.com/shows/the-gin-game/';
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
