/**
 * Regression tests for task #6: NYT (+ Variety) review-body extraction.
 *
 * Two independent failure modes are covered here:
 *
 *  1. Cookie-authenticated fetch (NYT): data/cookies/nytimes.json (Cookie-plain
 *     tier, scripts/lib/cookie-loader.js) lets fetchWithCookiesPlain pull the
 *     FULL article body in one shot where CI's logged-out fetch gets
 *     paywall-gated — proven 2026-07-15 on the Whoopi Monologues NYT review
 *     (5,865 chars; see data/review-texts/the-whoopi-monologues-off-broadway-2026/
 *     nytimes--brittani-samuel.json, contentTier: 'complete'). That exact
 *     length is used below as the long-form baseline.
 *  2. Extraction correctness once fetched: scripts/lib/article-extractor.js's
 *     NYT patterns (section[name="articleBody"] / itemprop="articleBody")
 *     must pull the full body, not a truncated teaser, for both long-form and
 *     short (capsule) reviews — and scripts/lib/content-quality.js must then
 *     classify that recovered text as contentTier: 'complete', not
 *     'truncated' or 'excerpt'.
 *
 * The Variety half of the card (verifyFetchedUrl rejecting valid fetches as
 * url_mismatch because Variety's permalink scheme varies while the numeric
 * post ID stays constant) is covered separately in
 * tests/unit/verify-fetched-url.test.mjs ("trailing numeric post-ID match").
 *
 * Per CLAUDE.md §15: require() the real functions; never duplicate logic.
 * Fixture prose below is original (NOT the real copyrighted NYT text) sized
 * to match the real recovered baselines so length-based classification logic
 * is exercised faithfully without embedding copyrighted content in the repo.
 */
import test from 'node:test';
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { extractArticleText } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'article-extractor.js'));
const { classifyContentTier } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));
const { buildCookieHeaderForUrl, clearCache } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'cookie-loader.js'));

// ---------------------------------------------------------------------------
// Fixture prose (original, not scraped real text).
// ---------------------------------------------------------------------------

// Long-form: whole sentences joined until we clear the real Whoopi Monologues
// NYT recovery baseline (5,865 chars, task #6 "PROVEN RECOVERY PATH"
// 2026-07-15), so we never slice mid-sentence/mid-word — that would itself
// look like truncation to detectTruncationSignals.
const LONG_FORM_SENTENCES = [
  'The revival threads real feeling through a night of borrowed voices, and the ensemble commits to every register without once condescending to the material.',
  'What could have been a nostalgia exercise instead argues for itself as a living, breathing piece of theater, alert to its own contradictions.',
  'The direction is unfussy, trusting silence as much as noise, and the design choices never upstage the performers doing the actual work.',
  'There are stretches where the pacing slackens, but the cast pulls the evening back with sheer commitment whenever the text threatens to wander.',
  'By the final scene, the accumulated small choices — a held glance, a half-finished sentence — add up to something genuinely moving.',
];
function buildLongFormReview(minLen) {
  let out = '';
  let i = 0;
  while (out.length < minLen) {
    out += (out ? ' ' : '') + LONG_FORM_SENTENCES[i % LONG_FORM_SENTENCES.length];
    i++;
  }
  return out;
}
const WHOOPI_BASELINE_LEN = 5865; // real recovered length, task #6
const LONG_FORM_REVIEW = buildLongFormReview(WHOOPI_BASELINE_LEN);

// Short-form (capsule review): ~150+ words, proper ending, real opinion
// vocabulary — exercises content-quality.js's Path 3 "short but structurally
// complete" branch, which is what a terse T1 capsule review (recovered in
// full, not truncated) actually looks like.
const SHORT_FORM_REVIEW = [
  'A tight seventy minutes, confidently staged, with a lead performance that is genuinely electrifying from the opening scene onward.',
  'The direction is sharp and unsentimental, and the design never overreaches, letting the writing carry the weight it was built for.',
  'It is a captivating, unshowy piece of work that earns its emotional turns rather than demanding them, and the small ensemble is uniformly strong.',
  'A few transitions land awkwardly, but nothing dulls the impact of a script this confident in its own voice.',
  'The supporting cast finds real specificity in roles that could easily have been played as types, and the pacing rarely drags even in the quieter stretches.',
  'By the time the lights come up, the show has more than justified the modest scale of its ambitions.',
  'Recommended without hesitation for anyone curious what a modest budget and a clear point of view can still accomplish on a small stage.',
].join(' ');

function nytArticleBodyHtml(bodyText) {
  return `<html><head>
    <link rel="canonical" href="https://www.nytimes.com/2026/07/14/theater/example-review.html">
  </head><body>
    <section name="articleBody"><p>${bodyText}</p></section>
  </body></html>`;
}

function nytItempropHtml(bodyText) {
  // itemprop="articleBody" pattern requires THREE closing </div> after the
  // body div's own close (see PATTERNS in article-extractor.js).
  return `<html><body><div class="outer"><div class="wrapper"><div itemprop="articleBody">${bodyText}</div></div></div></body></html>`;
}

describe('NYT article-body extraction (task #6)', () => {
  test('long-form review (matches Whoopi Monologues 5,865-char baseline) extracts without truncation', () => {
    const html = nytArticleBodyHtml(LONG_FORM_REVIEW);
    const extracted = extractArticleText(html, 'www.nytimes.com');
    assert.ok(extracted, 'expected non-null extraction');
    // Old truncation failure mode capped extraction at ~800 chars (lede teaser only).
    assert.ok(extracted.length > 4000, `expected full-length extraction, got ${extracted.length} chars`);
    assert.ok(extracted.includes('accumulated small choices'), 'expected closing sentence to survive extraction');
  });

  test('short-form (capsule) review also extracts fully, not just the lede', () => {
    const html = nytArticleBodyHtml(SHORT_FORM_REVIEW);
    const extracted = extractArticleText(html, 'nytimes.com');
    assert.ok(extracted, 'expected non-null extraction');
    assert.ok(extracted.includes('Recommended without hesitation'), 'expected final sentence to survive extraction');
  });

  test('itemprop="articleBody" fallback pattern also extracts fully', () => {
    const html = nytItempropHtml(LONG_FORM_REVIEW);
    const extracted = extractArticleText(html, 'www.nytimes.com');
    assert.ok(extracted, 'expected non-null extraction');
    assert.ok(extracted.length > 4000, `expected full-length extraction, got ${extracted.length} chars`);
  });
});

describe('NYT recovered text classifies as complete, not truncated (task #6)', () => {
  test('long-form recovered text (Whoopi Monologues baseline length) → contentTier complete', () => {
    const result = classifyContentTier({
      fullText: LONG_FORM_REVIEW,
      outletId: 'nytimes',
      fetchMethod: 'nyt-subscriber-browser-session',
      publishDate: '2026-07-14',
    });
    assert.equal(result.contentTier, 'complete');
    assert.deepEqual(result.truncationSignals, []);
  });

  test('short-form recovered capsule review → contentTier complete (not misclassified as truncated/excerpt)', () => {
    const result = classifyContentTier({
      fullText: SHORT_FORM_REVIEW,
      outletId: 'nytimes',
      fetchMethod: 'url-ingest',
      publishDate: '2026-07-14',
    });
    assert.equal(result.contentTier, 'complete');
  });

  test('sanity check: a genuinely truncated lede-only teaser still classifies as truncated', () => {
    // The pre-fix failure mode: cookie-less fetch returns only the ~150-char
    // teaser before the paywall cuts in, with no closing punctuation.
    const teaser = LONG_FORM_REVIEW.slice(0, 150);
    const result = classifyContentTier({
      fullText: teaser,
      outletId: 'nytimes',
      publishDate: '2026-07-14',
    });
    assert.notEqual(result.contentTier, 'complete');
  });
});

describe('NYT cookie-authenticated fetch (task #6)', () => {
  const FIXTURE_COOKIES = [
    { name: 'nyt-a', value: 'session-token-abc123', domain: '.nytimes.com', path: '/' },
    { name: 'nyt-jkidt', value: 'subscriber-flag-xyz', domain: '.nytimes.com', path: '/' },
  ];

  test('NYT_COOKIES env var loads and builds a valid Cookie header for a nytimes.com URL', () => {
    const encoded = Buffer.from(JSON.stringify(FIXTURE_COOKIES)).toString('base64');
    const prevEnv = process.env.NYT_COOKIES;
    process.env.NYT_COOKIES = encoded;
    clearCache();
    try {
      const header = buildCookieHeaderForUrl('https://www.nytimes.com/2026/07/14/theater/example-review.html');
      assert.ok(header, 'expected a non-null Cookie header');
      assert.ok(header.includes('nyt-a=session-token-abc123'), `expected fixture cookie in header, got: ${header}`);
      assert.ok(header.includes('nyt-jkidt=subscriber-flag-xyz'));
    } finally {
      if (prevEnv === undefined) delete process.env.NYT_COOKIES;
      else process.env.NYT_COOKIES = prevEnv;
      clearCache();
    }
  });

  test('a domain with no cookie config → buildCookieHeaderForUrl returns null (baseline sanity)', () => {
    // Deliberately NOT nytimes.com: this machine may have a real local
    // data/cookies/nytimes.json (that's the whole point of task #6), so
    // asserting "no cookies" there would be environment-dependent. An
    // unmapped domain has no cookie source under any tier, in any environment.
    clearCache();
    const header = buildCookieHeaderForUrl('https://www.some-outlet-not-in-cookie-domain-map.example/article');
    assert.equal(header, null);
  });
});
