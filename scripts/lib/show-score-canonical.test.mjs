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

// ── BRO-5499 follow-up: every path that turns a Show Score page into audience data uses the guard ──
const { isUkPageForShow } = require('./show-score-canonical');
const OB_SHOW = { id: 'midnight-off-broadway-2026', category: 'off-broadway', market: 'broadway', venue: 'Daryl Roth Theatre' };
const WE_SHOW = { id: 'midnight-at-the-never-get-west-end-2026', category: 'west-end', market: 'west-end', venue: 'Apollo' };
const UK_REGIONAL = { id: 'x-regional-2026', category: 'regional', venue: 'Chichester Festival Theatre' };
const US_REGIONAL = { id: 'y-regional-2026', category: 'regional', venue: 'Emerson Colonial Theatre, Boston, MA' };
const CACHED_URL = 'https://www.show-score.com/off-broadway-shows/midnight';

test('isUkPageForShow: the cached-URL case that re-poisoned Midnight (US slug, London canonical)', () => {
  assert.equal(isUkPageForShow(OB_SHOW, LONDON_AS_NYC, CACHED_URL), true);
  assert.equal(isUkPageForShow(OB_SHOW, NYC_PAGE, CACHED_URL), false);
});
test('isUkPageForShow: UK shows and UK regional houses may use UK pages, US regional may not', () => {
  assert.equal(isUkPageForShow(WE_SHOW, LONDON_AS_NYC, 'https://www.show-score.com/uk/london/west-end-shows/x'), false);
  assert.equal(isUkPageForShow(UK_REGIONAL, LONDON_AS_NYC, CACHED_URL), false);
  assert.equal(isUkPageForShow(US_REGIONAL, LONDON_AS_NYC, CACHED_URL), true);
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
test('structural: every script that records a Show Score audience rating from page HTML calls the UK guard', () => {
  const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['scrape-show-score-audience.js', 'extract-show-score-reviews.js', 'extract-ob-showscore.js']) {
    const src = fs.readFileSync(path.join(scripts, f), 'utf8');
    assert.match(src, /if \(\s*isUkPageForShow\(|\bconst \w+ = isUkPageForShow\(/, `${f} must call isUkPageForShow (show-score-canonical) before recording audienceScore/sources.showScore`);
  }
  // processShow (cached URLs) is the path that failed, not just discovery
  const scraper = fs.readFileSync(path.join(scripts, 'scrape-show-score-audience.js'), 'utf8');
  const processShowBody = scraper.slice(scraper.indexOf('async function processShow('));
  assert.ok(processShowBody.slice(0, processShowBody.indexOf('extractAudienceData(')).includes('if (isUkPageForShow('),
    'processShow must reject a UK page before extractAudienceData()');
});
