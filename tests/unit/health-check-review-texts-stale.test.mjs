// BRO-6697: a stale plain review-texts copy must make review-texts rows skip
// (so `check-health-row-absent --live` says "cannot verify"), never pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reviewTextsSkipReason } = require('../../scripts/health-check.js');

function dataDir(showIds, presentIds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stale-'));
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ reviews: showIds.map((showId) => ({ showId })) }));
  if (presentIds) {
    fs.mkdirSync(path.join(dir, 'review-texts'));
    for (const id of presentIds) fs.mkdirSync(path.join(dir, 'review-texts', id));
  }
  return dir;
}
const ids = Array.from({ length: 40 }, (_, i) => `show-${i}`);

test('no checkout: skip as not checked out', () => {
  assert.equal(reviewTextsSkipReason(dataDir(ids, null)), 'review-texts not checked out');
});

test('stale copy (most reviewed shows missing): skip as stale', () => {
  assert.match(reviewTextsSkipReason(dataDir(ids, ids.slice(0, 15))), /^review-texts checkout stale: 25 of 40 /);
});

test('fresh clone with a stray missing folder: usable', () => {
  assert.equal(reviewTextsSkipReason(dataDir(ids, ids.slice(1))), null);
});

test('empty reviews.json gives nothing to compare: usable', () => {
  assert.equal(reviewTextsSkipReason(dataDir([], [])), null);
});
