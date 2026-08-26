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

    test('bare substring match against a DIFFERENT show is not accepted (no word boundary)', () => {
      // "proof" is a string-prefix of "proofs" and "proof-2", but those could be a
      // genuinely different production. Without a boundary requirement, this heuristic
      // would misattribute reviews across shows — must stay a mismatch.
      const html1 = '<html><head><link rel="canonical" href="https://didtheylikeit.com/shows/proofs/"></head></html>';
      assert.equal(verifyFetchedUrl(html1, 'https://didtheylikeit.com/shows/proof/').verified, false);

      const html2 = '<html><head><link rel="canonical" href="https://didtheylikeit.com/shows/proofread/"></head></html>';
      assert.equal(verifyFetchedUrl(html2, 'https://didtheylikeit.com/shows/proof/').verified, false);
    });

    test('suffix redirect at a hyphen boundary is still accepted and tagged suffix_redirect', () => {
      const html = '<html><head><link rel="canonical" href="https://didtheylikeit.com/shows/proof-2026-review/"></head></html>';
      const result = verifyFetchedUrl(html, 'https://didtheylikeit.com/shows/proof-2026/');
      assert.equal(result.verified, true);
      assert.equal(result.reason, 'suffix_redirect');
    });
  });

  // Regressions for task #6: Variety review URLs failing extraction because
  // verifyFetchedUrl only compared full paths, and Variety's permalink scheme
  // varies (category slug, era) while the numeric post ID stays constant.
  describe('trailing numeric post-ID match (task #6, Variety)', () => {
    test('same post ID, different category slug (tv vs legit) → verified true', () => {
      // Real case: variety.com canonical tag disagrees with og:url on which
      // category ("tv" vs "legit") the same review URL belongs under.
      const html = '<html><head><link rel="canonical" href="https://variety.com/2026/legit/reviews/daniel-radcliffe-every-brilliant-thing-broadway-review-1236685975/"></head></html>';
      const url = 'https://variety.com/2026/tv/reviews/daniel-radcliffe-every-brilliant-thing-broadway-review-1236685975/';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
      assert.equal(result.reason, 'post_id_match');
    });

    test('legacy VE<id> URL redirects to modern permalink sharing the same ID → verified true', () => {
      // Real case: legacy variety.com/review/VE<id> URL, totally different
      // directory structure than the modern /YYYY/legit/reviews/<slug>-<id>/
      // permalink — same article, same trailing numeric ID.
      const html = '<html><head><link rel="canonical" href="https://variety.com/2012/legit/reviews/the-producers-1117947963/"></head></html>';
      const url = 'http://www.variety.com/review/VE1117947963?refCatId=33';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
      assert.equal(result.reason, 'post_id_match');
    });

    test('different post IDs on the same host → still url_mismatch (no false accept)', () => {
      const html = '<html><head><link rel="canonical" href="https://variety.com/2009/legit/reviews/joe-turner-review-1234567890/"></head></html>';
      const url = 'https://variety.com/2009/film/awards/joe-turner-9876543210/';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('short numeric suffix (<6 digits) does not trigger post-ID match', () => {
      const html = '<html><head><link rel="canonical" href="https://example.com/archive/2026/article-99999"></head></html>';
      const url = 'https://example.com/news/2026/other-99999';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('post-ID match is host-scoped: BroadwayWorld date-suffixed URLs do NOT false-accept', () => {
      // Regression for a second-opinion review finding: BWW's
      // Review-Roundup-<SHOW>-<MMDDYYYY> scheme carries an 8-digit date
      // suffix. Two different shows' roundups published the same date must
      // NOT verify as the same article just because the trailing digits
      // match — the post-ID rule only applies to allowlisted hosts.
      const html = '<html><head><link rel="canonical" href="https://www.broadwayworld.com/article/Review-Roundup-HAMILTON-20260416"></head></html>';
      const url = 'https://www.broadwayworld.com/article/Review-Roundup-PROOF-20260416';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });
  });

  // Regressions for BRO-151: audit of url-mismatch-suspects.json top hosts for
  // Variety-class (task #6) fixable permalink drift — same article, unstable
  // path structure, but a stable identifying token survives the redirect.
  describe('BRO-151: additional Variety-class permalink drift hosts', () => {
    test('ft.com legacy /cms/s/ UUID → modern /content/ UUID → verified true', () => {
      // Real audit entry: ft.com's pre-2016 /cms/s/<n>/<uuid>.html permalink
      // redirects to /content/<uuid> — entirely different directory depth,
      // same content UUID.
      const html = '<html><head><link rel="canonical" href="https://www.ft.com/content/b3bf1f32-c955-11e3-bba1-00144feabdc0"></head></html>';
      const url = 'https://www.ft.com/cms/s/2/b3bf1f32-c955-11e3-bba1-00144feabdc0.html#axzz2zf02IMhe';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
      assert.equal(result.reason, 'post_id_match');
    });

    test('ft.com UUID with trailing ",Authorised=false.html" cruft still matches', () => {
      const html = '<html><head><link rel="canonical" href="https://www.ft.com/content/ec544b46-6bea-11e4-b939-00144feabdc0"></head></html>';
      const url = 'https://www.ft.com/cms/s/ec544b46-6bea-11e4-b939-00144feabdc0,Authorised=false.html?siteedition=uk';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
      assert.equal(result.reason, 'post_id_match');
    });

    test('ft.com different UUIDs on the same host → still url_mismatch', () => {
      const html = '<html><head><link rel="canonical" href="https://www.ft.com/content/aaaaaaaa-1111-2222-3333-444444444444"></head></html>';
      const url = 'https://www.ft.com/cms/s/2/bbbbbbbb-1111-2222-3333-444444444444.html';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('ft.com post-ID match is host-scoped: same UUID shape on another host does not false-accept', () => {
      const html = '<html><head><link rel="canonical" href="https://example.com/content/b3bf1f32-c955-11e3-bba1-00144feabdc0"></head></html>';
      const url = 'https://example.com/cms/s/2/b3bf1f32-c955-11e3-bba1-00144feabdc0.html';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('show-score.com re-categorized show (broadway-shows → uk off-west-end) → verified true', () => {
      // Real audit entry: show-score.com moved the show from a Broadway
      // category directory to a London off-West-End one, keeping the same
      // show slug.
      const html = '<html><head><link rel="canonical" href="https://www.show-score.com/uk/london/off-west-end-shows/the-car-man"></head></html>';
      const url = 'https://www.show-score.com/broadway-shows/the-car-man';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
      assert.equal(result.reason, 'category_redirect');
    });

    test('show-score.com off-broadway → off-off-broadway re-categorization → verified true', () => {
      const html = '<html><head><link rel="canonical" href="https://www.show-score.com/off-off-broadway-shows/camping"></head></html>';
      const url = 'https://www.show-score.com/off-broadway-shows/camping';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
      assert.equal(result.reason, 'category_redirect');
    });

    test('show-score.com category-drift match is host-scoped and still requires a word boundary', () => {
      // Different show slug sharing a prefix ("bull" vs "bulletproof") must
      // NOT false-accept just because a category directory also changed.
      const html = '<html><head><link rel="canonical" href="https://www.show-score.com/uk/london/off-west-end-shows/bulletproof"></head></html>';
      const url = 'https://www.show-score.com/broadway-shows/bull';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('show-score.com category-drift rule does not apply to other hosts', () => {
      const html = '<html><head><link rel="canonical" href="https://example.com/off-off-broadway-shows/camping"></head></html>';
      const url = 'https://example.com/off-broadway-shows/camping';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, false);
      assert.equal(result.reason, 'url_mismatch');
    });

    test('todaytix.com relative og:url with query params resolves against the request URL → verified true', () => {
      // Real audit entry: todaytix.com's og:url tag is a bare relative path
      // (no scheme/host) plus experiment-flag query params. Previously
      // `new URL(actualUrl)` threw on the relative string, so it was compared
      // as a raw lowercased string against a full hostname+path and always
      // failed even though the underlying page matched exactly.
      const html = '<html><head><meta property="og:url" content="/nyc/shows/46224-loves-labours-lost?tt-web-enable-new-homepage=off&amp;viewport=desktop"></head></html>';
      const url = 'https://www.todaytix.com/nyc/shows/46224-loves-labours-lost';
      const result = verifyFetchedUrl(html, url);
      assert.equal(result.verified, true);
    });

    test('todaytix.com relative og:url pointing to a genuinely different show still rejects', () => {
      const html = '<html><head><meta property="og:url" content="/nyc/shows/46801-fish"></head></html>';
      const url = 'https://www.todaytix.com/nyc/shows/46801-ish';
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
