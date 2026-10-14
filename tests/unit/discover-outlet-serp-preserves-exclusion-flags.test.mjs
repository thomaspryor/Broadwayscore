// Task #816 — sibling of extract-dtli-preserves-exclusion-flags.test.mjs.
//
// discover-outlet-reviews-serp.js's findExistingReviewFile() lookup
// deliberately skips wrongProduction/duplicateOf files, so a flagged file can
// already live at the exact canonical path this script is about to write —
// before the fix, a raw writeFileSync clobbered it with a clean 9-field stub.
// saveDiscoveredReviewStub() now routes through safeWriteReview +
// preserveFlaggedFields instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { saveDiscoveredReviewStub } = require('../../scripts/discover-outlet-reviews-serp.js');

function flaggedOnDisk() {
  return {
    showId: 'some-show-2026',
    outletId: 'slantmagazine',
    outlet: 'Slant Magazine',
    criticName: 'Dan Rubins',
    url: 'https://slantmagazine.com/theater/some-show-review/',
    fullText: 'x'.repeat(3000),
    assignedScore: 65,
    contentTier: 'invalid',
    contentTierReason: 'Wrong production',
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review published outside production window',
  };
}

function withTempFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-discover-flags-'));
  const showDir = path.join(dir, 'some-show-2026');
  fs.mkdirSync(showDir, { recursive: true });
  try {
    return fn(path.join(showDir, 'slantmagazine--dan-rubins.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh SERP discovery does not clobber a wrongProduction-flagged file at the same canonical path', () => {
  withTempFile((filePath) => {
    fs.writeFileSync(filePath, JSON.stringify(flaggedOnDisk(), null, 2));

    const freshStub = {
      showId: 'some-show-2026',
      outletId: 'slantmagazine',
      outlet: 'Slant Magazine',
      criticName: 'Dan Rubins',
      url: 'https://slantmagazine.com/theater/some-show-review-different-slug/',
      source: 'outlet-serp-discovery',
      sources: ['outlet-serp-discovery'],
      contentTier: 'stub',
      createdAt: '2026-08-02T00:00:00.000Z',
    };

    saveDiscoveredReviewStub(filePath, freshStub);

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.wrongProduction, true, 'wrongProduction was dropped — the flagged review would re-enter reviews.json');
    assert.equal(after.contentTier, 'invalid', 'contentTier was downgraded away from its excluded state');
    assert.equal(after.fullText, flaggedOnDisk().fullText, 'scored fullText was lost');
    assert.equal(after.url, flaggedOnDisk().url, "the flagged file's own url must win over the fresh SERP hit");
  });
});

test('a brand-new stub still gets written when nothing exists at the path', () => {
  withTempFile((filePath) => {
    const stub = {
      showId: 'another-show-2026',
      outletId: 'stagebuddy',
      outlet: 'Stage Buddy',
      criticName: 'Unknown',
      url: 'https://stagebuddy.com/theater/theater-review/another-show',
      source: 'outlet-serp-discovery',
      sources: ['outlet-serp-discovery'],
      contentTier: 'stub',
      createdAt: '2026-08-02T00:00:00.000Z',
    };

    saveDiscoveredReviewStub(filePath, stub);

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.outletId, 'stagebuddy');
    assert.equal(after.contentTier, 'stub');
  });
});
