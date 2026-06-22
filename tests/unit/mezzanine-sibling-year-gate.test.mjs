import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchProductions } = require('../../scripts/scrape-mezzanine-audience.js');

// Reproduces the 2026-05-24 contamination class: when a show has same-titled
// siblings in shows.json, the exact-title-match high-confidence path was
// bypassing year verification and silently attaching unrelated productions
// (RSC tours, off-Broadway runs) to the most-recent revival.
//
// Pre-fix: the-merchant-of-venice-2010 mezzanine.prodIds=[5 entries] from
// 2010 Pacino + 2008 RSC + 2015 RSC tours + 1989 Hoffman + 1973 Mostel.
// Post-fix: only the 2010 entry attaches; siblings 1989/1973 get theirs;
// RSC 2008/2015 with no matching shows.json sibling get DROPPED.

const ourShows = [
  { id: 'the-merchant-of-venice-2010', title: 'The Merchant of Venice', category: 'broadway', openingDate: '2010-11-13', status: 'closed' },
  { id: 'the-merchant-of-venice-1989', title: 'The Merchant of Venice', category: 'broadway', openingDate: '1989-12-19', status: 'closed' },
  { id: 'the-merchant-of-venice-1973', title: 'The Merchant of Venice', category: 'broadway', openingDate: '1973-03-01', status: 'closed' },
  { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06', status: 'open' },
];

function mezProd(showName, year, ratingsCount, avg = 3.5) {
  return {
    objectId: `pid-${showName.toLowerCase().replace(/\s/g, '-')}-${year}`,
    show: { name: showName },
    showName,
    opened: { __type: 'Date', iso: `${year}-01-01T00:00:00Z` },
    ratingsCount,
    averageRating: avg,
    theater: { name: 'Some Theater' },
  };
}

describe('Mezzanine sibling-aware year gate', () => {
  test('exact-title productions with no year match to any sibling are DROPPED', () => {
    const productions = [
      mezProd('The Merchant of Venice', 2010, 50),  // Pacino Broadway 2010 — matches 2010
      mezProd('The Merchant of Venice', 1989, 30),  // matches 1989 sibling
      mezProd('The Merchant of Venice', 1973, 10),  // matches 1973 sibling
      mezProd('The Merchant of Venice', 2008, 20),  // RSC London — no shows.json sibling
      mezProd('The Merchant of Venice', 2015, 15),  // RSC tour — no shows.json sibling
    ];
    const matches = matchProductions(productions, ourShows);
    const m2010 = matches.find(m => m.showId === 'the-merchant-of-venice-2010');
    assert.ok(m2010, 'expected match for the-merchant-of-venice-2010');
    assert.strictEqual(m2010.prodIds.length, 1, `expected 1 prodId for 2010, got ${m2010.prodIds.length}: ${m2010.prodIds.join(',')}`);
    assert.ok(m2010.prodIds[0].includes('2010'), `expected prodId for 2010 year, got: ${m2010.prodIds[0]}`);
  });

  test('all 3 sibling revivals each get their own production (no merging across siblings)', () => {
    const productions = [
      mezProd('The Merchant of Venice', 2010, 50),
      mezProd('The Merchant of Venice', 1989, 30),
      mezProd('The Merchant of Venice', 1973, 10),
    ];
    const matches = matchProductions(productions, ourShows);
    const byShow = new Map(matches.map(m => [m.showId, m]));
    assert.ok(byShow.get('the-merchant-of-venice-2010'));
    assert.ok(byShow.get('the-merchant-of-venice-1989'));
    assert.ok(byShow.get('the-merchant-of-venice-1973'));
    assert.strictEqual(byShow.get('the-merchant-of-venice-2010').prodIds.length, 1);
    assert.strictEqual(byShow.get('the-merchant-of-venice-1989').prodIds.length, 1);
    assert.strictEqual(byShow.get('the-merchant-of-venice-1973').prodIds.length, 1);
  });

  test('non-sibling shows still merge multiple productions across years (long-running shows)', () => {
    // Hamilton has no siblings; long-running show with multiple Mezzanine entries
    // for different years should still merge under the single shows.json entry.
    const productions = [
      mezProd('Hamilton', 2015, 100),
      mezProd('Hamilton', 2018, 50),
      mezProd('Hamilton', 2022, 30),
    ];
    const matches = matchProductions(productions, ourShows);
    const hamilton = matches.find(m => m.showId === 'hamilton-2015');
    assert.ok(hamilton, 'expected Hamilton match');
    assert.strictEqual(hamilton.prodIds.length, 3, `expected 3 prodIds merged for Hamilton, got ${hamilton.prodIds.length}`);
  });
});

// Venue-aware override ({name, venue}) — for shows whose title can only match
// Mezzanine via override (concert-series prefix like "Encores!") AND where the
// bare title has multiple same-named NYC productions Mezzanine cannot separate
// by year (no opening-date field). The venue pins the match to one.
// Reproduces encores-la-cage-aux-folles-off-broadway-2026 (2026-06-22): a
// name-only override merged Marquis/Longacre/City Center (~178 ratings) into
// one blended score; {name, venue:'City Center'} attaches only City Center
// (85 ratings, score 67).
describe('Mezzanine venue-aware override', () => {
  const encoresShow = [
    { id: 'encores-la-cage-aux-folles-off-broadway-2026', title: 'Encores! La Cage Aux Folles', category: 'broadway', openingDate: '2026-06-17', status: 'open' },
  ];
  const nycLaCageProds = [
    { objectId: 'marquis', show: { name: 'La Cage aux Folles' }, ratingsCount: 25, averageRating: 3.82, theater: { name: 'Marquis Theatre', isBroadway: true } },
    { objectId: 'longacre', show: { name: 'La Cage aux Folles' }, ratingsCount: 68, averageRating: 3.95, theater: { name: 'Longacre Theatre', isBroadway: true } },
    { objectId: 'citycenter', show: { name: 'La Cage aux Folles' }, ratingsCount: 85, averageRating: 3.36, theater: { name: 'New York City Center - Mainstage', geocodedCity: 'New York' } },
  ];

  test('venue override attaches ONLY the City Center production, not the merged Broadway revivals', () => {
    const matches = matchProductions(nycLaCageProds, encoresShow);
    assert.strictEqual(matches.length, 1, 'expected exactly one match');
    const m = matches[0];
    assert.deepStrictEqual(m.prodIds, ['citycenter'], `expected only City Center prodId, got ${JSON.stringify(m.prodIds)}`);
    assert.strictEqual(m.ratingsCount, 85, `expected 85 ratings (City Center only), got ${m.ratingsCount} (merge bug if ~178)`);
    assert.strictEqual(m.score, 67, `expected score 67, got ${m.score}`);
  });
});
