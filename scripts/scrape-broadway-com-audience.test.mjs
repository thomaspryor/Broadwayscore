import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBotChallenge,
  extractJsonLdRating,
  extractHtmlRating,
  shouldUseScraperFallback,
} from './lib/broadway-com-rating-parser.js';

const VALID_JSON_LD_PAGE = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Hamilton",
"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","ratingCount":"631"}}
</script>
</head><body>${'x'.repeat(10500)}</body></html>`;

const SMALL_CLIENT_CHALLENGE_PAGE = `<!DOCTYPE html><html><head><title>Client Challenge</title>
<link href="/_fs-ch-1T1wmsGaOgGaSxcX/assets/styles.css" rel="stylesheet" /></head>
<body>Please enable JavaScript to proceed.</body></html>`;

// BRO-547 regression fixture: a full-size 200 response that is NOT flagged by
// isBotChallenge() (no known challenge markers, well over the 10000-byte
// floor) but is still missing the JSON-LD aggregateRating block — the shape
// CI's bot-blocked responses actually took.
const FULL_PAGE_MISSING_JSON_LD = `<!DOCTYPE html><html><head><title>Hamilton | Broadway.com</title></head>
<body><nav>...normal site chrome...</nav>${'y'.repeat(11000)}<footer>© Broadway.com</footer></body></html>`;

test('extractJsonLdRating parses a valid aggregateRating block', () => {
  const rating = extractJsonLdRating(VALID_JSON_LD_PAGE);
  assert.deepEqual(rating, { ratingValue: 4.8, ratingCount: 631 });
});

test('extractJsonLdRating returns null when no JSON-LD is present', () => {
  assert.equal(extractJsonLdRating(FULL_PAGE_MISSING_JSON_LD), null);
});

test('extractHtmlRating finds a rating in the "Customer Reviews" fallback pattern', () => {
  const html = `<div>Customer Reviews (270)</div><span>4.6</span>`;
  const rating = extractHtmlRating(html);
  assert.deepEqual(rating, { ratingValue: 4.6, ratingCount: 270 });
});

test('extractHtmlRating returns null when no review-count text exists', () => {
  assert.equal(extractHtmlRating(FULL_PAGE_MISSING_JSON_LD), null);
});

test('isBotChallenge detects the small Fastly/Cloudflare challenge page', () => {
  assert.equal(isBotChallenge(SMALL_CLIENT_CHALLENGE_PAGE), true);
});

test('isBotChallenge does NOT flag a full-size page missing JSON-LD (BRO-547 shape)', () => {
  // This is the exact gap that let the bug through: the CI-blocked response
  // is large and has no challenge markers, so isBotChallenge() alone can't
  // catch it — shouldUseScraperFallback() has to catch it instead.
  assert.equal(isBotChallenge(FULL_PAGE_MISSING_JSON_LD), false);
});

test('isBotChallenge does not false-positive on a valid, rating-bearing page', () => {
  assert.equal(isBotChallenge(VALID_JSON_LD_PAGE), false);
});

test('shouldUseScraperFallback retries on a classic bot-challenge page (pre-existing behavior)', () => {
  const rating = extractJsonLdRating(SMALL_CLIENT_CHALLENGE_PAGE) || extractHtmlRating(SMALL_CLIENT_CHALLENGE_PAGE);
  assert.equal(shouldUseScraperFallback(SMALL_CLIENT_CHALLENGE_PAGE, rating), true);
});

test('shouldUseScraperFallback retries on a full-size CI-bot-blocked page even though isBotChallenge is false (BRO-547 fix)', () => {
  const rating = extractJsonLdRating(FULL_PAGE_MISSING_JSON_LD) || extractHtmlRating(FULL_PAGE_MISSING_JSON_LD);
  assert.equal(rating, null);
  assert.equal(isBotChallenge(FULL_PAGE_MISSING_JSON_LD), false);
  assert.equal(shouldUseScraperFallback(FULL_PAGE_MISSING_JSON_LD, rating), true);
});

test('shouldUseScraperFallback does not retry when a rating was already found', () => {
  const rating = extractJsonLdRating(VALID_JSON_LD_PAGE);
  assert.equal(shouldUseScraperFallback(VALID_JSON_LD_PAGE, rating), false);
});
