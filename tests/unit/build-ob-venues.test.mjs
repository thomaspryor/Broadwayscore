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
const { isNonNycVenue, isNonNycLocale, isMisCategorisedNonNycRow } = require('../../scripts/lib/venue-classification.js');
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
  // Uses the SHARED isNonNycLocale predicate rather than a copy of its regexes,
  // so this test and validate-data.js's category/venue gate cannot drift
  // (CLAUDE.md 15 — require the real function, never restate the logic).
  const leaked = committed.filter(v => isNonNycLocale(v));
  assert.deepEqual(
    leaked, [],
    `non-NYC venue(s) in the Off-Broadway allowlist: ${leaked.join(', ')}. ` +
    'Off-Broadway is a NYC designation — a touring or regional house here means a show ' +
    'was mis-categorised as off-broadway. Fix the show row AND extend ' +
    'NON_NYC_VENUE_RE in scripts/lib/venue-classification.js (which both the ' +
    'generator and discovery reject on), or the derive->classify loop re-adds it.',
  );
});

test('isNonNycLocale fires on regional shapes and stays silent on New York ones', () => {
  // Both directions asserted, so the guard above cannot rot into a rubber stamp
  // by quietly matching nothing.
  for (const regional of [
    'american repertory theater, cambridge, ma',
    'goodman theatre, chicago, il',
    'arena stage, washington, dc',
    'Joan and Robert Rechnitz Theater, Two River Theater, Red Bank, NJ',
    'state theatre new jersey',
  ]) {
    assert.ok(isNonNycLocale(regional), `should be detected as non-NYC: ${regional}`);
  }
  for (const nyc of [
    'virginia', 'the ohio', 'houston hall', 'chicago',        // bare city/state words that are real NY venue names
    'new york city center', 'cherry lane', 'lucille lortel',
    '59e59 theaters, theater a', 'theatre row, theatre 5',    // internal commas, but no ", city, ST" tail
  ]) {
    assert.ok(!isNonNycLocale(nyc), `real NYC venue must not be flagged: ${nyc}`);
  }
});

test('isMisCategorisedNonNycRow: the COMBINED category+venue decision, both directions', () => {
  // Ship-check finding on the BRO-3211 follow-up: the venue half
  // (isNonNycLocale) is asserted both ways above, but nothing covered the
  // decision validate-data.js actually makes — category AND venue TOGETHER.
  // That gap is why the guard shipped as a raw `category === 'broadway'`
  // literal and reddened main against
  // audit-broadway-category-predicate.js --strict on the very next run.
  //
  // This requires the REAL exported predicate (CLAUDE.md rule 15), so a change
  // to the decision in scripts/lib/venue-classification.js fails HERE instead
  // of passing against a re-implemented copy.
  const NJ = 'State Theatre New Jersey, New Brunswick, NJ'; // the venue that actually minted 3 bogus rows

  // MUST fire — a NYC-only category at a venue outside New York.
  assert.ok(isMisCategorisedNonNycRow({ category: 'broadway', venue: NJ }));
  assert.ok(isMisCategorisedNonNycRow({ category: 'off-broadway', venue: NJ }));
  // A null category counts as Broadway by project-wide convention
  // (isBroadwayCategory's own documented behaviour), so it fires too — this is
  // the case the raw literal silently missed.
  assert.ok(isMisCategorisedNonNycRow({ venue: NJ }));
  assert.ok(isMisCategorisedNonNycRow({ category: null, venue: NJ }));

  // MUST NOT fire — real NYC houses, out-of-scope categories, absent venue.
  assert.ok(!isMisCategorisedNonNycRow({ category: 'broadway', venue: 'Winter Garden Theatre' }));
  assert.ok(!isMisCategorisedNonNycRow({ category: 'off-broadway', venue: 'Lucille Lortel Theatre' }));
  assert.ok(!isMisCategorisedNonNycRow({ category: 'regional', venue: NJ }), 'regional AT a regional house is correct, not a defect');
  assert.ok(!isMisCategorisedNonNycRow({ category: 'west-end', venue: 'Prince Edward Theatre' }));
  assert.ok(!isMisCategorisedNonNycRow({ category: 'broadway', venue: null }), 'no venue means nothing to judge');
  assert.ok(!isMisCategorisedNonNycRow({ category: 'broadway' }));
  assert.ok(!isMisCategorisedNonNycRow(null), 'must not throw on a null row');
  assert.ok(!isMisCategorisedNonNycRow(undefined));
});
