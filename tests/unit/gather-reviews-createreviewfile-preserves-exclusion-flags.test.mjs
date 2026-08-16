// Task #816 P1 follow-up (adversarial-review finding).
//
// createReviewFile()'s STALE-FLAG COLLISION GUARD only blocks a raw write
// when the incoming URL differs from the flagged file's URL — a same-URL
// re-ingestion, or one with no URL at all (the guard is skipped entirely
// when reviewData.url is falsy), reaches the raw fs.writeFileSync untouched
// and clobbers wrongProduction/wrongShow/duplicateOf plus the scored fields
// alongside it. This is gather-reviews.js's highest-traffic write site — the
// two BWW/LBO stub sites fixed earlier in #816 are gated by an outer
// fs.existsSync(filePath) check that makes them unreachable for this exact
// clobber shape. createReviewFile() now routes through safeWriteReview +
// preserveFlaggedFields like the rest of the #816 fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReviewFile } = require('../../scripts/gather-reviews.js');

// test-data-write-guard-ok: writes a brand-new, never-colliding show dir
// (SHOW_ID below) under the real data/review-texts/ tree, not an existing
// tracked file — createReviewFile() resolves review-texts paths internally,
// so there's no injectable root to redirect to a tmp fixture. rm -rf'd in
// afterEach; the guard's true target (task #1662) is mutating EXISTING
// tracked content in place, which this pattern never does.
const REVIEW_TEXTS_DIR = path.join(process.cwd(), 'data', 'review-texts');
const SHOW_ID = '__test-createreviewfile-816';
const showDir = path.join(REVIEW_TEXTS_DIR, SHOW_ID);
const filePath = path.join(showDir, 'broadwayworld--some-critic.json');

function flaggedOnDisk() {
  return {
    showId: SHOW_ID,
    outletId: 'broadwayworld',
    outlet: 'BroadwayWorld',
    criticName: 'Some Critic',
    url: null,
    fullText: 'x'.repeat(2000),
    assignedScore: 60,
    contentTier: 'invalid',
    contentTierReason: 'Wrong production',
    wrongProduction: true,
    wrongProductionNote: 'Date guard: review predates this production',
  };
}

function withTempShowDir(fn) {
  fs.mkdirSync(showDir, { recursive: true });
  try {
    return fn();
  } finally {
    fs.rmSync(showDir, { recursive: true, force: true });
  }
}

test('createReviewFile does not clobber a wrongProduction-flagged file when the incoming write has no URL', () => {
  withTempShowDir(() => {
    fs.writeFileSync(filePath, JSON.stringify(flaggedOnDisk(), null, 2));

    // createReviewFile() always writes fullText:null for a fresh file by
    // design (reviewData.fullText is never read) — the protection under
    // test is safeWriteReview restoring the ON-DISK fullText because the
    // incoming write's fullText is empty, exactly as it would be for any
    // real re-ingestion through this function.
    const result = createReviewFile(SHOW_ID, {
      outletId: 'broadwayworld',
      outlet: 'BroadwayWorld',
      criticName: 'Some Critic',
      source: 'serp',
    });

    assert.equal(result, true);
    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.wrongProduction, true, 'wrongProduction was dropped — the flagged review will re-enter reviews.json');
    assert.equal(after.contentTier, 'invalid', 'contentTier was downgraded away from its excluded state');
    assert.equal(after.fullText, flaggedOnDisk().fullText, 'scored fullText was lost');
  });
});

test('a brand-new file still gets created when nothing exists at the path', () => {
  withTempShowDir(() => {
    // createReviewFile() always writes fullText:null for a fresh file by
    // design ("let collect-review-texts.js scrape real fullText") — assert
    // on a field it does populate directly from reviewData.
    const result = createReviewFile(SHOW_ID, {
      outletId: 'broadwayworld',
      outlet: 'BroadwayWorld',
      criticName: 'Some Critic',
      bwwExcerpt: 'a brand new excerpt',
      source: 'serp',
    });
    assert.equal(result, true);
    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.bwwExcerpt, 'a brand new excerpt');
  });
});
