// BRO-4396: per-venue listings-reader coverage. Requires the real module and
// the real OB_VENUE_CONFIGS (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeVenueReaderCoverage, findReaderFor, readerKeys, diffUncovered, alertableUncovered, groupRooms,
} = require('./ob-venue-reader-coverage.js');
const { OB_VENUE_CONFIGS } = require('./venue-listing-discover.js');

const TODAY = '2026-09-29';
const known = () => true;
const show = (id, venue, extra = {}) => ({ id, title: id, category: 'off-broadway', venue, status: 'closed', closingDate: '2026-06-01', ...extra });

test('the acceptance floor: at least 30 venue readers', () => {
  assert.ok(OB_VENUE_CONFIGS.length >= 30, `only ${OB_VENUE_CONFIGS.length} readers`);
});

test('findReaderFor: rooms and company aliases resolve to their reader', () => {
  const keys = readerKeys(OB_VENUE_CONFIGS);
  const cases = [
    ['59E59 Theaters, Theater C', '59E59 Theaters'],
    ['Huron Club at the SoHo Playhouse', 'Soho Playhouse'],
    ['Irish Repertory Theatre', 'Irish Rep'],
    ['LCT3 at the Claire Tow Theater', 'Lincoln Center Theater'],
    ['DR2 Theatre', 'Daryl Roth Theatre'],
    ["Joe's Pub", 'The Public Theater'],
    ['The Theater Center', 'The Theater Center'],
    ['Metropolitan Opera House', 'scripts/discover-opera-shows.js'],
  ];
  for (const [venue, reader] of cases) assert.equal(findReaderFor(venue, keys), reader, venue);
  // Generic-only names never match by substring.
  assert.equal(findReaderFor('Gene Frankel Theater Center', keys), null);
  assert.equal(findReaderFor('Housing Works Bookstore', keys), null);
});

test('computeVenueReaderCoverage: active = a show in the last 12 months or live; unknown venues ignored', () => {
  const shows = [
    show('a', 'Covered House', { status: 'open' }),
    show('b', 'Busy Loft', { closingDate: '2026-05-01' }),
    show('c', 'Busy Loft', { closingDate: '2026-08-01' }),
    show('d', 'Old Barn', { closingDate: '2024-01-01' }),
    show('e', 'Somewhere', { category: 'broadway' }),
  ];
  const r = computeVenueReaderCoverage({ shows, configs: [{ name: 'Covered House' }], todayIso: TODAY, isKnownVenue: known });
  assert.equal(r.active, 2);
  assert.equal(r.activeCovered, 1);
  assert.deepEqual(r.uncovered.map(u => [u.venue, u.recentShows, u.lastShow]), [['Busy Loft', 2, 'c']]);
});

test('groupRooms folds rooms of one house', () => {
  const g = groupRooms([
    { venue: 'The Shed', key: 'shed', recentShows: 3, lastDate: '2026-01-01', lastShow: 'x' },
    { venue: 'The Griffin Theater at The Shed', key: 'griffin theater at shed', recentShows: 2, lastDate: '2026-05-01', lastShow: 'y' },
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].recentShows, 5);
  assert.equal(g[0].lastShow, 'y');
  assert.ok(g[0].noReaderReason, 'The Shed carries a recorded reason');
});

test('alertableUncovered + diffUncovered: alert once per busy, unexplained venue', () => {
  const uncovered = [
    { key: 'busy loft', venue: 'Busy Loft', recentShows: 2, spellings: ['Busy Loft'] },
    { key: 'one off', venue: 'One Off', recentShows: 1, spellings: ['One Off'] },
    { key: 'shed', venue: 'The Shed', recentShows: 5, spellings: ['The Shed'], noReaderReason: 'queue-it' },
  ];
  const alertable = alertableUncovered(uncovered);
  assert.deepEqual(alertable.map(u => u.key), ['busy loft']);
  const first = diffUncovered({}, alertable, 't1');
  assert.deepEqual(first.fresh.map(u => u.key), ['busy loft']);
  const second = diffUncovered(first.ledger, alertable, 't2');
  assert.deepEqual(second.fresh, []);
  assert.equal(second.ledger['busy loft'].firstSeen, 't1');
  // Covered in between → dropped from the ledger → alerts again if it regresses.
  const covered = diffUncovered(second.ledger, [], 't3');
  assert.deepEqual(covered.ledger, {});
});

// ── BRO-4398: the London pool ──────────────────────────────────────────────
const { londonReaderConfigs, findReaderKeyFor, isDatedReader } = require('./ob-venue-reader-coverage.js');
const { OWE_VENUE_CONFIGS } = require('./venue-listing-discover.js');
const LINK_PAGES = [
  { name: 'Park Theatre', category: 'off-west-end', linkPattern: /x/ },
  { name: 'The Other Palace', category: 'off-west-end', linkPattern: /x/ },
  { name: 'Marylebone Theatre', category: 'off-west-end', linkPattern: /x/ },
];
const oweShow = (id, venue, extra = {}) => ({ id, title: id, category: 'off-west-end', venue, status: 'open', openingDate: '2026-09-01', ...extra });

test('londonReaderConfigs: a dated reader replaces the same venue\'s link reader; link-only venues stay, undated', () => {
  const configs = londonReaderConfigs(OWE_VENUE_CONFIGS, LINK_PAGES);
  assert.equal(configs.filter(c => c.name === 'Park Theatre').length, 1);
  assert.equal(isDatedReader(configs.find(c => c.name === 'Park Theatre')), true);
  assert.equal(isDatedReader(configs.find(c => c.name === 'The Other Palace')), false);
});

test('London coverage: dated vs undated-only vs uncovered; "Park" does not claim Regent\'s Park or Wembley Park', () => {
  const keys = readerKeys(londonReaderConfigs(OWE_VENUE_CONFIGS, LINK_PAGES), { otherReaders: [] });
  assert.equal(findReaderFor("Regent's Park Open Air Theatre", keys), null);
  assert.equal(findReaderFor('Troubadour Wembley Park Theatre', keys), 'Troubadour Wembley Park Theatre');
  assert.equal(findReaderFor('The Maria Theatre', keys), 'Young Vic');
  assert.equal(findReaderFor('Southwark Playhouse Elephant', keys), 'Southwark Playhouse');
  assert.equal(findReaderKeyFor('Hampstead Theatre Downstairs', keys).dated, true);

  const shows = [
    oweShow('a', 'Bush Theatre'), oweShow('b', 'Bush Theatre'),
    oweShow('c', 'The Other Palace - Studio'),
    oweShow('d', 'Donmar Warehouse'), oweShow('e', 'Donmar Warehouse'),
    oweShow('f', 'Brand New Fringe Room'), oweShow('g', 'Brand New Fringe Room'),
    oweShow('h', 'Shaftesbury Theatre', { category: 'west-end' }),
  ];
  const cov = computeVenueReaderCoverage({ shows, configs: londonReaderConfigs(OWE_VENUE_CONFIGS, LINK_PAGES), todayIso: '2026-09-30', market: 'london', isKnownVenue: known });
  assert.equal(cov.market, 'london');
  assert.equal(cov.active, 4);
  assert.equal(cov.activeCovered, 2);
  assert.equal(cov.activeDated, 1);
  assert.deepEqual(cov.undatedOnly.map(u => u.venue), ['The Other Palace - Studio']);
  const byVenue = Object.fromEntries(cov.uncovered.map(u => [u.venue, u]));
  assert.match(byVenue['Donmar Warehouse'].noReaderReason, /403/);
  assert.equal(byVenue['Brand New Fringe Room'].noReaderReason, null);
  assert.deepEqual(alertableUncovered(cov.uncovered).map(u => u.venue), ['Brand New Fringe Room']);
});

test('computeVenueReaderCoverage: unknown market throws; the NYC default is unchanged', () => {
  assert.throws(() => computeVenueReaderCoverage({ shows: [], configs: [], market: 'paris' }), /unknown market/);
  const cov = computeVenueReaderCoverage({ shows: [show('x', '59E59 Theaters', { status: 'open' })], configs: OB_VENUE_CONFIGS, todayIso: TODAY, isKnownVenue: known });
  assert.equal(cov.market, 'nyc');
  assert.equal(cov.activeCovered, 1);
});
