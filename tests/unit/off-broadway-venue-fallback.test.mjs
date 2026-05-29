/**
 * Regression test for the Off-Broadway venue-name fallback used by TodayTix
 * discovery (scripts/discover-new-shows.js).
 *
 * Motivation: TodayTix mis-tags some Off-Broadway shows with no "Off Broadway"
 * subcategory. Broken Snow (Theatre 71) slipped through the subcat-only filter
 * and needed a manual add (discoverySource: manual-user-request, 2026-05-27).
 * isKnownOffBroadwayVenue() rescues these by matching the venue name against
 * theatres we already classify as Off-Broadway (data/off-broadway-venues.json).
 *
 * Run: node --test tests/unit/off-broadway-venue-fallback.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isKnownOffBroadwayVenue,
  OFF_BROADWAY_VENUES,
} = require('../../scripts/lib/venue-classification.js');

test('Theatre 71 (the show that slipped through) is now a known OB venue', () => {
  assert.equal(isKnownOffBroadwayVenue('Theatre 71'), true);
});

test('matches a sample of canonical OB venues by full name', () => {
  for (const name of ['Lucille Lortel Theatre', 'Playwrights Horizons', 'The Public Theater', 'Vineyard Theatre']) {
    assert.equal(isKnownOffBroadwayVenue(name), true, `${name} should match`);
  }
});

test('match is case- and trailing-"Theatre/Theater"-insensitive', () => {
  assert.equal(isKnownOffBroadwayVenue('CHERRY LANE THEATER'), true);
  assert.equal(isKnownOffBroadwayVenue('cherry lane theatre'), true);
});

test('strips trailing parenthetical before matching', () => {
  // shows.json holds "Perelman Performing Arts Center (PAC NYC)"
  assert.equal(isKnownOffBroadwayVenue('Perelman Performing Arts Center (PAC NYC)'), true);
});

test('accepts a TodayTix-shape { name } object', () => {
  assert.equal(isKnownOffBroadwayVenue({ name: 'Theatre 71' }), true);
});

test('does not match a Broadway house, TBA, or empty input', () => {
  assert.equal(isKnownOffBroadwayVenue('Majestic Theatre'), false);
  assert.equal(isKnownOffBroadwayVenue('TBA'), false);
  assert.equal(isKnownOffBroadwayVenue(''), false);
  assert.equal(isKnownOffBroadwayVenue(null), false);
  assert.equal(isKnownOffBroadwayVenue(undefined), false);
  assert.equal(isKnownOffBroadwayVenue({}), false);
});

test('venue list is non-empty and all entries are normalized', () => {
  assert.ok(OFF_BROADWAY_VENUES.size > 50, 'expected a substantial OB venue list');
  for (const v of OFF_BROADWAY_VENUES) {
    assert.equal(v, v.toLowerCase(), `entry "${v}" must be lowercase`);
    assert.ok(!/ theatre$| theater$/.test(v), `entry "${v}" must have trailing Theatre/Theater stripped`);
  }
});
