// Task #816 — sibling of extract-dtli-preserves-exclusion-flags.test.mjs.
//
// extract-stagedoor-reviews.js's saveReview() merges into an existing file
// found via findExistingReviewFile() — but that lookup deliberately skips
// wrongProduction/duplicateOf files, so a flagged file at the canonical path
// used to be silently clobbered by a raw writeFileSync of the fresh
// Stagedoor-only fields. It now routes through safeWriteReview +
// preserveFlaggedFields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { saveReview } = require('../../scripts/extract-stagedoor-reviews.js');

const SHOW_ID = 'some-we-show-2026';

function flaggedOnDisk() {
  return {
    showId: SHOW_ID,
    outletId: 'the-stage',
    outlet: 'The Stage',
    criticName: null,
    url: 'https://www.thestage.co.uk/reviews/some-we-show-review',
    fullText: 'x'.repeat(2500),
    assignedScore: 55,
    contentTier: 'invalid',
    contentTierReason: 'Wrong production',
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review predates this production',
  };
}

function freshFromStagedoor() {
  return {
    showId: SHOW_ID,
    outletId: 'the-stage',
    outlet: 'The Stage',
    criticName: null,
    url: null,
    stagedoorUrl: 'https://stagedoor.com/reviews/some-we-show',
    publishDate: null,
    stagedoorExcerpt: 'A fresh Stagedoor excerpt.',
    aggregatorStars: '4/5 stars',
    scoreSource: 'stagedoor-star-rating',
    fullText: null,
    isFullReview: false,
    assignedScore: null,
    source: 'stagedoor',
  };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagedoor-flags-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('re-extracting Stagedoor does not resurrect a wrongProduction-flagged review', () => {
  withTempDir((dir) => {
    const showDir = path.join(dir, SHOW_ID);
    fs.mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, 'the-stage--unknown.json');
    fs.writeFileSync(filePath, JSON.stringify(flaggedOnDisk(), null, 2));

    saveReview(freshFromStagedoor(), dir);

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.wrongProduction, true, 'wrongProduction was dropped — the flagged review will re-enter reviews.json');
    assert.equal(after.contentTier, 'invalid', 'contentTier was downgraded away from its excluded state');
    assert.equal(after.fullText, flaggedOnDisk().fullText, 'scored fullText was lost');
    assert.equal(after.url, flaggedOnDisk().url, "the flagged file's own url must survive");
  });
});

test('a brand-new Stagedoor review still gets written', () => {
  withTempDir((dir) => {
    const written = saveReview(freshFromStagedoor(), dir);
    assert.ok(written, 'saveReview should return the written path');
    const after = JSON.parse(fs.readFileSync(written, 'utf-8'));
    assert.equal(after.outletId, 'the-stage');
    assert.equal(after.aggregatorStars, '4/5 stars');
  });
});
