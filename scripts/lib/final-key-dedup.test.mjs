import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { dedupeByReviewKey } = require('./final-key-dedup.js');
const { getReviewKey } = require('./review-list-key.js');

const row = { showId: 's', outletId: 'off-off-online', criticName: 'Marc Miller', url: 'https://x.test/a', publishDate: '2026-10-06' };

test('collapses byte-identical rows (BRO-4809 shape)', () => {
  const { reviews, removed } = dedupeByReviewKey([row, { ...row }]);
  assert.equal(reviews.length, 1);
  assert.equal(removed, 1);
});

test('keeps distinct critics, URLs and shows', () => {
  const input = [row, { ...row, criticName: 'Other' }, { ...row, url: 'https://x.test/b' }, { ...row, showId: 't' }];
  assert.equal(dedupeByReviewKey(input).removed, 0);
});

test('prefers a manual/human copy over a pipeline copy, regardless of order', () => {
  const manual = { ...row, manualEntry: true };
  assert.equal(dedupeByReviewKey([row, manual]).reviews[0].manualEntry, true);
  assert.equal(dedupeByReviewKey([manual, row]).reviews[0].manualEntry, true);
});

test('output has no per-show getReviewKey collisions', () => {
  const { reviews } = dedupeByReviewKey([row, { ...row }, { ...row, criticName: null }, { ...row, criticName: null }]);
  const keys = reviews.map((r) => `${r.showId}|${getReviewKey(r)}`);
  assert.equal(new Set(keys).size, keys.length);
});
