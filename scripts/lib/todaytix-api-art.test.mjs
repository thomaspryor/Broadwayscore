// BRO-5080: the TodayTix catalogue lists productions on sale now, so a
// long-closed row's title match is another production's art (Hairspray 2002
// got the 2021 London Coliseum poster).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { todaytixApiArtEligible } = require('./image-fetch-selection.js');
const NOW = Date.parse('2026-10-12');

test('a long-closed row never takes catalogue art', () => {
  assert.equal(todaytixApiArtEligible({ status: 'closed', closingDate: '2009-01-04' }, NOW), false);
  assert.equal(todaytixApiArtEligible({ status: 'closed', closingDate: null }, NOW), false);
});

test('running, upcoming and recently closed rows may', () => {
  assert.equal(todaytixApiArtEligible({ status: 'open' }, NOW), true);
  assert.equal(todaytixApiArtEligible({ status: 'previews' }, NOW), true);
  assert.equal(todaytixApiArtEligible({ status: 'closed', closingDate: '2026-09-01' }, NOW), true);
});

// BRO-6703: the catalogue is New York and London only, so a regional row's title
// match (Hope Mill's Little Shop of Horrors -> the Westside Theatre listing) is
// another production's art.
test('a regional row never takes catalogue art by title, but may by its own id', () => {
  assert.equal(todaytixApiArtEligible({ status: 'open', category: 'regional' }, NOW), false);
  assert.equal(todaytixApiArtEligible({ status: 'open', category: 'musical', market: 'regional' }, NOW), false);
  assert.equal(todaytixApiArtEligible({ status: 'open', category: 'regional', todaytixId: 123 }, NOW), true);
  assert.equal(todaytixApiArtEligible({ status: 'open', category: 'west-end' }, NOW), true);
  assert.equal(todaytixApiArtEligible({ status: 'open', category: 'off-broadway' }, NOW), true);
});
