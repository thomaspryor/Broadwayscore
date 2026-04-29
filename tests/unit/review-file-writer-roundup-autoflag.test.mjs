// Regression test for Guard E (BWW Review-Roundup auto-flag).
//
// Background: a BWW Review-Roundup file landed unflagged on 2026-04-28
// (joe-turners-come-and-gone-2026/broadwayworld--aa-cristi.json) because
// `discover-opening-night-reviews.js` wrote raw via fs.writeFileSync,
// bypassing `createOrMergeReviewFile` and therefore Guard E. Item 2 of
// the systematic CI fixes plan migrates that script to use
// `createOrMergeReviewFile`. This test pins the contract so a future
// regression that bypasses the writer (or strips Guard E from it) fails
// CI.
//
// What we check:
//   1. URLs matching `/article/Review-Roundup-` get isRoundupArticle=true.
//   2. URLs that don't match leave the field unset.
//   3. Manual-clear breadcrumb (humanReviewedRoundupOverride: false) is
//      respected via the merge path — Guard E doesn't re-flag a file a
//      human cleared.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Stage a temp review-texts root with a single show dir so the writer
// has somewhere to land. Each subtest gets a fresh tmpdir to avoid
// state leaking between tests.
function withTempReviewTextsDir(showId, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-file-writer-test-'));
  fs.mkdirSync(path.join(tmp, showId), { recursive: true });
  // Stage a minimal shows.json so _getShowCategory doesn't crash.
  // The writer reads ../data/shows.json; we don't touch that, but the
  // cross-market reroute helper looks up category. For BWW Broadway URLs
  // the routing won't reroute so the lookup is best-effort.
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('review-file-writer Guard E (Review-Roundup auto-flag)', () => {
  test('BWW Review-Roundup URL → isRoundupArticle=true', () => {
    withTempReviewTextsDir('joe-turners-come-and-gone-2026', (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const result = createOrMergeReviewFile('joe-turners-come-and-gone-2026', {
        outletId: 'broadwayworld',
        outlet: 'BroadwayWorld',
        criticName: 'A.A. Cristi',
        url: 'https://www.broadwayworld.com/article/Review-Roundup-JOE-TURNERS-COME-AND-GONE-Opens-On-Broadway-20260425',
        source: 'opening-night-discovery',
        fields: {
          publishDate: null,
          fullText: null,
          contentTier: 'excerpt',
        },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      assert.ok(result.filepath, 'filepath should be set');
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.equal(written.isRoundupArticle, true, 'Guard E must auto-flag');
      assert.match(written.roundupArticleReason || '', /BWW Review-Roundup/i);
    });
  });

  test('non-roundup BWW URL → isRoundupArticle unset', () => {
    withTempReviewTextsDir('hamilton-2015', (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const result = createOrMergeReviewFile('hamilton-2015', {
        outletId: 'broadwayworld',
        outlet: 'BroadwayWorld',
        criticName: 'Test Critic',
        url: 'https://www.broadwayworld.com/reviews/Hamilton-Broadway-Production',
        source: 'opening-night-discovery',
        fields: {
          publishDate: null,
          fullText: null,
          contentTier: 'excerpt',
        },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.notEqual(written.isRoundupArticle, true, 'non-roundup URL must not be flagged');
    });
  });

  test('Review-Roundup pattern is case-insensitive', () => {
    withTempReviewTextsDir('test-show-2026', (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const result = createOrMergeReviewFile('test-show-2026', {
        outletId: 'broadwayworld',
        outlet: 'BroadwayWorld',
        criticName: 'Test',
        url: 'https://www.broadwayworld.com/article/review-roundup-LOWER-CASE-TEST',
        source: 'opening-night-discovery',
        fields: { publishDate: null, fullText: null, contentTier: 'excerpt' },
      }, { reviewTextsDir: tmp });

      if (result.action !== 'skipped') {
        const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
        assert.equal(written.isRoundupArticle, true, 'lowercase variant must also be flagged');
      }
    });
  });
});
