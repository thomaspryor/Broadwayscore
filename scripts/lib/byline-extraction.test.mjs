/**
 * Basquiat 2026-09-16: TheaterMania's "In Honor of Jean-Michel Basquiat" review
 * landed as criticName "Unknown" (displayed as "TheaterMania Staff") because
 * ingest-review-from-url.js's byline regex only matched an author-name element
 * with the name as direct text — TheaterMania nests the name inside a child
 * <a id="article-author-tag">. Verified against the live page (Kenji Fujishima)
 * with a plain curl (bot-challenge only hit automated scraper IPs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractByline } from './byline-extraction.js';

test('extracts a byline nested inside an <a> inside class="author-name" (TheaterMania shape)', () => {
  const html = `<p class="author-name mb-0 me-2 text-decoration-none text-blue"><a id="article-author-tag" class="text-decoration-none text-blue" href="https://www.theatermania.com/authors/kenji-fujishima">Kenji Fujishima</a></p>`;
  assert.equal(extractByline(html), 'Kenji Fujishima');
});

test('still extracts a byline that is direct text inside class="author-name" (pre-existing shape)', () => {
  const html = `<span class="author-name">Jane Critic</span>`;
  assert.equal(extractByline(html), 'Jane Critic');
});

test('meta[name=author] still wins when present (checked before author-name)', () => {
  const html = `<meta name="author" content="Meta Name"><span class="author-name"><a>Nested Name</a></span>`;
  assert.equal(extractByline(html), 'Meta Name');
});

test('returns null with no matching markup', () => {
  assert.equal(extractByline('<p>no byline here</p>'), null);
});

test('returns null for empty/falsy input', () => {
  assert.equal(extractByline(''), null);
  assert.equal(extractByline(null), null);
});
