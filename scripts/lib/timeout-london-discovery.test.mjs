import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyTimeOutLondonUrl, isTimeOutLondonListing } = require('./timeout-london-url.js');
const { urlLooksLikeReview } = require('./review-guards.js');
const { isBlockedReviewUrl } = require('./domain-filters.js');
const { classifyReviewUrl } = require('./non-review-url-patterns.js');
const { SITE_SEARCH_ENDPOINTS } = require('./site-search-discovery.js');

const REVIEW = 'https://www.timeout.com/london/news/the-standard-of-living-review-rory-kinnear-stars-in-latest-play-from-superstar-playwright-james-graham-092926';
const LISTING = 'https://www.timeout.com/london/theatre/the-standard-of-living';

test('Standard of Living /london/news/ review is a review', () => {
  assert.equal(classifyTimeOutLondonUrl(REVIEW), 'review');
  assert.equal(isTimeOutLondonListing(REVIEW), false);
  assert.equal(urlLooksLikeReview(REVIEW, 'The Standard of Living'), true);
  assert.equal(isBlockedReviewUrl(REVIEW), false);
  assert.equal(classifyReviewUrl(REVIEW).ok, true);
});

test('the evergreen listing page is rejected', () => {
  assert.equal(classifyTimeOutLondonUrl(LISTING), 'listing');
  assert.equal(isTimeOutLondonListing(LISTING), true);
});

test('other /news/ review slug shapes and evergreen reviews', () => {
  assert.equal(classifyTimeOutLondonUrl('https://www.timeout.com/london/news/review-beetlejuice-the-musical-at-the-london-palladium-052826'), 'review');
  assert.equal(classifyTimeOutLondonUrl('https://www.timeout.com/london/music/abba-voyage-review'), 'review');
  assert.equal(classifyTimeOutLondonUrl('https://www.timeout.com/london/news/persona-starring-cate-blanchett-at-the-national-theatre-090226'), 'news-other');
});

test('"review" must be a whole word in the slug', () => {
  assert.equal(classifyTimeOutLondonUrl('https://www.timeout.com/london/theatre/preview-night'), 'listing');
  assert.equal(classifyTimeOutLondonUrl('https://www.timeout.com/london/theatre/reviewing-hamlet'), 'listing');
});

test('non-London Time Out and other hosts are not classified', () => {
  assert.equal(classifyTimeOutLondonUrl('https://www.timeout.com/newyork/theater/hamlet-review'), null);
  assert.equal(classifyTimeOutLondonUrl('https://example.com/london/news/x-review'), null);
  assert.equal(classifyTimeOutLondonUrl('nonsense'), null);
  assert.equal(classifyTimeOutLondonUrl('https://www.timeout.com/london/theatre'), 'other');
});

test('site-search timeout linkPattern captures the /london/news/ review (absolute and relative hrefs), not the listing', () => {
  const cfg = SITE_SEARCH_ENDPOINTS.timeout;
  const html = `<a href="${REVIEW}">r</a><a href="/london/news/x-review-y-010126">rel</a><a href="${LISTING}">l</a>`;
  cfg.linkPattern.lastIndex = 0;
  const got = [];
  let m;
  while ((m = cfg.linkPattern.exec(html)) !== null) got.push(cfg.normalizeUrl ? cfg.normalizeUrl(m[1]) : m[1]);
  assert.deepEqual(got, [REVIEW, 'https://www.timeout.com/london/news/x-review-y-010126']);
});

test('url-discovery wires the listing guard into its candidate loop', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./url-discovery.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/timeout-london-url'\)/);
  assert.match(src, /if \(isTimeOutLondonListing\(url\)\)/);
});
