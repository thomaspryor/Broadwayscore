/**
 * Tests for scripts/lib/retired-show-reviews.js (BRO-7192): manual review rows of a retired
 * show (gun-and-powder-regional-2020) must not survive the push merge.
 *
 * Run: node --test scripts/lib/retired-show-reviews.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dropRetiredShowReviews } = require('./retired-show-reviews.js');

const row = (showId, manualEntry = true) => ({ showId, outletId: 'x', url: `https://x/${showId}`, manualEntry });

test('drops rows of a retired, no-longer-live show; keeps live shows', () => {
  const { kept, dropped } = dropRetiredShowReviews(
    [row('gun-and-powder-regional-2020'), row('gun-and-powder-regional-2020'), row('wanted-2022'), row('gun-and-powder-paper-mill-regional-2024')],
    ['gun-and-powder-regional-2020'],
    ['wanted-2022', 'gun-and-powder-paper-mill-regional-2024'],
  );
  assert.equal(dropped.length, 2);
  assert.deepEqual(kept.map((r) => r.showId), ['wanted-2022', 'gun-and-powder-paper-mill-regional-2024']);
});

test('a re-minted id (retired but live again) keeps its rows', () => {
  const { kept, dropped } = dropRetiredShowReviews([row('reborn-2026')], ['reborn-2026'], ['reborn-2026', 'other']);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
});

test('no evidence, no filtering: empty shows list or empty registry drops nothing', () => {
  const rows = [row('gone-2020')];
  assert.equal(dropRetiredShowReviews(rows, ['gone-2020'], []).dropped.length, 0);
  assert.equal(dropRetiredShowReviews(rows, [], ['live']).dropped.length, 0);
});

test('a show that is neither retired nor live is left for the orphan check to report', () => {
  assert.equal(dropRetiredShowReviews([row('typo-2026')], ['gone-2020'], ['live']).dropped.length, 0);
});
