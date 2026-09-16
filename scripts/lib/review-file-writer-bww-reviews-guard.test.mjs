// TESTS-VS-DERIVED-DATA-EXEMPT: guard logic test — reads shows.json for a
// real show's date window, asserts auto-flag behavior, no hardcoded facts.
//
// Regression test for BRO-3502: Guard K (review-file-writer.js), which
// extends BRO-916's BWW cross-production URL-date guard
// (getWrongProductionReasonForBww, scripts/lib/review-guards.js — see
// flag-wrong-production-by-url-date.test.mjs for its own unit tests) to the
// shared createOrMergeReviewFile chokepoint. Before this fix, that guard only
// ran inside gather-reviews.js's own createReviewFile — any BWW-sourced
// review reaching review-texts through createOrMergeReviewFile instead (e.g.
// scripts/scrape-bww-reviews.js's /reviews/{slug} page extraction, source
// 'bww-reviews', and its own separate roundup-page extraction, source
// 'bww-roundup') had zero URL-date cross-production protection beyond Guard
// J's Unknown/Staff-critic-only check.
//
// Risk-shape note (found during BRO-3502 review): for 'bww-reviews' entries,
// `url` is the THIRD-PARTY outlet's own outbound link with a real named
// critic byline — not BWW's own hosted article — so the operative check is
// the general slash-dated URL path (getWrongProductionReasonFromUrl), with
// the named-critic benefit-of-the-doubt deliberately removed (same BRO-916
// rationale: BWW's own page assembly is the contamination risk, not how the
// critic wrote their own piece). A corpus scan against the full
// data/review-texts corpus (7,063 bww-roundup/bww-reviews files) found 4 new
// hits, 2 of them confirmed live cross-production contamination this guard
// newly catches. This test's primary fixtures exercise that real shape
// (external URL, named critic), not just BWW's own trailing-date URL
// convention.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { getShowData } from './production-verifier.js';

const require = createRequire(import.meta.url);

const SHOW_ID = 'the-fear-of-13-2026';

function withTempReviewTextsDir(showId, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-file-writer-bww-guard-test-'));
  fs.mkdirSync(path.join(tmp, showId), { recursive: true });
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('review-file-writer Guard K (BWW cross-production wrongProduction, BRO-3502)', () => {
  test('fixture show has the expected date window', () => {
    const show = getShowData(SHOW_ID);
    assert.ok(show, `expected ${SHOW_ID} to exist in data/shows.json`);
    assert.equal(show.previewsStartDate, '2026-03-19');
    assert.equal(show.openingDate, '2026-04-15');
  });

  test('bww-reviews: named critic + out-of-window third-party URL → flagged via wrongProductionNote only', () => {
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'guardian',
        outlet: 'The Guardian',
        criticName: 'Some Named Critic',
        url: 'https://www.theguardian.com/stage/2019/09/15/the-fear-of-13-review',
        source: 'bww-reviews',
        fields: { publishDate: null, excerpt: 'A real review excerpt about the show.', contentTier: 'excerpt' },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.equal(written.wrongProduction, true, 'Guard K must flag an out-of-window bww-reviews entry');
      assert.match(written.wrongProductionNote || '', /^Auto-flagged:/, 'must keep the Auto-flagged prefix for wrong-production-autoclear.js');
      assert.match(written.wrongProductionNote || '', /BWW cross-production/);
      assert.equal(written.wrongProductionReason, undefined, 'must set ONLY wrongProductionNote, never wrongProductionReason, to stay priorRuns-auto-clear eligible');
    });
  });

  test('bww-reviews: named critic + in-window third-party URL → not flagged', () => {
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'guardian',
        outlet: 'The Guardian',
        criticName: 'Some Named Critic',
        url: 'https://www.theguardian.com/stage/2026/04/16/the-fear-of-13-review',
        source: 'bww-reviews',
        fields: { publishDate: null, excerpt: 'A real review excerpt about the show.', contentTier: 'excerpt' },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.notEqual(written.wrongProduction, true, 'in-window URL must not be flagged');
    });
  });

  test('bww-roundup reaching THIS chokepoint (scrape-bww-reviews.js\'s own roundup extraction): BWW-hosted trailing-date URL out of window → flagged', () => {
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      // No "westend"/region path segment here (unlike the real Alexander Cohen
      // incident URL) — a region-path URL on a Broadway show's roundup trips
      // the separate, unrelated isLikelyTourReview guard (Guard, task #1150)
      // before Guard K ever runs, which is correct existing behavior but would
      // make this fixture test that guard instead of Guard K's own trailing-
      // date fallback. Kept plain to isolate what this test targets.
      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'broadwayworld',
        outlet: 'BroadwayWorld',
        criticName: 'Alexander Cohen',
        url: 'https://www.broadwayworld.com/article/BWW-Review-THE-FEAR-OF-13-20190915',
        source: 'bww-roundup',
        fields: { publishDate: null, excerpt: 'A real review excerpt about the show.', contentTier: 'excerpt' },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.equal(written.wrongProduction, true, 'Guard K must also cover bww-roundup entries reaching this chokepoint');
      assert.match(written.wrongProductionNote || '', /^Auto-flagged:/);
    });
  });

  test('human-cleared existing file is not re-stamped even with a fresh out-of-window URL', () => {
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const showDir = path.join(tmp, SHOW_ID);
      const filepath = path.join(showDir, 'guardian--some-named-critic.json');
      fs.writeFileSync(filepath, JSON.stringify({
        showId: SHOW_ID,
        outletId: 'guardian',
        criticName: 'Some Named Critic',
        url: 'https://www.theguardian.com/stage/2019/09/15/the-fear-of-13-review',
        source: 'bww-reviews',
        excerpt: 'A real review excerpt about the show.',
        wrongProductionManualClear: true,
      }, null, 2));

      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'guardian',
        outlet: 'The Guardian',
        criticName: 'Some Named Critic',
        url: 'https://www.theguardian.com/stage/2019/09/15/the-fear-of-13-review',
        source: 'bww-reviews',
        fields: { publishDate: null, excerpt: 'A real review excerpt about the show.' },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.notEqual(written.wrongProduction, true, 'human-cleared file must not be re-stamped');
    });
  });

  test('human-cleared existing file is still found when the incoming URL is a refreshed/different one (criticName-identity fix)', () => {
    // Regression for a bug the ship-check adversarial review found: Guard K's
    // own existing-file lookup used to always pass criticName=null, while the
    // REAL merge-target lookup (the findExistingReviewFile call feeding
    // _mergeIntoExisting) passes the actual criticName. When
    // an incoming write's URL doesn't canonically match the existing file's
    // stored URL (e.g. a scraper refresh with a slightly different URL), the
    // null-based lookup fails to find the existing named-critic file at all
    // (criticIsCompatibleMergeTarget treats null-vs-named as incompatible) —
    // so Guard K wrongly concludes "not cleared" and stamps wrongProduction,
    // which then merges onto the SAME file the real (criticName-based) merge
    // lookup finds and writes to, resurrecting a flag a human had cleared.
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const showDir = path.join(tmp, SHOW_ID);
      const filepath = path.join(showDir, 'guardian--some-named-critic.json');
      fs.writeFileSync(filepath, JSON.stringify({
        showId: SHOW_ID,
        outletId: 'guardian',
        criticName: 'Some Named Critic',
        url: 'https://www.theguardian.com/stage/2019/09/15/the-fear-of-13-review-original',
        source: 'bww-reviews',
        excerpt: 'A real review excerpt about the show.',
        wrongProductionManualClear: true,
      }, null, 2));

      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'guardian',
        outlet: 'The Guardian',
        criticName: 'Some Named Critic',
        // Different URL than the existing file's — same critic, same outlet,
        // still out-of-window, but won't canonically URL-match the existing
        // record (simulates a scraper picking up a refreshed permalink).
        url: 'https://www.theguardian.com/stage/2019/09/15/the-fear-of-13-review-refreshed',
        source: 'bww-reviews',
        fields: { publishDate: null, excerpt: 'A real review excerpt about the show.' },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.equal(result.filepath, filepath, 'must merge into the same existing file the real merge-target lookup finds');
      assert.notEqual(written.wrongProduction, true, 'human-cleared file must not be re-stamped even via a URL-refresh merge');
    });
  });

  test('does not fire for a non-BWW source, even with the same out-of-window URL', () => {
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'guardian',
        outlet: 'The Guardian',
        criticName: 'Some Named Critic',
        url: 'https://www.theguardian.com/stage/2019/09/15/the-fear-of-13-review',
        source: 'dtli',
        fields: { publishDate: null, excerpt: 'A real review excerpt about the show.', contentTier: 'excerpt' },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.notEqual(written.wrongProduction, true, 'Guard K is scoped to bww-roundup/bww-reviews sources only');
    });
  });
});
