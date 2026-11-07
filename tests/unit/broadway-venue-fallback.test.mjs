/**
 * Regression test for the Broadway-house venue-name fallback used by TodayTix
 * discovery (scripts/discover-new-shows.js).
 *
 * Motivation: TodayTix mis-tags some Broadway shows with no "Broadway"
 * subcategory — the same single-point failure that dropped Off-Broadway shows
 * (Broken Snow). Live evidence (2026-05-29): "Other Desert Cities" @ Hudson
 * Theatre (category "Plays", no Broadway subcat) was being dropped from
 * discovery. isBroadwayHouse() rescues these by matching the venue against the
 * 41 official Broadway houses (scripts/lib/broadway-theaters.js).
 *
 * Run: node --test tests/unit/broadway-venue-fallback.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isBroadwayHouse, bwayFallbackFlags } = require('../../scripts/discover-new-shows.js');

test('Hudson Theatre (the live miss) is recognized as a Broadway house', () => {
  assert.equal(isBroadwayHouse('Hudson Theatre'), true);
  assert.equal(isBroadwayHouse({ name: 'Hudson Theatre' }), true);
});

test('matches a sample of official Broadway houses', () => {
  for (const name of ['Majestic Theatre', 'Shubert Theatre', 'Gershwin Theatre', 'Booth Theatre']) {
    assert.equal(isBroadwayHouse(name), true, `${name} should match`);
  }
});

test('does not match Off-Broadway houses, TBA, or empty input', () => {
  assert.equal(isBroadwayHouse('Theatre 71'), false);
  assert.equal(isBroadwayHouse('Lucille Lortel Theatre'), false);
  assert.equal(isBroadwayHouse('TBA'), false);
  assert.equal(isBroadwayHouse(''), false);
  assert.equal(isBroadwayHouse(null), false);
  assert.equal(isBroadwayHouse(undefined), false);
  assert.equal(isBroadwayHouse({}), false);
});

// bwayFallbackFlags: venue-rescued Broadway shows must be marked provisional so
// validate-show-venue.js cross-checks them against IBDB/Playbill (CLAUDE.md §3).
test('venue-fallback Broadway show (no Broadway subcat) is flagged provisional', () => {
  const flags = bwayFallbackFlags({ subcategories: [], venue: { name: 'Hudson Theatre' } });
  assert.equal(flags.provisional, true);
  assert.equal(flags.discoverySource, 'todaytix-venue-fallback');
});

test('subcat-tagged Broadway show gets no extra flags (TodayTix tag is authoritative)', () => {
  assert.deepEqual(bwayFallbackFlags({ subcategories: [{ name: 'Broadway' }], venue: { name: 'Hudson Theatre' } }), {});
});

test('bwayFallbackFlags handles a show with no subcategories array', () => {
  assert.deepEqual(bwayFallbackFlags({ venue: { name: 'Hudson Theatre' } }), { provisional: true, discoverySource: 'todaytix-venue-fallback' });
});
