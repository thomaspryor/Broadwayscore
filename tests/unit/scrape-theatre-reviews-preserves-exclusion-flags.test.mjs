// Task #816 — sibling of extract-dtli-preserves-exclusion-flags.test.mjs.
//
// scrape-theatre-reviews.js's writeReviewFiles() looks up an existing file
// via findExistingReviewFile(), which deliberately skips wrongProduction/
// duplicateOf files — so `existingMatch` came back null and `data` started
// from {}, meaning a raw write clobbered the flagged file with a near-empty
// object. It now routes through safeWriteReview + preserveFlaggedFields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeReviewFiles } = require('../../scripts/scrape-theatre-reviews.js');

const SHOW_ID = 'some-we-show-2026';

function flaggedOnDisk() {
  return {
    showId: SHOW_ID,
    outletId: 'the-guardian',
    outlet: 'The Guardian',
    criticName: 'Some Critic',
    url: 'https://theguardian.com/stage/some-we-show-review',
    fullText: 'x'.repeat(3000),
    assignedScore: 80,
    contentTier: 'invalid',
    contentTierReason: 'Wrong production',
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review predates this production',
  };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theatre-reviews-flags-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('re-scraping theatre.reviews does not clobber a wrongProduction-flagged review', () => {
  withTempDir((dir) => {
    const showDir = path.join(dir, SHOW_ID);
    fs.mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, 'the-guardian--some-critic.json');
    fs.writeFileSync(filePath, JSON.stringify(flaggedOnDisk(), null, 2));

    writeReviewFiles(
      [{ outlet: 'The Guardian', outletId: 'the-guardian', critic: 'Some Critic', stars: 3, starsOutOf: 5, excerpt: 'A fresh excerpt.', url: null }],
      SHOW_ID,
      dir,
    );

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.wrongProduction, true, 'wrongProduction was dropped — the flagged review will re-enter reviews.json');
    assert.equal(after.contentTier, 'invalid', 'contentTier was downgraded away from its excluded state');
    assert.equal(after.fullText, flaggedOnDisk().fullText, 'scored fullText was lost');
    assert.equal(after.url, flaggedOnDisk().url, "the flagged file's own url must survive");
  });
});

test('a brand-new theatre.reviews file still gets created', () => {
  withTempDir((dir) => {
    writeReviewFiles(
      [{ outlet: 'The Stage', outletId: 'the-stage', critic: 'New Critic', stars: 4, starsOutOf: 5, excerpt: 'Excerpt.', url: null }],
      SHOW_ID,
      dir,
    );
    const filePath = path.join(dir, SHOW_ID, 'thestage--new-critic.json');
    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.theatreReviewsStars, '4/5');
  });
});
