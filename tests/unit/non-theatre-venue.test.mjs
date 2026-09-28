// NON_THEATRE_VENUE_RE and the predicates built on it (2026 data audit,
// BRO-4204 S4-T6 / S4-T8): the regex itself, the theatre-house exemption the
// validate-data.js warning uses, the "null"-dates one-night rule, and the
// London receiving-house list. All through the real exports — nothing is
// re-implemented here (CLAUDE.md §15).
//
// Run: node --test tests/unit/non-theatre-venue.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  NON_THEATRE_VENUE_RE,
  isNonTheatreVenue,
  isTheatreHouse,
  isUnreviewedNonTheatreRow,
  LONDON_RECEIVING_HOUSE_RE,
  isLondonReceivingHouse,
} = require('../../scripts/lib/venue-classification.js');
const { isNonTheaterContent, isOneNightShow } = require('../../scripts/discover-new-shows.js');

const tt = (title, venue, category, extra = {}) => ({
  displayName: title, name: title, venue: { name: venue },
  category: category ? { name: category } : null, subcategories: [], description: '', ...extra,
});

// ── The six cases the sprint task names ─────────────────────────────────────

test('Carnegie Hall + Concerts: rejected', () => {
  const row = tt('Harry Connick Jr.', 'Stern Auditorium / Perelman Stage at Carnegie Hall', 'Concerts');
  assert.equal(isNonTheatreVenue(row.venue), true);
  assert.equal(isNonTheaterContent(row), true);
  assert.equal(isNonTheaterContent(row, { market: 'nyc' }), true);
});

test('New Victory Theater + Plays: accepted', () => {
  const row = tt('No Excuses, No Limits', 'New Victory Theater', 'Plays');
  assert.equal(isNonTheatreVenue(row.venue), false);
  assert.equal(isNonTheaterContent(row), false);
});

test('Twickenham: rejected (stadium), whatever the tag', () => {
  assert.equal(NON_THEATRE_VENUE_RE.test('Twickenham Stadium'), true);
  assert.equal(isNonTheaterContent(tt('Barbarians v Wales Double Header', 'Twickenham Stadium', null), { market: 'london' }), true);
  assert.equal(isNonTheaterContent(tt('Barbarians v Wales Double Header', 'Twickenham Stadium', 'Plays'), { market: 'london' }), true, 'London paths have no Plays override');
});

test("Sadler's Wells + Musicals: accepted (a dance house is a theatre)", () => {
  assert.equal(NON_THEATRE_VENUE_RE.test("Sadler's Wells"), false);
  assert.equal(isNonTheaterContent(tt('The Car Man', "Sadler's Wells", 'Musicals'), { market: 'london' }), false);
});

test('54 Below: rejected as a cabaret room; admitted only when TodayTix tags it Plays or Musicals (NYC)', () => {
  assert.equal(isNonTheatreVenue('54 Below'), true);
  assert.equal(isNonTheatreVenue("Feinstein's/54 Below"), true);
  assert.equal(isNonTheaterContent(tt("Legally Blonde's Orfeh: Unbound", '54 Below', 'Cabaret')), true);
  assert.equal(isNonTheaterContent(tt('Some Cabaret Night', '54 Below', null)), true, 'no category → no override');
  assert.equal(isNonTheaterContent(tt('A Musical Booked Into 54 Below', '54 Below', 'Musicals')), false, 'Musicals tag overrides in NYC');
  assert.equal(isNonTheaterContent(tt('A Play Booked Into 54 Below', '54 Below', 'Plays')), false, 'Plays tag overrides in NYC');
});

test('Met Opera + opera: accepted per the owner rule, at ingest and in the validate-data warning', () => {
  assert.equal(isNonTheatreVenue('Metropolitan Opera House'), false);
  assert.equal(isNonTheaterContent(tt('Tosca', 'Metropolitan Opera House', 'Opera')), false);
  assert.equal(isUnreviewedNonTheatreRow({ id: 'tosca-off-broadway-2026', title: 'Tosca', venue: 'Metropolitan Opera House', type: 'opera', category: 'off-broadway' }, false), false);
});

// ── The regex: real rows it must catch ──────────────────────────────────────

test('NON_THEATRE_VENUE_RE matches the audit rows and the named siblings in both markets', () => {
  const hit = [
    // NYC
    'Stern Auditorium / Perelman Stage at Carnegie Hall', 'Radio City Music Hall', 'Music Hall of Williamsburg',
    'Madison Square Garden', 'Hulu Theater at Madison Square Garden', 'Barclays Center', 'Beacon Theatre', 'Beacon Theater',
    'The Town Hall', 'Town Hall, New York', '54 Below', "Joe's Pub", 'Joe’s Pub', "Joe's Pub at The Public Theatre",
    'Birdland', 'Birdland Jazz Club', 'Café Carlyle', 'Cafe Carlyle', 'Bowery Ballroom', 'Hammerstein Ballroom',
    // London
    'Twickenham Stadium', 'Wembley Stadium', 'OVO Arena Wembley', 'The O2 Arena', 'The O2', 'indigo at The O2',
    'Royal Albert Hall', 'Barbican Hall', 'Royal Festival Hall - Southbank Centre', 'Queen Elizabeth Hall - Southbank Centre',
    'Cadogan Hall', 'Union Chapel', 'Alexandra Palace', 'Eventim Apollo', 'Hammersmith Apollo', 'Crystal Palace',
    'King’s Place', "King's Place", 'Battersea Power Station', 'ABBA Arena',
    // generic tokens
    'Forest Hills Stadium', 'UBS Arena', 'Some Concert Hall', 'Gotham Comedy Club', 'Blue Note Jazz Club', 'Sandown Park Racecourse',
  ];
  for (const venue of hit) {
    assert.equal(NON_THEATRE_VENUE_RE.test(venue), true, `should match: ${venue}`);
    assert.equal(isNonTheatreVenue(venue), true, `isNonTheatreVenue: ${venue}`);
    assert.equal(isNonTheatreVenue({ name: venue }), true, `isNonTheatreVenue({name}): ${venue}`);
  }
});

test('NON_THEATRE_VENUE_RE does not hit the theatres that looser tokens would', () => {
  const miss = [
    // bare "park" would hit all of these
    'Park Theatre', "Regent's Park Open Air Theatre", 'Park Avenue Armory',
    // bare "wembley" / "apollo"
    'Troubadour Wembley Park Theatre', 'Apollo Theatre', 'Apollo Victoria Theatre',
    // Barbican Hall only, not the Centre or the Theatre
    'Barbican Theatre', 'Barbican Centre',
    // the theatre inside Ally Pally
    'Alexandra Palace Theatre',
    // "arena" next to "Stage": a regional theatre
    'Arena Stage, Washington, DC',
    // "Town Hall" only as NYC's The Town Hall
    'Shoreditch Town Hall',
    // "music hall" but a theatre
    "Wilton's Music Hall", 'Wilton’s Music Hall',
    // opera houses, dance houses, Off-Broadway houses the audit keeps
    'Metropolitan Opera House', 'London Coliseum', 'London Palladium', "Sadler's Wells", 'Peacock Theatre',
    'New Victory Theater', 'NYU Skirball', 'New York City Center', 'David H. Koch Theater', 'Studio Seaview',
    'Peter Jay Sharp Theatre at Symphony Space', 'Kit Kat Club at the August Wilson Theatre', 'Hackney Empire',
  ];
  for (const venue of miss) {
    assert.equal(NON_THEATRE_VENUE_RE.test(venue), false, `must not match: ${venue}`);
    assert.equal(isNonTheatreVenue(venue), false, `isNonTheatreVenue: ${venue}`);
  }
});

test('isNonTheatreVenue is false for empty / TBA / non-string input', () => {
  for (const v of [null, undefined, '', 'TBA', {}, { name: null }, { name: 'TBA' }]) {
    assert.equal(isNonTheatreVenue(v), false);
  }
});

// ── Theatre-house exemption (validate-data WARN) ────────────────────────────

test('isTheatreHouse: SOLT houses and official Broadway houses, exact match only', () => {
  assert.equal(isTheatreHouse('Apollo Victoria Theatre'), true);
  assert.equal(isTheatreHouse('Booth Theatre'), true);
  assert.equal(isTheatreHouse({ name: 'Hudson Theatre' }), true);
  assert.equal(isTheatreHouse('Broadway Comedy Club'), false, 'no partial match against the Broadway Theatre');
  assert.equal(isTheatreHouse("Joe's Pub"), false);
  assert.equal(isTheatreHouse('Hackney Empire'), false);
  assert.equal(isTheatreHouse('TBA'), false);
  assert.equal(isTheatreHouse(null), false);
});

test('isUnreviewedNonTheatreRow: venue match AND no review AND not opera AND not a theatre house', () => {
  const joes = { id: 'betty-buckley-random-notes-off-broadway-2026', title: 'Betty Buckley: Random Notes', venue: "Joe's Pub", type: 'special', category: 'off-broadway' };
  assert.equal(isUnreviewedNonTheatreRow(joes, false), true);
  assert.equal(isUnreviewedNonTheatreRow(joes, true), false, 'a review keeps it (safety valve)');
  assert.equal(isUnreviewedNonTheatreRow({ ...joes, type: 'opera' }, false), false, 'opera keeps it');
  assert.equal(isUnreviewedNonTheatreRow({ ...joes, venue: 'Orpheum Theatre' }, false), false, 'not a regex venue');
  assert.equal(isUnreviewedNonTheatreRow({ ...joes, venue: null }, false), false);
  assert.equal(isUnreviewedNonTheatreRow(null, false), false);
  // Reviewed arena rows the audit keeps
  assert.equal(isUnreviewedNonTheatreRow({ id: 'x', title: 'Les Misérables: The Arena Concert Spectacular', venue: 'Radio City Music Hall', type: 'special' }, true), false);
  // A regex hit that is nevertheless a SOLT house would be exempt (none today; guard the branch)
  assert.equal(isUnreviewedNonTheatreRow({ id: 'y', title: 'y', venue: 'Apollo Victoria Theatre', type: 'musical' }, false), false);
});

// ── "null" dates at a non-theatre venue = one-off booking ───────────────────

test('isOneNightShow: TodayTix "null" dates fire the one-night skip only at a non-theatre venue', () => {
  assert.equal(isOneNightShow({ startDate: 'null', endDate: 'null', venue: { name: 'Stern Auditorium / Perelman Stage at Carnegie Hall' } }), true);
  assert.equal(isOneNightShow({ startDate: 'null', endDate: 'null', venue: 'Royal Albert Hall' }), true);
  assert.equal(isOneNightShow({ startDate: '2026-11-01', endDate: 'null', venue: { name: '54 Below' } }), true);
  // Card #1446 stands: a not-yet-on-sale production at a theatre is not a one-night event
  assert.equal(isOneNightShow({ displayName: 'Mix and Master', startDate: 'null', endDate: 'null' }), false);
  assert.equal(isOneNightShow({ startDate: 'null', endDate: 'null', venue: { name: 'Hudson Theatre' } }), false);
  assert.equal(isOneNightShow({ startDate: 'null', endDate: 'null', venue: { name: 'TBA' } }), false);
  // Ordinary rule unchanged
  assert.equal(isOneNightShow({ startDate: '2026-10-04', endDate: '2026-10-04', venue: { name: 'Orpheum Theatre' } }), true);
  assert.equal(isOneNightShow({ startDate: '2026-10-04', endDate: '2026-12-20', venue: { name: 'Royal Albert Hall' } }), false, 'a dated run at a regex venue is the venue gate\'s business, not this one');
  assert.equal(isOneNightShow({ startDate: null, endDate: null, venue: { name: 'Royal Albert Hall' } }), false, 'real null (not the string) is still "no dates"');
});

// ── London receiving houses ─────────────────────────────────────────────────

test('LONDON_RECEIVING_HOUSE_RE: tour-stop houses reject on London paths only', () => {
  for (const venue of ['Hackney Empire', 'New Wimbledon Theatre', 'New Wimbledon Theater', 'Richmond Theatre', 'Churchill Theatre Bromley', 'Fairfield Halls', 'New Victoria Theatre, Woking']) {
    assert.equal(LONDON_RECEIVING_HOUSE_RE.test(venue), true, venue);
    assert.equal(isLondonReceivingHouse({ name: venue }), true, venue);
  }
  for (const venue of ['Hackney Showroom', 'Wimbledon Studio', 'Richmond Shakespeare Society', 'Victoria Palace Theatre', 'TBA', '']) {
    assert.equal(isLondonReceivingHouse(venue), false, venue);
  }
  const karate = tt('The Karate Kid - The Musical', 'New Wimbledon Theatre', 'Musicals');
  assert.equal(isNonTheaterContent(karate, { market: 'london' }), true);
  assert.equal(isNonTheaterContent(karate, { market: 'nyc' }), false, 'the receiving-house gate is London-only');
});
