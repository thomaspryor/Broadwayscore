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
