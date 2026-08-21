/**
 * BRO-719 — BWW roundup extraction misses reviews without hyperlinks.
 *
 * Becky Shaw opening (2026-04-06): Guardian and NYTG entries in the BWW
 * roundup had no <a href> anchor — just critic name, outlet, and excerpt
 * text. extractBWWRoundupReviews() must still create a review entry
 * (url: null) for those, not silently drop them. Both non-linked formats
 * exist in the wild:
 *   1. Method 1 (JSON-LD): a LiveBlogPosting update whose headline is
 *      "Outlet - Review Title" with no author name and no matching anchor.
 *   2. Method 2 (articleBody text): "Critic, Outlet: excerpt" prose with
 *      no anchor tag for that outlet anywhere in the page.
 * The root-cause fix (Method 1 no longer `return`s before Method 2 runs)
 * landed in e1060d7add / 9f0f19923a7 — see bww-roundup-method2-fallthrough
 * .test.mjs for the fall-through invariant itself. This file locks the
 * user-visible behavior: no-hyperlink entries show up with the right
 * outlet/critic/excerpt and url: null, alongside linked entries, and
 * malformed HTML/JSON-LD doesn't crash extraction or corrupt other rows.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { join } from 'path';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { extractBWWRoundupReviews } = require(join(ROOT, 'scripts/gather-reviews.js'));

const SHOW_ID = 'becky-shaw-2026';
const SHOW_TITLE = 'Becky Shaw';
const ROUNDUP_URL =
  'https://www.broadwayworld.com/article/Review-Roundup-BECKY-SHAW-Opens-on-Broadway-20260406';

test('linked entry keeps its URL, non-linked headline-only entry (Method 1) gets url: null', () => {
  const html = `<html><body>
<script type="application/ld+json">
{
  "@type": "LiveBlogPosting",
  "liveBlogUpdate": [
    {
      "@type": "BlogPosting",
      "author": { "name": "New York Times - Jesse Green" },
      "headline": "New York Times - Becky Shaw Review",
      "articleBody": "A prickly, fearless production."
    },
    {
      "@type": "BlogPosting",
      "headline": "The Guardian - Becky Shaw Review",
      "articleBody": "A muddled, tonally uneven revival."
    }
  ]
}
</script>
<p>Jesse Green, <a href="https://nytimes.com/becky-shaw-review">New York Times:</a> A prickly, fearless production.</p>
<p>No link for the Guardian's review here.</p>
</body></html>`;

  const reviews = extractBWWRoundupReviews(html, SHOW_ID, ROUNDUP_URL, SHOW_TITLE);

  const nyt = reviews.find(r => r.outletId === 'nytimes' || r.outlet === 'New York Times');
  assert.ok(nyt, `Linked NYT entry missing. Got: ${JSON.stringify(reviews)}`);
  assert.strictEqual(nyt.url, 'https://nytimes.com/becky-shaw-review');

  const guardian = reviews.find(r => r.outletId === 'guardian');
  assert.ok(guardian, `Non-linked Guardian entry missing (Method 1 headline-only). Got outlets: ${reviews.map(r => r.outletId)}`);
  assert.strictEqual(guardian.url, null, 'Non-linked entry must not be dropped or given a fabricated URL');
  assert.ok(guardian.bwwExcerpt && guardian.bwwExcerpt.length > 0, 'Non-linked entry must still carry the excerpt text');
});

test('non-linked articleBody entries (Method 2, Guardian + NYTG) are both extracted with url: null', () => {
  // No anchor tags for Guardian or NYTG anywhere on the page — this is the
  // exact Becky Shaw shape: BWW's JSON-LD only has the show's headline
  // BlogPosting, and the individual critic/outlet pairs live in prose inside
  // articleBody, with no corresponding <a href> for either outlet.
  const html = `<html><body>
<script type="application/ld+json">
{
  "@type": "BlogPosting",
  "headline": "Review Roundup: BECKY SHAW Opens on Broadway",
  "datePublished": "2026-04-06",
  "articleBody": "Let's see what the critics had to say... Jesse Green, New York Times: A prickly, fearless production that never quite finds its footing. Arifa Akbar, The Guardian: A muddled, tonally uneven revival that squanders a sharp premise. Gillian Russo, New York Theatre Guide: Mixed feelings dominate this uneven but ambitious staging."
}
</script>
<p>No hyperlinks anywhere on this page for any outlet.</p>
</body></html>`;

  const reviews = extractBWWRoundupReviews(html, SHOW_ID, ROUNDUP_URL, SHOW_TITLE);

  const guardian = reviews.find(r => r.outletId === 'guardian');
  const nytg = reviews.find(r => r.outletId === 'nytg');

  assert.ok(guardian, `Guardian review missing. Got outlets: ${reviews.map(r => r.outletId)}`);
  assert.strictEqual(guardian.criticName, 'Arifa Akbar');
  assert.strictEqual(guardian.url, null);
  assert.match(guardian.bwwExcerpt, /muddled, tonally uneven revival/);

  assert.ok(nytg, `NYTG review missing. Got outlets: ${reviews.map(r => r.outletId)}`);
  assert.strictEqual(nytg.criticName, 'Gillian Russo');
  assert.strictEqual(nytg.url, null);
  assert.match(nytg.bwwExcerpt, /Mixed feelings dominate/);
});

test('malformed/unterminated anchor tag does not crash extraction or leak a bogus URL', () => {
  const html = `<html><body>
<script type="application/ld+json">
{
  "@type": "BlogPosting",
  "headline": "Review Roundup: BECKY SHAW Opens on Broadway",
  "datePublished": "2026-04-06",
  "articleBody": "Let's see what the critics had to say... Jesse Green, New York Times: A prickly, fearless production. Arifa Akbar, The Guardian: A muddled, tonally uneven revival."
}
</script>
<p>Jesse Green, <a href="https://nytimes.com/becky-shaw-review broken markup with no closing quote></p>
<p>Arifa Akbar, The Guardian's review has no link.</p>
</body></html>`;

  assert.doesNotThrow(() => {
    const reviews = extractBWWRoundupReviews(html, SHOW_ID, ROUNDUP_URL, SHOW_TITLE);
    const guardian = reviews.find(r => r.outletId === 'guardian');
    assert.ok(guardian, 'Guardian entry must still be extracted despite malformed anchor markup elsewhere in the page');
    assert.strictEqual(guardian.url, null, 'Malformed anchor for a different outlet must not bleed a URL onto Guardian');
  });
});

test('malformed JSON-LD (unescaped inner quotes) combined with a non-linked entry still extracts both', () => {
  // Headline contains an unescaped inner quote (the sanitizeBwwJsonLd case)
  // AND the second liveBlogUpdate entry has no anchor tag anywhere on the page.
  const html = `<html><body>
<script type="application/ld+json">
{
  "@type": "LiveBlogPosting",
  "liveBlogUpdate": [
    {
      "@type": "BlogPosting",
      "author": { "name": "Vulture - Sara Holdren" },
      "headline": "Vulture Review - "Becky Shaw" is a Sharp Two-Hander",
      "articleBody": "A sharp, well-acted two-hander."
    },
    {
      "@type": "BlogPosting",
      "headline": "New York Theatre Guide - Becky Shaw Review",
      "articleBody": "Mixed feelings dominate this uneven staging."
    }
  ]
}
</script>
</body></html>`;

  const reviews = extractBWWRoundupReviews(html, SHOW_ID, ROUNDUP_URL, SHOW_TITLE);

  const vulture = reviews.find(r => r.outletId === 'vulture');
  assert.ok(vulture, `Vulture entry missing despite sanitizer handling the inner quote. Got: ${reviews.map(r => r.outletId)}`);

  const nytg = reviews.find(r => r.outletId === 'nytg');
  assert.ok(nytg, `Non-linked NYTG entry missing after JSON-LD sanitization. Got: ${reviews.map(r => r.outletId)}`);
  assert.strictEqual(nytg.url, null);
});

test('empty href attribute is ignored, not treated as a valid URL', () => {
  const html = `<html><body>
<script type="application/ld+json">
{
  "@type": "BlogPosting",
  "headline": "Review Roundup: BECKY SHAW Opens on Broadway",
  "datePublished": "2026-04-06",
  "articleBody": "Let's see what the critics had to say... Arifa Akbar, The Guardian: A muddled, tonally uneven revival."
}
</script>
<p>Arifa Akbar, <a href="">The Guardian:</a> A muddled, tonally uneven revival.</p>
</body></html>`;

  const reviews = extractBWWRoundupReviews(html, SHOW_ID, ROUNDUP_URL, SHOW_TITLE);
  const guardian = reviews.find(r => r.outletId === 'guardian');
  assert.ok(guardian, `Guardian entry missing. Got: ${reviews.map(r => r.outletId)}`);
  assert.strictEqual(guardian.url, null, 'An empty href must not be captured as a URL (anchor regex requires https?://)');
});
