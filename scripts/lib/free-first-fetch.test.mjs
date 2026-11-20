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
    [{ url: 'https://deadline.com/2025/10/ragtime-broadway-review-1/', id: null, title: '&#8216;Ragtime&#8217; Review' }]);
  assert.equal(f.parseWpSearchResults('[{"id":42,"url":"https://x.com/a","title":"t"}]')[0].id, 42);
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

test('decideFreeSearch: a named non-review (real namedNonReviewReason) cannot suppress the paid render', () => {
  const u = 'https://ticketsmarter.com/hamilton-review-tickets';
  assert.ok(namedNonReviewReason(u), 'fixture must be a named non-review');
  const d = f.decideFreeSearch([{ url: u, id: 1 }], { ...opts('deadline', 'Hamilton'), linkPattern: /(https:\/\/ticketsmarter\.com\/[^"]+)/ });
  assert.equal(d.use, false);
  assert.equal(d.reason, 'no-matching-review');
});

test('theatreReviewsDirectAcceptable needs 200, closed document and the star marker', () => {
  const page = '<html><body>⭑⭑⭑ Cleansed</body></html>';
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/cleansed-reviews/', 200, page), true);
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/cleansed-reviews/', 404, page), false);
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/cleansed-reviews/', 200, '<html>cleantalk apbct interstitial</html>'), false);
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/cleansed-reviews/', 200, page.replace('</html>', '')), false);
  assert.equal(f.theatreReviewsDirectAcceptable('/wp-json/wp/v2/posts', 200, page), false);
  // BRO-7532: the site also uses "★" tier headers (Avenue Q, live 2026-11-17).
  const blackStar = '<html><body><p><span style="color: #ff0000;">5 stars ★★★★★</span></p> Avenue Q</body></html>';
  assert.equal(f.theatreReviewsDirectAcceptable('/reviews-roundup/avenue-q-reviews/', 200, blackStar), true);
  assert.equal(f.hasTheatreReviewsStarMarker(blackStar), true);
  assert.equal(f.hasTheatreReviewsStarMarker('<html>no ratings</html>'), false);
});

test('tr-roundup-discover uses the shared star-marker gate (no ⭑-only literal)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./tr-roundup-discover.js', import.meta.url), 'utf8');
  assert.ok(src.includes('hasTheatreReviewsStarMarker(result.content)'));
  assert.ok(!/includes\('⭑'\)/.test(src), 'a ⭑-only check rejects ★-format round-ups');
  assert.equal(f.isTheatreReviewsHost('theatre.reviews'), true);
  assert.equal(f.isTheatreReviewsHost('theatre.reviews.evil.com'), false);
});

test('decideFreeSearch: show news without "review" in the slug is not a hit (Beaches closing-date post, live 2026-11-15)', () => {
  const news = { url: 'https://deadline.com/2026/05/beaches-broadway-closing-date-1236916461/' };
  assert.equal(f.decideFreeSearch([news], opts('deadline', 'Beaches, A New Musical')).use, false);
});

test('looksLikeStageReview: film, TV, festival and other-market reviews are rejected (BRO-7532 ship-check P0)', () => {
  const ok = u => f.looksLikeStageReview(u, 'broadway');
  assert.equal(ok('https://deadline.com/2025/10/ragtime-broadway-review-1236583715/'), true);
  assert.equal(ok('https://www.hollywoodreporter.com/lifestyle/arts/chess-broadway-review-123/'), true);
  assert.equal(ok('https://deadline.com/2024/11/wicked-review-ariana-grande-1236/'), false, 'no stage marker');
  assert.equal(ok('https://deadline.com/2025/04/chess-west-end-review-1/'), false, 'other market');
  assert.equal(ok('https://www.hollywoodreporter.com/tv/tv-reviews/gypsy-review-netflix-1/'), false, 'tv');
  assert.equal(ok('https://deadline.com/2025/06/hamlet-review-tribeca-theater-1/'), false, 'festival');
  assert.equal(f.looksLikeStageReview('https://deadline.com/2025/04/chess-west-end-review-1/', 'west-end'), true);
});

test('decideFreeSearch rejects film/TV/other-market candidates even when they look like reviews', () => {
  const posts = ['https://deadline.com/2024/11/wicked-review-ariana-grande-1/', 'https://deadline.com/2025/04/chess-west-end-review-1/']
    .map((url, i) => ({ url, id: i + 1, title: 't' }));
  const d = f.decideFreeSearch(posts, { linkPattern: /(https:\/\/deadline\.com\/[^"]+)/, showTitle: 'Wicked', urlLooksLike: () => true, nonReviewReason: () => null });
  assert.equal(d.use, false);
});

test('isCurrentProductionPost: needs a post date inside the opening window', () => {
  assert.equal(f.isCurrentProductionPost('2025-10-16T20:00:00', '2025-10-16'), true);
  assert.equal(f.isCurrentProductionPost('2025-09-20T00:00:00', '2025-10-16'), true, 'previews inside grace');
  assert.equal(f.isCurrentProductionPost('2009-11-01T00:00:00', '2025-10-16'), false, 'old production');
  assert.equal(f.isCurrentProductionPost('2025-10-16T20:00:00', null), false, 'unknown opening date');
  assert.equal(f.isCurrentProductionPost(undefined, '2025-10-16'), false);
});

test('buildWpPostDateUrl', () => {
  assert.equal(f.buildWpPostDateUrl('https://deadline.com/', 5), 'https://deadline.com/wp-json/wp/v2/posts/5?_fields=id,date');
});

test('decideFreeSearch needs "review" as a whole slug word ("preview" is not a review)', () => {
  const mk = u => f.decideFreeSearch([{ url: u, id: 1 }], { linkPattern: /(https:\/\/deadline\.com\/[^"]+)/, showTitle: 'Ragtime', urlLooksLike: () => true, nonReviewReason: () => null });
  assert.equal(mk('https://deadline.com/2025/10/ragtime-broadway-preview-1/').use, false);
  assert.equal(mk('https://deadline.com/2025/10/ragtime-broadway-review-1/').use, true);
});

test('isCurrentProductionPost has an upper bound; stage markers are whole slug words', () => {
  assert.equal(f.isCurrentProductionPost('2026-04-01T10:00:00', '2018-03-01'), false, 'later revival must not count');
  assert.equal(f.isCurrentProductionPost('2018-04-01T10:00:00', '2018-03-01'), true);
  assert.equal(f.looksLikeStageReview('https://deadline.com/2025/10/hamlet-review-riz-ahmed-screenplay-1236/'), false);
  assert.equal(f.looksLikeStageReview('https://deadline.com/2025/10/hamlet-broadway-review-1236/'), true);
});

test('BRO-7531: clean no-match helpers', () => {
  const ff = require('./free-first-fetch.js');
  // bounded URL: opening -45d .. +120d, 100 per page; unknown date => null (paid render decides)
  assert.match(ff.buildWpBoundedSearchUrl('https://deadline.com/', 'Petra', '2026-11-10'),
    /^https:\/\/deadline\.com\/wp-json\/wp\/v2\/posts\?search=Petra%20review&after=2026-09-26T00:00:00&before=2027-03-10T00:00:00&per_page=100&_fields=id,link,date$/);
  assert.equal(ff.buildWpBoundedSearchUrl('https://deadline.com', 'Petra', null), null);
  assert.equal(ff.buildWpBoundedSearchUrl('https://deadline.com', 'Petra', 'TBA'), null);
  // posts parser: JSON arrays only
  assert.deepEqual(ff.parseWpPostsResults('[{"id":5,"link":"https://deadline.com/a/"},{"id":"x","link":"nope"}]'), [{ url: 'https://deadline.com/a/', id: 5 }]);
  for (const bad of ['<html>', '{"code":"rest_forbidden"}', '', undefined, '[oops']) assert.equal(ff.parseWpPostsResults(bad), null);
  // clean = array, page not full, nothing the paid filter accepts
  const opts = { linkPattern: /href="(https:\/\/deadline\.com\/\d{4}\/\d{2}\/[^"]+)"/g, showTitle: 'Petra', urlLooksLike: (u) => /petra/.test(u), nonReviewReason: (u) => (/box-office/.test(u) ? 'box-office' : null) };
  const post = (slug) => ({ url: `https://deadline.com/2026/11/${slug}/` });
  assert.equal(ff.isCleanFreeNoMatch([], opts), true);
  assert.equal(ff.isCleanFreeNoMatch([post('other-film-review-1'), post('petra-box-office-2')], opts), true, 'a named non-review is dropped by the paid path too');
  assert.equal(ff.isCleanFreeNoMatch([post('petra-review-1')], opts), false);
  assert.equal(ff.isCleanFreeNoMatch(null, opts), false, 'unusable answer is never clean');
  assert.equal(ff.isCleanFreeNoMatch(Array.from({ length: 20 }, (_, i) => post(`x-${i}`)), opts), false, 'a full page may be cut off');
  assert.equal(ff.isCleanFreeNoMatch(Array.from({ length: 20 }, (_, i) => post(`x-${i}`)), { ...opts, pageSize: 100 }), true);
  assert.equal(ff.isCleanFreeNoMatch([post('x-1')], { ...opts, rawCount: 20 }), false, 'full is judged on the raw row count, not the parsed one');
  assert.equal(ff.wpRawCount('[{"id":1},{"id":2}]'), 2);
  for (const bad of ['<html>', '{"a":1}', '[oops', '', undefined]) assert.equal(ff.wpRawCount(bad), null);
  // canary: one cheap known-good query per endpoint
  assert.equal(ff.buildWpCanaryUrl('https://deadline.com/'), 'https://deadline.com/wp-json/wp/v2/search?search=Broadway%20review&per_page=1&subtype=post');
  assert.equal(ff.buildWpCanaryUrl('https://deadline.com', 'posts'), 'https://deadline.com/wp-json/wp/v2/posts?search=Broadway%20review&per_page=1&_fields=id,link,date');
  // audit miss log ignores posts dated before the production window
  assert.equal(ff.urlDatedBeforeProduction('https://deadline.com/2020/09/film-review-x-1/', '2026-11-09'), true);
  assert.equal(ff.urlDatedBeforeProduction('https://deadline.com/2026/09/x-review-1/', '2026-11-09'), false, 'September ends inside the 45-day grace');
  assert.equal(ff.urlDatedBeforeProduction('https://deadline.com/2026/11/x-review-1/', '2026-11-09'), false);
  assert.equal(ff.urlDatedBeforeProduction('https://www.hollywoodreporter.com/lifestyle/arts/x-review-1/', '2026-11-09'), false, 'undated URL counts');
  assert.equal(ff.urlDatedBeforeProduction('https://deadline.com/2020/09/x-1/', null), false, 'unknown opening date counts');
  // audit sample: 5% by default, env override, 0 turns it off
  assert.equal(ff.shouldAuditCleanNoMatch(() => 0.04, {}), true);
  assert.equal(ff.shouldAuditCleanNoMatch(() => 0.05, {}), false);
  assert.equal(ff.shouldAuditCleanNoMatch(() => 0.5, { FREE_WP_CLEAN_AUDIT_RATE: '1' }), true);
  assert.equal(ff.shouldAuditCleanNoMatch(() => 0, { FREE_WP_CLEAN_AUDIT_RATE: '0' }), false);
  assert.equal(ff.shouldAuditCleanNoMatch(() => 0.04, { FREE_WP_CLEAN_AUDIT_RATE: 'junk' }), true, 'unparseable rate falls back to the default');
  // policy: off-Broadway / off-West-End only, with a kill switch
  assert.equal(ff.trustCleanFreeNoMatch({ category: 'off-broadway' }, {}), true);
  assert.equal(ff.trustCleanFreeNoMatch({ category: 'off-west-end' }, {}), true);
  for (const show of [{ category: 'broadway' }, { category: 'west-end' }, { category: 'regional' }, { category: 'tour' }, {}, null]) assert.equal(ff.trustCleanFreeNoMatch(show, {}), false);
  assert.equal(ff.trustCleanFreeNoMatch({ category: 'off-broadway' }, { FREE_WP_NO_MATCH_PAID: '1' }), false);
});

test('BRO-7532 recheck: freeSearchAnchorDate prefers the opening date, then previews, else null', () => {
  assert.equal(f.freeSearchAnchorDate('2026-11-12', { previewsStartDate: '2026-10-01' }), '2026-11-12');
  assert.equal(f.freeSearchAnchorDate(null, { previewsStartDate: '2026-11-14' }), '2026-11-14');
  assert.equal(f.freeSearchAnchorDate(undefined, { previewsStartDate: '2026-11-14' }), '2026-11-14');
  assert.equal(f.freeSearchAnchorDate('TBA', { previewsStartDate: '2026-11-14' }), '2026-11-14');
  assert.equal(f.freeSearchAnchorDate(null, { previewsStartDate: 'TBA' }), null);
  assert.equal(f.freeSearchAnchorDate(null, {}), null);
  assert.equal(f.freeSearchAnchorDate(null, null), null);
  const nov20 = Date.parse('2026-11-20');
  assert.equal(f.freeSearchAnchorDate(null, { previewsStartDate: '2026-11-14' }, nov20), '2026-11-14');
  assert.equal(f.freeSearchAnchorDate(null, { previewsStartDate: '2026-07-01' }, nov20), null, 'previews began >120 days ago: a review could fall outside the window');
  assert.equal(f.freeSearchAnchorDate('2025-01-01', { previewsStartDate: '2024-01-01' }, nov20), '2025-01-01', 'a known opening date is always used');
});

test('BRO-7532 recheck: dtliDirectOutcome trusts only a real page or DTLI\'s own 404 document', () => {
  const page = '<html><head><title>Ragtime - Did They Like It?</title></head><body><div class="review-item">x</div></body></html>';
  const notFound = '<html><head><title>Page not found - Did They Like It?</title></head><body>Sorry</body></html>';
  assert.equal(f.dtliDirectOutcome(200, page), 'page');
  assert.equal(f.dtliDirectOutcome(404, notFound), 'not-found');
  // Everything else falls back to the paid chain.
  assert.equal(f.dtliDirectOutcome(404, 'Not found'), 'fallback', 'bare 404 without the site document');
  assert.equal(f.dtliDirectOutcome(404, notFound.replace('</html>', '')), 'fallback', 'truncated 404');
  assert.equal(f.dtliDirectOutcome(404, '<html><title>Page not found</title></html>'), 'fallback', 'some other site\'s 404');
  assert.equal(f.dtliDirectOutcome(404, page), 'fallback', '404 status carrying review blocks is contradictory');
  assert.equal(f.dtliDirectOutcome(200, notFound), 'fallback', '200 without review blocks');
  assert.equal(f.dtliDirectOutcome(403, notFound), 'fallback', '403 is a block, not a miss');
  assert.equal(f.dtliDirectOutcome(503, page), 'fallback');
  assert.equal(f.dtliDirectOutcome(404, undefined), 'fallback');
});
