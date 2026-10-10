// S4-T7 (2026 data audit, BRO-4204): "West End" is a placeholder venue, and
// the placeholder predicate has exactly ONE home — scripts/lib/placeholder-
// venue.js — shared by the census CLI, the write-time guard and the source
// lint. Requires the REAL modules (CLAUDE.md §15); the source assertions at
// the bottom are what stop a fourth private copy from ever drifting again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');

const lib = require('../../scripts/lib/placeholder-venue.js');
const { sanitizeVenueForWrite } = require('../../scripts/lib/venue-classification.js');
const { isHardcodedStringRhs } = require('../../scripts/lib/venue-write-guard-detector.js');
const census = require('../../scripts/audit-placeholder-venues.js');

test('sanitizeVenueForWrite("West End") returns the placeholder result (null)', () => {
  assert.equal(sanitizeVenueForWrite('West End'), null);
  assert.equal(sanitizeVenueForWrite('west end'), null);
  assert.equal(sanitizeVenueForWrite('  WEST END  '), null);
});

test('the S4-T7 markers are placeholders — case-insensitive, whole string after trim', () => {
  for (const v of ['West End', 'west end', 'Off-Broadway', 'OFF-BROADWAY', 'Various', 'various', ' Various ']) {
    const r = lib.isPlaceholderVenue(v);
    assert.equal(r.placeholder, true, `expected "${v}" to be a placeholder`);
    assert.equal(r.reason, 'unknown_marker', `expected "${v}" to be an unknown_marker`);
    assert.equal(sanitizeVenueForWrite(v), null, `expected sanitizeVenueForWrite("${v}") to fail closed`);
  }
});

test('"Adelphi Theatre" passes, and so do real houses that merely CONTAIN a marker', () => {
  assert.equal(sanitizeVenueForWrite('Adelphi Theatre'), 'Adelphi Theatre');
  // West End Theatre is a real Off-Broadway house on W 86th — whole-string
  // matching is the point, never substring.
  for (const v of ['West End Theatre', 'The West End Theatre', 'Off-Broadway Playhouse', 'Vaudeville Theatre']) {
    assert.equal(lib.isPlaceholderVenue(v).placeholder, false, `expected "${v}" to be accepted`);
    assert.equal(sanitizeVenueForWrite(v), v);
  }
});

test('the lint agrees with the write-time guard on every unknown marker', () => {
  // A hardcoded `venue: "West End"` literal is exactly the value class the
  // guard rejects, so the lint must refuse to call it "safe" too.
  for (const marker of lib.UNKNOWN_MARKERS) {
    assert.equal(sanitizeVenueForWrite(marker), null, `guard should reject "${marker}"`);
    assert.equal(isHardcodedStringRhs(JSON.stringify(marker)), false, `lint should flag the literal ${JSON.stringify(marker)}`);
  }
  assert.equal(isHardcodedStringRhs('"West End"'), false);
  assert.equal(isHardcodedStringRhs("'Off-Broadway'"), false);
  assert.equal(isHardcodedStringRhs('`Various`'), false);
  // …and still accepts a real hand-typed house.
  assert.equal(isHardcodedStringRhs('"Adelphi Theatre"'), true);
  assert.equal(isHardcodedStringRhs('"West End Theatre"'), true);
});

test('audit-placeholder-venues.js re-exports the lib objects themselves (no second copy)', () => {
  assert.equal(census.isPlaceholderVenue, lib.isPlaceholderVenue);
  assert.equal(census.UNKNOWN_MARKERS, lib.UNKNOWN_MARKERS);
  assert.equal(census.NEIGHBOURHOOD_BLOBS, lib.NEIGHBOURHOOD_BLOBS);
  assert.equal(census.JUNK_SUBSTRINGS, lib.JUNK_SUBSTRINGS);
});

// Source assertion: all three consumers import the lib and none defines its
// own marker set. This is the regression this whole task exists to prevent —
// venue-write-guard-detector.js carried a private UNKNOWN_MARKERS copy that
// silently diverged from the guard's.
test('the three consumers require() scripts/lib/placeholder-venue.js and carry no private marker set', () => {
  const consumers = [
    ['scripts/audit-placeholder-venues.js', /require\(['"]\.\/lib\/placeholder-venue['"]\)/],
    ['scripts/lib/venue-classification.js', /require\(['"]\.\/placeholder-venue['"]\)/],
    ['scripts/lib/venue-write-guard-detector.js', /require\(['"]\.\/placeholder-venue['"]\)/],
  ];
  for (const [rel, importRe] of consumers) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(importRe.test(src), `${rel} no longer imports scripts/lib/placeholder-venue.js`);
    assert.ok(
      !/const\s+UNKNOWN_MARKERS\s*=\s*new Set\(/.test(src),
      `${rel} defines its own UNKNOWN_MARKERS — the lint and the guard can drift again`
    );
    assert.ok(
      !/function isPlaceholderVenue\s*\(/.test(src),
      `${rel} defines its own isPlaceholderVenue — the lint and the guard can drift again`
    );
  }
  const libSrc = readFileSync(join(ROOT, 'scripts/lib/placeholder-venue.js'), 'utf8');
  assert.ok(/const\s+UNKNOWN_MARKERS\s*=\s*new Set\(/.test(libSrc), 'the lib is where UNKNOWN_MARKERS lives');
  assert.ok(/function isPlaceholderVenue\s*\(/.test(libSrc), 'the lib is where isPlaceholderVenue lives');
});
