/**
 * Basquiat 2026-09-16: TheaterMania's "In Honor of Jean-Michel Basquiat" review
 * landed as criticName "Unknown" (displayed as "TheaterMania Staff") because
 * ingest-review-from-url.js's byline regex only matched an author-name element
 * with the name as direct text — TheaterMania nests the name inside a child
 * <a id="article-author-tag">. Verified against the live page (Kenji Fujishima)
 * with a plain curl (bot-challenge only hit automated scraper IPs).
 *
 * Follow-up (same day, adversarial review of the fix): an unscoped version of
 * the new nested-<a> candidate matched the first nested anchor inside ANY
 * author-name-classed ancestor, anywhere in the page — a "Share"/related-
 * article link sitting inside such a wrapper could win over a real .byline or
 * rel="author" match found earlier in the HTML, because the candidate ran
 * before those checks. Fixed by (a) moving the candidate to run last and
 * (b) requiring the nested <a> itself to carry rel="author" or an id/class
 * containing "author" before it's trusted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractByline } from './byline-extraction.js';

test('extracts a byline nested inside an <a id="article-author-tag"> (TheaterMania live-page shape)', () => {
  const html = `<p class="author-name mb-0 me-2 text-decoration-none text-blue"><a id="article-author-tag" class="text-decoration-none text-blue" href="https://www.theatermania.com/authors/kenji-fujishima">Kenji Fujishima</a></p>`;
  assert.equal(extractByline(html), 'Kenji Fujishima');
});

test('extracts a byline nested in an <a rel="author"> inside class="author-name"', () => {
  const html = `<div class="author-name"><a rel="author" href="/authors/jane">Jane Critic</a></div>`;
  assert.equal(extractByline(html), 'Jane Critic');
});

test('still extracts a byline that is direct text inside class="author-name" (pre-existing shape)', () => {
  const html = `<span class="author-name">Jane Critic</span>`;
  assert.equal(extractByline(html), 'Jane Critic');
});

test('meta[name=author] still wins when present (checked before author-name)', () => {
  const html = `<meta name="author" content="Meta Name"><span class="author-name"><a rel="author">Nested Name</a></span>`;
  assert.equal(extractByline(html), 'Meta Name');
});

test('a real .byline wins over an unrelated nested anchor inside an author-name wrapper', () => {
  // Regression for the adversarial-review finding: a "Share" link (no author
  // hint) sitting inside class="author-name" must not outrank a real byline
  // that appears earlier in the page order but later in candidate priority.
  const html = `<span class="byline">By Real Critic</span><div class="author-name"><a href="/share">Share</a></div>`;
  assert.equal(extractByline(html), 'Real Critic');
});

test('a nested anchor with no author hint (no rel=author, no author id/class) is not trusted', () => {
  const html = `<div class="author-name"><a href="/tag/related">Related Article</a></div>`;
  assert.equal(extractByline(html), null);
});

test('returns null with no matching markup', () => {
  assert.equal(extractByline('<p>no byline here</p>'), null);
});

test('returns null for empty/falsy input', () => {
  assert.equal(extractByline(''), null);
  assert.equal(extractByline(null), null);
});
