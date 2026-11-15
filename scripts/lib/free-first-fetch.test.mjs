// BRO-7532: pure decisions for the free-first fetch paths. Tests require the real functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const f = require('./free-first-fetch.js');
const { SITE_SEARCH_ENDPOINTS } = require('./site-search-discovery.js');
const { urlLooksLikeReview } = require('./review-guards');
const { namedNonReviewReason } = require('./non-review-url-patterns');

const opts = (id, showTitle) => ({ linkPattern: SITE_SEARCH_ENDPOINTS[id].linkPattern, showTitle, urlLooksLike: urlLooksLikeReview, nonReviewReason: namedNonReviewReason });

test('buildWpSearchUrl encodes the title and trims the base', () => {
  assert.equal(f.buildWpSearchUrl('https://deadline.com/', "Oh, Mary!"),
    'https://deadline.com/wp-json/wp/v2/search?search=Oh%2C%20Mary!%20review&per_page=20&subtype=post');
});

test('parseWpSearchResults: arrays parse, HTML / errors / junk are null', () => {
  assert.deepEqual(f.parseWpSearchResults('[{"url":"https://deadline.com/2025/10/ragtime-broadway-review-1/","title":"&#8216;Ragtime&#8217; <b>Review</b>"}]'),
    [{ url: 'https://deadline.com/2025/10/ragtime-broadway-review-1/', title: '&#8216;Ragtime&#8217; Review' }]);
  assert.equal(f.parseWpSearchResults('<html>blocked</html>'), null);
  assert.equal(f.parseWpSearchResults('{"code":"rest_no_route"}'), null);
  assert.equal(f.parseWpSearchResults('[not json'), null);
  assert.equal(f.parseWpSearchResults(undefined), null);
});

test('decideFreeSearch: a real Deadline review is a hit', () => {
  const d = f.decideFreeSearch([{ url: 'https://deadline.com/2025/10/ragtime-broadway-review-1236583715/' }], opts('deadline', 'Ragtime'));
  assert.equal(d.use, true);
  assert.deepEqual(d.urls, ['https://deadline.com/2025/10/ragtime-broadway-review-1236583715/']);
});

test('decideFreeSearch: unusable, empty and non-matching all mean fall back to paid', () => {
  assert.equal(f.decideFreeSearch(null, opts('deadline', 'Ragtime')).use, false);
  assert.equal(f.decideFreeSearch([], opts('deadline', 'Ragtime')).reason, 'empty');
  assert.equal(f.decideFreeSearch([{ url: 'https://deadline.com/2025/10/unrelated-news-1/' }], opts('deadline', 'Ragtime')).use, false);
});

test('decideFreeSearch: THR /movies/ film review never counts (BRO-6585 guard, global-flag safe)', () => {
  const o = opts('hollywood-reporter', 'Hamilton');
  const film = { url: 'https://www.hollywoodreporter.com/movies/movie-reviews/uncropped-review-james-hamilton-1/' };
  assert.equal(f.decideFreeSearch([film, film], o).use, false);
  const real = { url: 'https://www.hollywoodreporter.com/lifestyle/arts/hamilton-theater-review-1/' };
  assert.equal(f.decideFreeSearch([film, real, real], o).use, true);
  assert.equal(f.decideFreeSearch([real], o).use, true, 'repeat calls keep matching (no lastIndex carry-over)');
});

test('decideFreeSearch: named non-review posts (box office) cannot suppress the paid render', () => {
  const u = 'https://deadline.com/2026/09/broadway-box-office-hamilton-review-1/';
  const d = f.decideFreeSearch([{ url: u }], opts('deadline', 'Hamilton'));
  assert.equal(d.use, namedNonReviewReason(u) ? false : d.use);
  if (namedNonReviewReason(u)) assert.equal(d.reason, 'no-matching-review');
});

test('theatreReviewsDirectAcceptable needs 200, closed document and the star marker', () => {
  const page = '<html><body>⭑⭑⭑ Cleansed</body></html>';
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/cleansed-reviews/', 200, page), true);
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/cleansed-reviews/', 404, page), false);
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/cleansed-reviews/', 200, '<html>cleantalk apbct interstitial</html>'), false);
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/cleansed-reviews/', 200, page.replace('</html>', '')), false);
  assert.equal(f.theatreReviewsDirectAcceptable('/wp-json/wp/v2/posts', 200, page), false);
  assert.equal(f.isTheatreReviewsHost('theatre.reviews'), true);
  assert.equal(f.isTheatreReviewsHost('theatre.reviews.evil.com'), false);
});

test('decideFreeSearch: show news without "review" in the slug is not a hit (Beaches closing-date post, live 2026-11-15)', () => {
  const news = { url: 'https://deadline.com/2026/05/beaches-broadway-closing-date-1236916461/' };
  assert.equal(f.decideFreeSearch([news], opts('deadline', 'Beaches, A New Musical')).use, false);
});
