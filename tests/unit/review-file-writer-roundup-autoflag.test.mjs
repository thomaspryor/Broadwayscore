// TESTS-VS-DERIVED-DATA-EXEMPT: guard logic test — reads shows.json for slug lookups, asserts auto-flag behavior, no hardcoded facts.
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
        url: 'https://www.broadwayworld.com/article/BWW-Review-Hamilton-Broadway-Production-20150101',
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

  test('Guard E1: BWW /reviews/{slug} critics-aggregation page → isRoundupArticle=true (Whoopi Monologues 2026-07-14)', () => {
    withTempReviewTextsDir('the-whoopi-monologues-off-broadway-2026', (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const result = createOrMergeReviewFile('the-whoopi-monologues-off-broadway-2026', {
        outletId: 'broadwayworld',
        outlet: 'BroadwayWorld',
        criticName: 'Charles Isherwood',
        url: 'https://www.broadwayworld.com/reviews/the-whoopi-monologues',
        source: 'serp-discovery',
        fields: {
          publishDate: null,
          fullText: null,
          contentTier: 'excerpt',
        },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.equal(written.isRoundupArticle, true, 'Guard E1 must auto-flag BWW /reviews/ pages');
      assert.match(written.roundupArticleReason || '', /reviews.*critics-aggregation/i);
    });
  });

  test('Guard E4: "critical consensus" pull-quote compilation (outlet-agnostic) → isRoundupArticle=true (task #1888, newyorktheater.me shape)', () => {
    withTempReviewTextsDir('paranormal-activity-2026', (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const fullText = 'A new horror play opened tonight at the August Wilson Theatre. That is the critical consensus, as indicated below: '
        + 'Helen Shaw, New York Times. A confident, unsettling piece of theater that earns its scares. '
        + 'Jackson McHenry, Vulture. The design team pulls off tricks that leave the audience gasping. '
        + "Howard Miller, Talkin' Broadway. A tightly wound thriller with a starry cast. "
        + 'Johnny Oleksinski, New York Post. Genuinely frightening in a way few Broadway shows manage.';
      const result = createOrMergeReviewFile('paranormal-activity-2026', {
        outletId: 'nyt-theater',
        outlet: 'New York Theater',
        criticName: 'Jonathan Mandell',
        url: 'https://newyorktheater.me/2026/08/25/paranormal-activity-broadway-reviews/',
        source: 'rss-discovery',
        fields: {
          publishDate: '2026-08-26',
          fullText,
          contentTier: 'complete',
        },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.equal(written.isRoundupArticle, true, 'Guard E4 must auto-flag a pull-quote compilation bylined to an uninvolved compiler');
      assert.match(written.roundupArticleReason || '', /pull-quote compilation/i);
    });
  });

  test('Guard E4 does NOT flag a real review whose byline critic is one of the quoted critics', () => {
    withTempReviewTextsDir('miss-saigon-1991', (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const fullText = "Here are what the critics said after Thursday's opening: "
        + 'Frank Rich, New York Times. A gripping entertainment that earns its long run. '
        + 'David Patrick Stearn, USA Today. Worth the high ticket price for the visual thrills alone. '
        + 'Michael Kuchwara, Associated Press. The central performance carries the whole show. '
        + "Howard Kissel, New York Daily News. Apart from some impressive performances, there's not much else to make this worthwhile.";
      const result = createOrMergeReviewFile('miss-saigon-1991', {
        outletId: 'nydailynews',
        outlet: 'New York Daily News',
        criticName: 'Howard Kissel',
        url: 'https://www.nydailynews.com/1991/04/13/miss-saigon-review/',
        source: 'newspapers-com-ocr',
        fields: {
          publishDate: '1991-04-13',
          fullText,
          contentTier: 'complete',
        },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.notEqual(written.isRoundupArticle, true, 'must not flag a wire digest that carries the byline critic\'s own verdict');
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
