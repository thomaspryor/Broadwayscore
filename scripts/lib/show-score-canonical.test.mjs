import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { servesUkPageForUsShow, canonicalUrlsOf } = require('./show-score-canonical');

const LONDON_AS_NYC = '<html><head><link rel="canonical" href="https://www.show-score.com/uk/london/off-west-end-shows/midnight"></head></html>';
const NYC_PAGE = '<html><head><link rel="canonical" href="https://www.show-score.com/off-broadway-shows/midnight"></head></html>';

test('the real Midnight case: NYC url, London canonical (off-west-end-shows)', () => {
  assert.equal(servesUkPageForUsShow(LONDON_AS_NYC, 'https://www.show-score.com/off-broadway-shows/midnight'), true);
});
test('a genuine NYC page passes', () => {
  assert.equal(servesUkPageForUsShow(NYC_PAGE, 'https://www.show-score.com/off-broadway-shows/midnight'), false);
});
test('west-end shows may use UK pages', () => {
  assert.equal(servesUkPageForUsShow(LONDON_AS_NYC, 'https://www.show-score.com/uk/london/west-end-shows/x', { allowWestEnd: true }), false);
});
test('west-end-shows and london paths are caught with and without a leading slash', () => {
  for (const u of ['https://www.show-score.com/london-shows/x', 'https://www.show-score.com/uk/london/west-end-shows/x', 'https://www.show-score.com/x/off-west-end-shows/y']) {
    assert.equal(servesUkPageForUsShow('', u), true, u);
  }
});
test('open-graph og:url carries no market and is ignored', () => {
  const html = '<meta property="og:url" content="https://www.show-score.com/open-graph/show/11249">';
  assert.deepEqual(canonicalUrlsOf(html), ['https://www.show-score.com/open-graph/show/11249']);
  assert.equal(servesUkPageForUsShow(html, 'https://www.show-score.com/off-broadway-shows/x'), false);
});

test('pageRatingOf / storedRatingMatchesPage prove a stored rating came from the page', () => {
  const { pageRatingOf, storedRatingMatchesPage } = require('./show-score-canonical');
  const page = pageRatingOf('<div>Midnight Closed 92% 351 reviews Score it 92% (351 Ratings) Positive 93%</div>');
  assert.deepEqual(page, { score: 92, count: 351 });
  assert.equal(storedRatingMatchesPage({ score: 92, reviewCount: 353 }, page), true);
  assert.equal(storedRatingMatchesPage({ score: 90, reviewCount: 731 }, { score: 81, count: 6 }), false);
  assert.equal(storedRatingMatchesPage(null, page), false);
});

test('allowsUkShowScorePage: London shows and UK regional houses yes; US regional and NYC no', () => {
  const { allowsUkShowScorePage } = require('./show-score-canonical');
  assert.equal(allowsUkShowScorePage({ category: 'west-end', market: 'west-end' }), true);
  assert.equal(allowsUkShowScorePage({ category: 'off-west-end', market: 'west-end' }), true);
  assert.equal(allowsUkShowScorePage({ category: 'regional', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon' }), true);
  assert.equal(allowsUkShowScorePage({ category: 'regional', venue: 'Chichester Festival Theatre, Chichester' }), true);
  assert.equal(allowsUkShowScorePage({ category: 'regional', venue: 'Emerson Colonial Theatre, Boston, MA' }), false);
  assert.equal(allowsUkShowScorePage({ category: 'regional', venue: 'American Repertory Theater, Cambridge, MA' }), false);
  assert.equal(allowsUkShowScorePage({ category: 'off-broadway', market: 'broadway' }), false);
  assert.equal(allowsUkShowScorePage({ category: 'tour', market: 'tour' }), false);
});
