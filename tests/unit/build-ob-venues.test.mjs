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
// was only caught by eye. These two tests close it: the first pins the known
// offender, the second catches the NEXT one by shape rather than by name.
// ---------------------------------------------------------------------------

test('the State Theatre New Jersey touring house stays blocklisted (BRO-3211)', () => {
  assert.ok(
    BLOCKLIST.has('state theatre new jersey'),
    'state theatre new jersey is a New Brunswick, NJ touring house that TodayTix lists ' +
    'under its NYC feed; without the blocklist entry it re-enters the allowlist as soon ' +
    'as one mis-categorised road date lands, and mints more',
  );
  assert.ok(!committed.includes('state theatre new jersey'));
});

test('no venue outside New York is in the Off-Broadway allowlist', () => {
  // Off-Broadway is a New York City designation. Any entry naming another
  // state or a non-NYC metro is a touring/regional house that leaked in via a
  // mis-categorised show — the failure this catches is the NEXT State Theatre
  // New Jersey, before it mints shows.
  const NON_NYC = new RegExp([
    'new jersey', 'connecticut', 'massachusetts', 'pennsylvania', 'maryland',
    'delaware', 'virginia', 'california', 'illinois', 'texas', 'florida',
    'georgia', 'ohio', 'michigan', 'minnesota', 'colorado', 'arizona',
    'washington, d\\.?c\\.?', 'rhode island', 'new hampshire', 'vermont',
    'philadelphia', 'boston', 'chicago', 'los angeles', 'san diego',
    'san francisco', 'seattle', 'denver', 'atlanta', 'houston', 'dallas',
    'baltimore', 'pittsburgh', 'cleveland', 'detroit', 'nashville',
    'new brunswick', 'red bank', 'princeton', 'stamford', 'hartford',
    'la jolla', 'cambridge, ma', 'toronto', 'london',
  ].join('|'), 'i');

  const leaked = committed.filter(v => NON_NYC.test(v));
  assert.deepEqual(
    leaked, [],
    `non-NYC venue(s) in the Off-Broadway allowlist: ${leaked.join(', ')}. ` +
    'Off-Broadway is a NYC designation — a touring or regional house here means a show ' +
    'was mis-categorised as off-broadway. Fix the show row AND add the venue to ' +
    'BLOCKLIST in scripts/build-ob-venues.js, or the derive->classify loop re-adds it.',
  );
});
