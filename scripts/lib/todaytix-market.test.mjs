// BRO-4326 / BRO-4401: TodayTix page discovery in fetch-show-images-auto.js
// was NYC-only — it searched /nyc/shows?q=, queried Google with "broadway
// nyc" and rejected every /london/ hit — so West End / Off-West End shows
// could never find their own TodayTix page and fell through to IBDB / Google
// Images false positives, staying imageless. These pin the market routing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  todaytixMarket,
  todaytixSearchUrl,
  extractTodaytixShowLink,
  todaytixSerpQuery,
  todaytixShowUrl,
} = require('./todaytix-market.js');

describe('todaytixMarket', () => {
  test('west-end and off-west-end categories are london', () => {
    assert.equal(todaytixMarket({ category: 'west-end', market: 'west-end' }), 'london');
    assert.equal(todaytixMarket({ category: 'off-west-end', market: 'west-end' }), 'london');
    assert.equal(todaytixMarket({ category: 'Off-West End' }), 'london');
  });

  test('market field alone routes to london when category is missing', () => {
    assert.equal(todaytixMarket({ category: null, market: 'west-end' }), 'london');
  });

  test('broadway, off-broadway, tour, regional and unknown are nyc', () => {
    for (const category of ['broadway', 'off-broadway', 'tour', 'regional', null, undefined, '']) {
      assert.equal(todaytixMarket({ category }), 'nyc', `category=${category}`);
    }
    assert.equal(todaytixMarket(null), 'nyc');
  });
});

describe('search URL / SERP query / page URL follow the market', () => {
  test('london search URL, SERP query and page URL', () => {
    assert.equal(
      todaytixSearchUrl('london', 'Christmas Carol Goes Wrong'),
      'https://www.todaytix.com/london/search?q=Christmas%20Carol%20Goes%20Wrong',
    );
    assert.equal(todaytixSerpQuery('london', 'Player'), 'site:todaytix.com "Player" london');
    assert.equal(todaytixShowUrl('london', 20561, 'hamilton'), 'https://www.todaytix.com/london/shows/20561-hamilton');
  });

  test('nyc keeps the broadway/nyc SERP keyword and /nyc/ page URL', () => {
    assert.equal(todaytixSearchUrl('nyc', 'Hamilton'), 'https://www.todaytix.com/nyc/search?q=Hamilton');
    assert.equal(todaytixSerpQuery('nyc', 'Hamilton'), 'site:todaytix.com "Hamilton" broadway nyc');
    assert.equal(todaytixShowUrl('nyc', 27, 'hamilton'), 'https://www.todaytix.com/nyc/shows/27-hamilton');
  });
});

describe('extractTodaytixShowLink is market-exclusive', () => {
  test('a london show accepts /london/ links and rejects /nyc/ ones', () => {
    assert.deepEqual(
      extractTodaytixShowLink('https://www.todaytix.com/london/shows/20561-hamilton', 'london'),
      { id: 20561, slug: 'hamilton' },
    );
    assert.equal(extractTodaytixShowLink('https://www.todaytix.com/nyc/shows/27-hamilton', 'london'), null);
  });

  test('an nyc show accepts /nyc/ links and rejects /london/ ones (the old behaviour, kept)', () => {
    assert.deepEqual(
      extractTodaytixShowLink('<a href="/nyc/shows/27-hamilton">', 'nyc'),
      { id: 27, slug: 'hamilton' },
    );
    assert.equal(extractTodaytixShowLink('https://www.todaytix.com/london/shows/20561-hamilton', 'nyc'), null);
  });

  test('root-relative links inside HTML are found for either market', () => {
    const html = '<nav><a href="/london/shows/302-the-lion-king">Lion King</a><a href="/london/shows/313-wicked">Wicked</a></nav>';
    assert.deepEqual(extractTodaytixShowLink(html, 'london'), { id: 302, slug: 'the-lion-king' });
    assert.equal(extractTodaytixShowLink(html, 'nyc'), null);
  });

  test('no link → null, never a throw', () => {
    assert.equal(extractTodaytixShowLink('', 'london'), null);
    assert.equal(extractTodaytixShowLink(null, 'nyc'), null);
  });
});
