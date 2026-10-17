/**
 * BRO-5064: safeWriteReview discards a relayed (Show Score) originalScore on a
 * no-critic-rating outlet, so no writer can land the hard violation that
 * check-score-integrity.js fails on. The outlet's own page rating and a
 * human-verified rating survive.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { safeWriteReview } = require('../../scripts/lib/review-write-guard');
const { LONDON_THEATRE_PAGE_SOURCE, publishesNoCriticRating } = require('../../scripts/lib/score-extractors');
const { VERIFIED_SOURCE } = require('../../scripts/lib/verified-original-score');

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwg-norating-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function write(rec) {
  const dir = path.join(tmpDir, 'downstate-west-end-2019');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${rec.outletId}--mark-shenton.json`);
  const res = safeWriteReview(fp, { showId: 'downstate-west-end-2019', criticName: 'Mark Shenton', url: 'https://www.londontheatre.co.uk/reviews/review-downstate', ...rec });
  return { res, data: JSON.parse(fs.readFileSync(fp, 'utf8')) };
}

test('Show Score relayed score on london-theatre is discarded at write', () => {
  const { res, data } = write({ outletId: 'london-theatre', originalScore: 80, source: 'show-score-playwright', scoreSource: 'anchored-v6' });
  assert.equal(res.wrote, true);
  assert.equal(data.originalScore, null);
  assert.equal(data.originalScoreCleared, true);
  assert.equal(data.previousOriginalScore, 80);
  assert.equal(publishesNoCriticRating(data.outletId, data) && data.originalScore != null, false);
});

test('rating read from the londontheatre.co.uk page is kept', () => {
  const { data } = write({ outletId: 'london-theatre', originalScore: '4/5 stars', originalScoreSource: LONDON_THEATRE_PAGE_SOURCE, scoreSource: LONDON_THEATRE_PAGE_SOURCE });
  assert.equal(data.originalScore, '4/5 stars');
  assert.equal(data.originalScoreCleared, undefined);
});

test('human-verified rating is kept', () => {
  const { data } = write({ outletId: 'london-theatre', originalScore: '4/5 stars', originalScoreSource: VERIFIED_SOURCE });
  assert.equal(data.originalScore, '4/5 stars');
});

test('star-publishing outlet keeps its score', () => {
  const { data } = write({ outletId: 'guardian', originalScore: '4/5', source: 'show-score-playwright' });
  assert.equal(data.originalScore, '4/5');
});
