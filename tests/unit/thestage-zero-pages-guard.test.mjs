// BRO-5288: scrape-thestage-roundups.js failed every --extract-only run (it never
// fetches pages, so "zero pages checked" was always true) and every full run whose
// roundups were all already archived ([CACHED] did not count). Requires the real
// decision (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { zeroDataFailure } = require('../../scripts/scrape-thestage-roundups.js');

const base = { pagesChecked: 0, cached: 0, reviewsExtracted: 0, targetShows: null, extractOnly: false };

test('a full run that fetched nothing and found nothing cached fails', () => {
  assert.match(zeroDataFailure(base), /ZERO roundup pages/);
});

test('a full run whose roundups were all cached is not an outage', () => {
  assert.equal(zeroDataFailure({ ...base, cached: 12 }), null);
  assert.equal(zeroDataFailure({ ...base, pagesChecked: 3 }), null);
});

test('extract-only fails only when no review came out of the archives', () => {
  assert.equal(zeroDataFailure({ ...base, extractOnly: true, reviewsExtracted: 316 }), null);
  assert.match(zeroDataFailure({ ...base, extractOnly: true }), /ZERO reviews extracted/);
});

test('targeted runs are exempt', () => {
  assert.equal(zeroDataFailure({ ...base, targetShows: ['x'] }), null);
  assert.equal(zeroDataFailure({ ...base, targetShows: ['x'], extractOnly: true }), null);
});
