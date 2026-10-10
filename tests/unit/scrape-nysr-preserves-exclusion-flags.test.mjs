// Task #816 — sibling of extract-dtli-preserves-exclusion-flags.test.mjs.
//
// scrape-nysr-reviews.js's saveReviewFile() looks up an existing file via
// findExistingReviewFile(), which deliberately skips wrongProduction/
// duplicateOf files — so a flagged file at the canonical path used to be
// silently clobbered by a raw write of the freshly-scraped NYSR post. It now
// routes through the shared writer (scripts/lib/review-file-writer.js's
// createOrMergeReviewFile, task #1687), whose own findExistingReviewFile call
// has the identical wrongProduction/duplicateOf skip, and whose "exact
// filename fallback" then re-reads the flagged file directly and merges via
// _mergeIntoExisting — which only fills FALSY fields, so wrongProduction,
// contentTier, and fullText (already truthy on the flagged file) are never
// overwritten. Same protection, different mechanism.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { saveReviewFile } = require('../../scripts/scrape-nysr-reviews.js');

const SHOW_ID = 'some-show-2009';
const CRITIC_SLUG = 'jane-critic';

function flaggedOnDisk() {
  return {
    showId: SHOW_ID,
    outletId: 'nysr',
    outlet: 'New York Stage Review',
    criticName: 'Jane Critic',
    url: 'https://nystagereview.com/some-show-review-old',
    publishDate: 'January 1, 2009',
    fullText: 'x'.repeat(4000),
    isFullReview: true,
    assignedScore: 70,
    contentTier: 'invalid',
    contentTierReason: 'Wrong production',
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review 1500d before this production opened',
  };
}

function freshFromNysrApi() {
  return {
    criticName: 'Jane Critic',
    url: 'https://nystagereview.com/some-show-review-refetched',
    publishDate: 'January 1, 2009',
    fullText: 'y'.repeat(3000),
    isFullReview: true,
    wordCount: 500,
    textQuality: 'full',
  };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nysr-flags-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('re-scraping NYSR does not resurrect a wrongProduction-flagged review', () => {
  withTempDir((dir) => {
    const showDir = path.join(dir, SHOW_ID);
    fs.mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, `nysr--${CRITIC_SLUG}.json`);
    fs.writeFileSync(filePath, JSON.stringify(flaggedOnDisk(), null, 2));

    const result = saveReviewFile(SHOW_ID, freshFromNysrApi(), dir);

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.wrongProduction, true, 'wrongProduction was dropped — the flagged review will re-enter reviews.json');
    assert.equal(after.contentTier, 'invalid', 'contentTier was downgraded away from its excluded state');
    assert.equal(after.fullText, flaggedOnDisk().fullText, 'scored fullText was lost');
    assert.equal(after.url, flaggedOnDisk().url, "the flagged file's own url must survive");
    // The shared writer's exact-filename fallback (task #1687) does find this
    // file — unlike the old findExistingReviewFile-only lookup — and legitimately
    // appends 'nysr-api' to its sources array, so the action is 'updated' rather
    // than the old code's 'new'. That's a harmless label/metadata difference;
    // the assertions above are what actually prove the flag survived.
    assert.equal(result, 'updated');
  });
});

test('a brand-new NYSR post still gets written', () => {
  withTempDir((dir) => {
    const result = saveReviewFile(SHOW_ID, freshFromNysrApi(), dir);
    assert.equal(result, 'new');
    const after = JSON.parse(fs.readFileSync(path.join(dir, SHOW_ID, `nysr--${CRITIC_SLUG}.json`), 'utf-8'));
    assert.equal(after.fullText, freshFromNysrApi().fullText);
  });
});
