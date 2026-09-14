/**
 * Tests for scripts/build-ob-venues.js — the regenerator for
 * data/off-broadway-venues.json (the TodayTix OB discovery fallback allowlist).
 *
 * These avoid depending on data/shows.json (the "no-data-dependency" CI batch
 * runs without core data): they exercise serialize()/BLOCKLIST directly and
 * assert the COMMITTED list is well-formed. A drift check against shows.json
 * lives in the script's own --check mode, run where core data is present.
 *
 * Run: node --test tests/unit/build-ob-venues.test.mjs
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: asserts the SHAPE of the committed
// off-broadway-venues.json (sorted/normalized/no-blocklist-leak), not factual
// content — the source-of-truth (shows.json) sync is verified by
// `node scripts/build-ob-venues.js --check`, which runs where core data exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serialize, BLOCKLIST } = require('../../scripts/build-ob-venues.js');
const { isNonNycVenue } = require('../../scripts/lib/venue-classification.js');
const committed = require('../../data/off-broadway-venues.json');

test('serialize matches the on-disk format (2-space indent + trailing newline)', () => {
  const out = serialize(['atlantic', 'cherry lane']);
  assert.equal(out, '[\n  "atlantic",\n  "cherry lane"\n]\n');
});

test('serialize round-trips the committed list byte-for-byte (proves it was generated, not hand-edited)', () => {
  // The committed array, re-serialized, must equal a re-sort+serialize of itself.
  const resorted = [...committed].sort();
  assert.deepEqual(committed, resorted, 'committed list must be sorted');
  assert.equal(serialize(committed), serialize(resorted));
});

test('committed list is non-empty, unique, and normalized', () => {
  assert.ok(committed.length > 50, 'expected a substantial OB venue list');
  assert.equal(new Set(committed).size, committed.length, 'no duplicate entries');
  for (const v of committed) {
    assert.equal(v, v.toLowerCase(), `entry "${v}" must be lowercase`);
    assert.ok(!/ theatre$| theater$/.test(v), `entry "${v}" must have trailing Theatre/Theater stripped`);
    assert.ok(!/\(.*\)$/.test(v), `entry "${v}" must have trailing parenthetical stripped`);
  }
});

test('no blocklisted name leaked into the committed list', () => {
  for (const v of committed) {
    assert.ok(!BLOCKLIST.has(v), `blocklisted "${v}" must not appear in the venue list`);
  }
});

test('BLOCKLIST covers known neighborhood/placeholder noise but not real venues', () => {
  for (const noise of ['midtown e', 'east village', 'tba', '']) {
    assert.ok(BLOCKLIST.has(noise), `"${noise}" should be blocklisted`);
  }
  for (const real of ['theatre 71', 'lucille lortel', 'cherry lane']) {
    assert.ok(!BLOCKLIST.has(real), `"${real}" must NOT be blocklisted`);
  }
});

// ---------------------------------------------------------------------------
// Touring-house contamination (BRO-3211).
//
// This list is DERIVED from category='off-broadway' rows in shows.json, and it
// FEEDS isKnownOffBroadwayVenue(), which rescues untagged TodayTix rows INTO
// category='off-broadway'. That is a closed loop: one mis-categorised road date
// teaches the allowlist a touring venue, and every later engagement there is
// minted as an Off-Broadway production, which re-feeds the list.
//
// State Theatre New Jersey (New Brunswick, NJ) rode that loop to three bogus OB
// rows — The Music Man, Spamalot and Beetlejuice, all 2-3 day tour stops — and
// was only caught by eye. These tests close it: the first pins the known
// offender, the next two lock the matching behaviour that actually makes the
// rejection hold (variants in, real NYC venues out), and the last catches the
// NEXT touring house by shape rather than by name.
// ---------------------------------------------------------------------------

test('the State Theatre New Jersey touring house is rejected (BRO-3211)', () => {
  assert.ok(
    isNonNycVenue('State Theatre New Jersey'),
    'State Theatre New Jersey is a New Brunswick, NJ touring house that TodayTix lists ' +
    'under its NYC feed AND tags "Off Broadway"; if it is not rejected it re-enters the ' +
    'allowlist as soon as one road date lands, and mints more',
  );
  assert.ok(!committed.includes('state theatre new jersey'));
});

test('the rejection survives spelling and punctuation variants, not just the exact name', () => {
  // This is the test that matters. An exact Set.has(normalizeVenueName(v)) was
  // tried first and let three real-world shapes through, because
  // normalizeVenueName only strips a TRAILING parenthetical / TRAILING
  // "theatre"|"theater" / LEADING "the". A single miss is not cosmetic: the row
  // is admitted, written as category='off-broadway', and the generator then
  // re-learns the venue into this very list, restarting the loop.
  for (const variant of [
    'State Theatre New Jersey',
    'The State Theatre New Jersey',
    'State Theater New Jersey',                  // American spelling, mid-string
    'State Theatre New Jersey (New Brunswick)',  // trailing parenthetical
    'State Theatre, New Jersey',                 // comma
    'State Theatre New Jersey - New Brunswick',  // locality suffix
    'STATE THEATRE NEW JERSEY',
    '  State Theatre New Jersey  ',
  ]) {
    assert.ok(isNonNycVenue(variant), `variant must be rejected: ${JSON.stringify(variant)}`);
  }
  // A TodayTix-shape object, the form discover-new-shows.js actually passes.
  assert.ok(isNonNycVenue({ name: 'State Theater New Jersey' }));
});

test('the rejection does not swallow legitimate NYC venues', () => {
  for (const ok of [
    'Cherry Lane Theatre', 'New York City Center', 'Theatre 71', 'Soho Playhouse',
    'New Jersey Performing Arts Center', // a DIFFERENT venue - must not be caught by a loose /new jersey/
    'Lucille Lortel Theatre', 'The Public Theater',
  ]) {
    assert.ok(!isNonNycVenue(ok), `must NOT be rejected: ${ok}`);
  }
  assert.equal(isNonNycVenue(null), false);
  assert.equal(isNonNycVenue(undefined), false);
  assert.equal(isNonNycVenue({}), false);
  assert.equal(isNonNycVenue(''), false);
});

test('no venue outside New York is in the Off-Broadway allowlist', () => {
  // Off-Broadway is a New York City designation. An entry naming another state
  // or metro is a touring/regional house that leaked in via a mis-categorised
  // show — this catches the NEXT State Theatre New Jersey before it mints shows.
  //
  // Matched STRUCTURALLY, not by a list of city words. A bare-word list was
  // tried first and false-positived on real New York houses: "Virginia Theatre"
  // (Broadway) trips /virginia/, the Ohio Theatre on Wooster St trips /ohio/,
  // and anything on Houston St trips /houston/. Every genuine regional row in
  // the corpus instead carries an explicit ", <city>, <ST>" suffix
  // ("Goodman Theatre, Chicago, IL"), which a New York venue name never does.
  const REGIONAL_SUFFIX = /,\s*[^,]+,\s*(?:d\.?c\.?|[a-z]{2})\.?$/i;
  // Plus multi-word state names, for the no-comma shape ("State Theatre New
  // Jersey"). Deliberately excludes single-word state names that are also real
  // New York venue names (Virginia, Ohio, Georgia, Washington).
  const SPELLED_OUT_STATE = /\b(?:new jersey|rhode island|new hampshire|north carolina|south carolina|west virginia|connecticut|massachusetts|pennsylvania|illinois|minnesota|wisconsin|michigan|maryland|delaware|kentucky|tennessee|nebraska|oklahoma|arkansas|missouri|colorado|arizona|nevada|oregon|kansas|iowa|utah|idaho|montana|wyoming|alabama|alaska|hawaii|louisiana|mississippi|indiana)\b/i;

  const leaked = committed.filter(v => REGIONAL_SUFFIX.test(v) || SPELLED_OUT_STATE.test(v));
  assert.deepEqual(
    leaked, [],
    `non-NYC venue(s) in the Off-Broadway allowlist: ${leaked.join(', ')}. ` +
    'Off-Broadway is a NYC designation — a touring or regional house here means a show ' +
    'was mis-categorised as off-broadway. Fix the show row AND extend ' +
    'NON_NYC_VENUE_RE in scripts/lib/venue-classification.js (which both the ' +
    'generator and discovery reject on), or the derive->classify loop re-adds it.',
  );

  // The matcher must actually fire on the shapes it is meant to catch...
  for (const regional of [
    'american repertory theater, cambridge, ma',
    'goodman theatre, chicago, il',
    'arena stage, washington, dc',
    'state theatre new jersey',
  ]) {
    assert.ok(
      REGIONAL_SUFFIX.test(regional) || SPELLED_OUT_STATE.test(regional),
      `should be detected as non-NYC: ${regional}`,
    );
  }
  // ...and must NOT fire on real New York venue names.
  for (const nyc of [
    'virginia', 'ohio', 'the ohio', 'houston hall', 'chicago',
    'new york city center', 'cherry lane', 'lucille lortel', 'st. ann\'s warehouse',
    '59e59 theaters, theater a', 'theatre row, theatre 5',
  ]) {
    assert.ok(
      !REGIONAL_SUFFIX.test(nyc) && !SPELLED_OUT_STATE.test(nyc),
      `real NYC venue must not be flagged: ${nyc}`,
    );
  }
});
