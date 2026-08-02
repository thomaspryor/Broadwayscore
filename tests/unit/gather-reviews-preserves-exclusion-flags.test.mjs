// Task #816 — sibling of extract-dtli-preserves-exclusion-flags.test.mjs.
//
// gather-reviews.js's BWW/LBO stub-creation blocks call findExistingReviewFile()
// — which deliberately skips wrongProduction/duplicateOf files — before
// deciding a stub is "new." A flagged file living at the exact canonical path
// (e.g. under a legacy outlet-id variant, missed by the sibling
// fs.existsSync guard) used to be silently clobbered by the raw stub write.
// saveAggregatorStub() now routes through safeWriteReview + preserveFlaggedFields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { saveAggregatorStub } = require('../../scripts/gather-reviews.js');

function flaggedOnDisk() {
  return {
    showId: 'some-show-2026',
    outletId: 'broadwayworld',
    outlet: 'BroadwayWorld',
    criticName: 'Some Critic',
    url: 'https://broadwayworld.com/article/some-show-review',
    publishDate: '2024-03-01',
    fullText: 'x'.repeat(2000),
    assignedScore: 60,
    contentTier: 'invalid',
    contentTierReason: 'Wrong production',
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review predates this production',
  };
}

function duplicateOnDisk() {
  return {
    showId: 'some-show-2026',
    outletId: 'broadwayworld',
    outlet: 'BroadwayWorld',
    criticName: 'Some Critic',
    url: 'https://broadwayworld.com/article/some-show-review',
    fullText: 'x'.repeat(2000),
    assignedScore: 60,
    contentTier: 'complete',
    duplicateOf: 'broadwayworld--another-critic.json',
  };
}

function freshBwwStub() {
  return {
    showId: 'some-show-2026',
    outletId: 'broadwayworld',
    outlet: 'BroadwayWorld',
    criticName: 'Some Critic',
    url: null,
    publishDate: null,
    fullText: null,
    isFullReview: false,
    bwwExcerpt: 'A fresh BWW excerpt.',
    bwwRoundupUrl: 'https://broadwayworld.com/roundup',
    bwwThumb: null,
    showScoreExcerpt: null,
    contentTier: 'excerpt',
    contentTierReason: 'Only aggregator excerpts available',
    source: 'bww-roundup',
    sources: ['bww-roundup'],
  };
}

function withTempFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-reviews-stub-flags-'));
  const showDir = path.join(dir, 'some-show-2026');
  fs.mkdirSync(showDir, { recursive: true });
  try {
    return fn(path.join(showDir, 'broadwayworld--some-critic.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh BWW/LBO stub write does not clobber a wrongProduction-flagged file at the same path', () => {
  withTempFile((filePath) => {
    fs.writeFileSync(filePath, JSON.stringify(flaggedOnDisk(), null, 2));

    saveAggregatorStub(filePath, freshBwwStub());

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.wrongProduction, true, 'wrongProduction was dropped — the flagged review will re-enter reviews.json');
    assert.equal(after.contentTier, 'invalid', 'contentTier was downgraded away from its excluded state');
    assert.equal(after.fullText, flaggedOnDisk().fullText, 'scored fullText was lost');
    assert.equal(after.url, flaggedOnDisk().url, 'url was overwritten with the null stub value — Date guard can no longer re-derive itself');
    assert.equal(after.publishDate, flaggedOnDisk().publishDate, 'publishDate was overwritten with the null stub value');
  });
});

test('a fresh BWW/LBO stub write does not clobber a duplicateOf-flagged file at the same path', () => {
  withTempFile((filePath) => {
    fs.writeFileSync(filePath, JSON.stringify(duplicateOnDisk(), null, 2));
    // safeWriteReview auto-clears a *dangling* duplicateOf (sibling deleted) —
    // the sibling must exist for this test to exercise the preservation path
    // rather than that unrelated self-heal.
    const siblingPath = path.join(path.dirname(filePath), duplicateOnDisk().duplicateOf);
    fs.writeFileSync(siblingPath, JSON.stringify({ ...duplicateOnDisk(), duplicateOf: undefined, url: duplicateOnDisk().url }, null, 2));

    saveAggregatorStub(filePath, freshBwwStub());

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.duplicateOf, duplicateOnDisk().duplicateOf, 'duplicateOf was dropped — the duplicate would re-enter reviews.json under its own outletId');
    assert.equal(after.contentTier, 'complete', 'contentTier was downgraded even though findExistingReviewFile() deliberately skips duplicateOf files');
    assert.equal(after.fullText, duplicateOnDisk().fullText, 'scored fullText was lost');
    assert.equal(after.url, duplicateOnDisk().url, 'url was overwritten with the null stub value');
  });
});

test('a brand-new stub still gets written when nothing exists at the path', () => {
  withTempFile((filePath) => {
    saveAggregatorStub(filePath, freshBwwStub());
    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.contentTier, 'excerpt');
    assert.equal(after.bwwExcerpt, 'A fresh BWW excerpt.');
  });
});
