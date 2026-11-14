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
  { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06', status: 'open', venue: 'Richard Rodgers Theatre' },
];

function mezProd(showName, year, ratingsCount, avg = 3.5, theater = 'Some Theater') {
  return {
    objectId: `pid-${showName.toLowerCase().replace(/\s/g, '-')}-${year}`,
    show: { name: showName },
    showName,
    opened: { __type: 'Date', iso: `${year}-01-01T00:00:00Z` },
    ratingsCount,
    averageRating: avg,
    theater: { name: theater },
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

  test('non-sibling shows still merge multiple productions at the SAME venue across years (long-running shows)', () => {
    // Hamilton has no siblings; a long-running show with multiple Mezzanine
    // snapshots at its one continuous venue should still merge them.
    const productions = [
      mezProd('Hamilton', 2015, 100, 3.5, 'Richard Rodgers Theatre'),
      mezProd('Hamilton', 2018, 50, 3.5, 'Richard Rodgers Theatre'),
      mezProd('Hamilton', 2022, 30, 3.5, 'Richard Rodgers Theatre'),
    ];
    const matches = matchProductions(productions, ourShows);
    const hamilton = matches.find(m => m.showId === 'hamilton-2015');
    assert.ok(hamilton, 'expected Hamilton match');
    assert.strictEqual(hamilton.prodIds.length, 3, `expected 3 prodIds merged for Hamilton, got ${hamilton.prodIds.length}`);
  });

  // BRO-975: the pre-fix version of this file asserted that non-sibling shows
  // merge ALL same-titled productions regardless of venue — that's exactly the
  // contamination bug (Romeo and Juliet's current Harold Pinter run getting
  // merged with an unrelated Duke of York's production just because neither
  // show has a shows.json sibling to trigger the year gate above). A
  // different-venue production with no shows.json sibling to attach to is
  // now dropped instead of merged into the venue it doesn't belong to.
  test('non-sibling shows do NOT merge a different-venue production of the same title (one-off revival contamination)', () => {
    const productions = [
      mezProd('Hamilton', 2015, 100, 3.5, 'Richard Rodgers Theatre'), // current run
      mezProd('Hamilton', 2003, 40, 3.0, 'Some Regional Theater'),    // unrelated production, different venue
    ];
    const matches = matchProductions(productions, ourShows);
    const hamilton = matches.find(m => m.showId === 'hamilton-2015');
    assert.ok(hamilton, 'expected Hamilton match');
    assert.deepStrictEqual(hamilton.prodIds, ['pid-hamilton-2015'], `expected only the current-venue production, got ${JSON.stringify(hamilton.prodIds)}`);
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

// BRO-5167: shows in previews (no openingDate yet) at a West End house whose
// shows.json venue is written "Drury Lane, Theatre Royal".
describe('Mezzanine matcher: earlier closed runs and inverted venue names (BRO-5167)', () => {
  const run = (name, theater, firstPreview, closed, ratingsCount) => ({
    objectId: `pid-${theater.replace(/\W+/g, '-')}-${firstPreview.slice(0, 4)}`,
    show: { name }, showName: name,
    firstPreview: { __type: 'Date', iso: `${firstPreview}T04:00:00.000Z` },
    ...(closed ? { closed: { __type: 'Date', iso: `${closed}T04:00:00.000Z` } } : {}),
    ratingsCount, averageRating: 4, theater: { name: theater },
  });

  test('a single exact-title production that closed before our previews is NOT linked (An Oak Tree)', () => {
    const show = { id: 'an-oak-tree-off-west-end-2026', title: 'An Oak Tree', venue: 'The Other Palace - Main Theatre', previewsStartDate: '2026-01-07', openingDate: null, status: 'open' };
    const matches = matchProductions([run('An Oak Tree', 'Young Vic Theatre', '2025-05-06', '2025-05-17', 56)], [show]);
    assert.strictEqual(matches.length, 0, `expected no link, got ${JSON.stringify(matches.map(m => m.prodIds))}`);
  });

  test('"Drury Lane, Theatre Royal" matches Mezzanine "Theatre Royal Drury Lane" and drops the 2019 Barbican run', () => {
    const show = { id: 'jcs-2026', title: 'Jesus Christ Superstar', venue: 'Drury Lane, Theatre Royal', previewsStartDate: '2026-01-16', openingDate: null, status: 'open' };
    const matches = matchProductions([
      run('Jesus Christ Superstar', 'Barbican Theatre', '2019-07-04', '2019-08-24', 107),
      run('Jesus Christ Superstar', 'Theatre Royal Drury Lane', '2026-01-16', null, 54),
    ], [show]);
    assert.strictEqual(matches.length, 1);
    assert.deepStrictEqual(matches[0].prodIds, ['pid-Theatre-Royal-Drury-Lane-2026']);
  });

  test('a long-running production with no closing date still links (Phantom-style)', () => {
    const show = { id: 'mousetrap', title: 'The Mousetrap', venue: "St Martin's Theatre", openingDate: '1974-03-25', status: 'open' };
    const matches = matchProductions([run('The Mousetrap', "St Martin's Theatre", '1952-11-25', null, 500)], [show]);
    assert.strictEqual(matches.length, 1);
  });
});

describe('Mezzanine matcher: leftovers after dropping earlier runs must still verify (BRO-5167)', () => {
  const prod = (objectId, theater, from, to, ratingsCount) => ({
    objectId, show: { name: 'The Maids' }, ratingsCount, averageRating: 4, theater: { name: theater },
    ...(from ? { firstPreview: { __type: 'Date', iso: `${from}T04:00:00.000Z` } } : {}),
    ...(to ? { closed: { __type: 'Date', iso: `${to}T04:00:00.000Z` } } : {}),
  });
  const show = { id: 'the-maids-off-broadway-2026', title: 'The Maids', venue: "St. Ann's Warehouse", previewsStartDate: '2026-05-17', openingDate: '2026-05-17', status: 'closed' };

  test('an undated production at another theater is NOT linked once the earlier run elsewhere is set aside', () => {
    // Real shape: Donmar Warehouse run (closed 2025-11-29) + an undated Barbican record.
    const prods = [prod('donmar', 'Donmar Warehouse', '2025-10-13', '2025-11-29', 120), prod('barbican', 'The Barbican', null, null, 3)];
    assert.strictEqual(matchProductions(prods, [show]).length, 0);
  });

  test('a same-theater earlier run (return engagement) keeps the existing same-venue behavior', () => {
    const prods = [prod('sa-2025', "St. Ann's Warehouse", '2025-03-01', '2025-04-01', 60)];
    const m = matchProductions(prods, [show]);
    assert.strictEqual(m.length, 1);
    assert.deepStrictEqual(m[0].prodIds, ['sa-2025']);
  });
});

describe('Mezzanine matcher: previews-only show keeps its current run after an earlier run is dropped (BRO-5167)', () => {
  const prod = (objectId, theater, from, to, ratingsCount) => ({
    objectId, show: { name: 'Example Musical' }, ratingsCount, averageRating: 4, theater: { name: theater },
    ...(from ? { firstPreview: { __type: 'Date', iso: `${from}T04:00:00.000Z` } } : {}),
    ...(to ? { closed: { __type: 'Date', iso: `${to}T04:00:00.000Z` } } : {}),
  });
  // Venue renamed (Queen's -> Sondheim): venuesMatch fails, so only the year can verify.
  const show = { id: 'example-musical-west-end-2026', title: 'Example Musical', venue: 'Sondheim Theatre', previewsStartDate: '2026-09-01', status: 'previews', market: 'west-end' };

  test('the current run under an old venue name still links via the previews year', () => {
    const prods = [prod('yv', 'Young Vic', '2025-03-01', '2025-04-01', 40), prod('cur', "Queen's Theatre", '2026-09-01', null, 12)];
    const m = matchProductions(prods, [show]);
    assert.strictEqual(m.length, 1);
    assert.deepStrictEqual(m[0].prodIds, ['cur']);
  });

  test('a 0-rating earlier record does not strip the single-candidate pass', () => {
    const prods = [prod('yv', 'Young Vic', '2025-03-01', '2025-04-01', 0), prod('cur', "Queen's Theatre", null, null, 12)];
    const m = matchProductions(prods, [show]);
    assert.strictEqual(m.length, 1);
    assert.deepStrictEqual(m[0].prodIds, ['cur']);
  });
});
