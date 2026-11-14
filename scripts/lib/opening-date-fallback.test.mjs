import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { previewsFallbackOpening } = require('./opening-date-fallback.js');
const { isUnconfirmedDateSource } = require('./date-source-confidence.js');

const today = '2026-09-27';
const ob = (over) => ({ category: 'off-broadway', status: 'previews', openingDate: null, previewsStartDate: '2026-09-11', ...over });

test('OB show 16 days into previews with no opening date → first-performance fallback', () => {
  assert.deepEqual(previewsFallbackOpening(ob({}), today), { openingDate: '2026-09-11', openingDateSource: 'previews-fallback' });
});
test('within the 7-day grace window → no fallback (give Playbill a chance)', () => {
  assert.equal(previewsFallbackOpening(ob({ previewsStartDate: '2026-09-22' }), today), null);
});
test('existing opening date is never touched', () => {
  assert.equal(previewsFallbackOpening(ob({ openingDate: '2026-09-15' }), today), null);
});
test('Broadway / West End never get a guessed date (opening-night broadcasts select them)', () => {
  assert.equal(previewsFallbackOpening(ob({ category: 'broadway' }), today), null);
  assert.equal(previewsFallbackOpening(ob({ category: 'west-end' }), today), null);
});
test('off-west-end is covered', () => {
  assert.equal(previewsFallbackOpening(ob({ category: 'off-west-end' }), today).openingDate, '2026-09-11');
});
test('attractions older than 120 days, closed/upcoming shows, missing/garbage preview dates → no fallback', () => {
  assert.equal(previewsFallbackOpening(ob({ previewsStartDate: '2024-01-06' }), today), null);
  assert.equal(previewsFallbackOpening(ob({ status: 'closed' }), today), null);
  assert.equal(previewsFallbackOpening(ob({ status: 'upcoming' }), today), null);
  assert.equal(previewsFallbackOpening(ob({ previewsStartDate: null }), today), null);
  assert.equal(previewsFallbackOpening(ob({ previewsStartDate: 'TBA' }), today), null);
});
test('the fallback source is unconfirmed, so date enrichers overwrite it', () => {
  assert.equal(isUnconfirmedDateSource({ category: 'off-broadway', openingDateSource: 'previews-fallback' }), true);
  assert.equal(isUnconfirmedDateSource({ category: 'off-west-end', openingDateSource: 'previews-fallback' }), true);
});
