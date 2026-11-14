/**
 * Unit tests for scripts/lib/backfill-outlet-yield.js (BRO-6490).
 * Run: node --test scripts/lib/backfill-outlet-yield.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const y = require('./backfill-outlet-yield.js');

const cats = { 'a-we': 'west-end', 'b-owe': 'off-west-end', 'c-bw': 'broadway', 'd-tour': 'tour' };
const pool = (id) => y.marketPoolForCategory(cats[id]);
const reviews = [
  { showId: 'a-we', outletId: 'Guardian' }, { showId: 'b-owe', outletId: 'guardian' },
  { showId: 'a-we', outletId: 'guardian' }, { showId: 'a-we', outletId: 'metro' },
  { showId: 'c-bw', outletId: 'nytimes' }, { showId: 'd-tour', outletId: 'metro' },
  { showId: 'a-we', outletId: null },
];
const counts = y.buildOutletPoolCounts(reviews, pool);

test('bulk backfill purposes are recognised, targeted runs are not', () => {
  for (const p of ['historical-backfill', 'bro-6453-we-historical']) assert.equal(y.isBulkBackfillPurpose(p), true, p);
  for (const p of ['', undefined, 'press-night:x:2026-01-01', 'close-coverage-gaps']) assert.equal(y.isBulkBackfillPurpose(p), false, String(p));
});

test('threshold: default 3, 0 allowed, junk falls back', () => {
  assert.equal(y.resolveMinReviews({}), 3);
  assert.equal(y.resolveMinReviews({ SERP_BACKFILL_MIN_OUTLET_REVIEWS: '0' }), 0);
  assert.equal(y.resolveMinReviews({ SERP_BACKFILL_MIN_OUTLET_REVIEWS: '5' }), 5);
  assert.equal(y.resolveMinReviews({ SERP_BACKFILL_MIN_OUTLET_REVIEWS: '-1' }), 3);
  assert.equal(y.resolveMinReviews({ SERP_BACKFILL_MIN_OUTLET_REVIEWS: 'x' }), 3);
});

test('counts pool west-end with off-west-end, ignore tour and null ids, lowercase ids', () => {
  assert.equal(counts.get('london').get('guardian'), 3);
  assert.equal(counts.get('london').get('metro'), 1);
  assert.equal(counts.get('nyc').get('nytimes'), 1);
  assert.equal(counts.get('nyc').has('metro'), false);
});

test('skips an outlet under the threshold, keeps one at it (mixed-case id)', () => {
  assert.deepEqual(y.backfillOutletDecision({ outletId: 'METRO', pool: 'london', counts, minReviews: 3 }), { skip: true, count: 1, minReviews: 3 });
  assert.equal(y.backfillOutletDecision({ outletId: 'Guardian', pool: 'london', counts, minReviews: 3 }).skip, false);
  assert.equal(y.backfillOutletDecision({ outletId: 'never-seen', pool: 'london', counts, minReviews: 3 }).skip, true);
});

test('fails open: no counts, unknown pool, empty pool, threshold 0', () => {
  for (const args of [
    { counts: null, pool: 'london', minReviews: 3 },
    { counts, pool: null, minReviews: 3 },
    { counts: new Map([['london', new Map()]]), pool: 'london', minReviews: 3 },
    { counts, pool: 'london', minReviews: 0 },
  ]) assert.equal(y.backfillOutletDecision({ outletId: 'never-seen', ...args }).skip, false);
});

test('tour and regional shows have no pool, so are never pruned', () => {
  assert.equal(y.marketPoolForCategory('tour'), null);
  assert.equal(y.marketPoolForCategory('regional'), null);
  assert.equal(y.marketPoolForCategory(undefined), null);
  assert.equal(y.marketPoolForCategory('off-west-end'), 'london');
});

test('loadOutletPoolCounts: missing or empty file disables pruning', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'byield-'));
  assert.equal(y.loadOutletPoolCounts(path.join(tmp, 'nope.json'), () => 'west-end'), null);
  fs.writeFileSync(path.join(tmp, 'empty.json'), JSON.stringify({ reviews: [] }));
  assert.equal(y.loadOutletPoolCounts(path.join(tmp, 'empty.json'), () => 'west-end'), null);
  fs.writeFileSync(path.join(tmp, 'ok.json'), JSON.stringify({ reviews }));
  assert.equal(y.loadOutletPoolCounts(path.join(tmp, 'ok.json'), (id) => cats[id]).get('london').get('guardian'), 3);
});
