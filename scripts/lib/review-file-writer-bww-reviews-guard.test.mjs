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

  test('BRO-3895: re-flagging via Guard K retracts a stale wrongProductionAutoCleared breadcrumb', () => {
    // Regression for the self-contradictory-clear shape
    // audit-self-contradictory-clear-drained.test.mjs gates on: an existing
    // file cleared by an earlier rebuild pass (wrongProductionAutoCleared
    // stamped, wrongProduction deleted) later matches Guard K's out-of-window
    // URL check again. Guard K only sets fields.wrongProduction/Note — it
    // never called invalidateWrongProductionAutoClear itself, so the merge
    // loop's generic `!existing[key]` write landed wrongProduction:true right
    // beside the still-live stale breadcrumb (caught on
    // much-ado-about-nothing-globe-off-west-end-2026/
    // broadwayworld--aliya-al-hassan.json). The fix moved the invalidate call
    // into _mergeIntoExisting's generic merge loop so it fires for every
    // fields.wrongProduction writer in this file, not just Guard K.
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const showDir = path.join(tmp, SHOW_ID);
      const filepath = path.join(showDir, 'broadwayworld--alexander-cohen.json');
      fs.writeFileSync(filepath, JSON.stringify({
        showId: SHOW_ID,
        outletId: 'broadwayworld',
        criticName: 'Alexander Cohen',
        url: 'https://www.broadwayworld.com/article/BWW-Review-THE-FEAR-OF-13-20190915',
        source: 'bww-roundup',
        excerpt: 'A real review excerpt about the show.',
        wrongProductionAutoCleared: 'rebuild: stale auto-clear from an earlier pass',
        wrongProductionAutoClearedAt: '2026-09-01',
      }, null, 2));

      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'broadwayworld',
        outlet: 'BroadwayWorld',
        criticName: 'Alexander Cohen',
        url: 'https://www.broadwayworld.com/article/BWW-Review-THE-FEAR-OF-13-20190915',
        source: 'bww-roundup',
        fields: { publishDate: null, excerpt: 'A real review excerpt about the show.' },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.equal(written.wrongProduction, true, 'Guard K must still re-flag the out-of-window URL');
      assert.equal(written.wrongProductionAutoCleared, undefined, 'stale auto-clear breadcrumb must be retracted, not left standing beside the re-flag');
      assert.equal(written.wrongProductionAutoClearedAt, undefined);
    });
  });

  test('BRO-3895: invalidation is not undone by an incoming payload that also echoes back wrongProductionAutoCleared', () => {
    // Ship-check/Codex adversarial finding: `fields` is `input.fields` itself
    // (mutated in place by Guard K), so invalidating INLINE mid-loop is
    // insertion-order dependent — a payload that predefines `wrongProduction`
    // (so Guard K's `!fields.wrongProduction` overwrite keeps its original key
    // position) ahead of `wrongProductionAutoCleared` in the SAME object would
    // have the generic merge loop re-add the just-deleted breadcrumb when it
    // reaches that later key, undoing the invalidate before the loop even
    // finishes. Requires an EXISTING file (the create-new-file path spreads
    // `fields` directly and never calls invalidate at all — a brand-new file
    // has no prior clear to protect, so that path is out of scope here). The
    // fix invalidates ONCE, after the full loop, so no later key in the same
    // payload can resurrect it.
    withTempReviewTextsDir(SHOW_ID, (tmp) => {
      const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
      const showDir = path.join(tmp, SHOW_ID);
      const filepath = path.join(showDir, 'broadwayworld--alexander-cohen.json');
      fs.writeFileSync(filepath, JSON.stringify({
        showId: SHOW_ID,
        outletId: 'broadwayworld',
        criticName: 'Alexander Cohen',
        url: 'https://www.broadwayworld.com/article/BWW-Review-THE-FEAR-OF-13-20190915',
        source: 'bww-roundup',
        excerpt: 'A real review excerpt about the show.',
      }, null, 2));

      const result = createOrMergeReviewFile(SHOW_ID, {
        outletId: 'broadwayworld',
        outlet: 'BroadwayWorld',
        criticName: 'Alexander Cohen',
        url: 'https://www.broadwayworld.com/article/BWW-Review-THE-FEAR-OF-13-20190915',
        source: 'bww-roundup',
        fields: {
          wrongProduction: false,
          publishDate: null,
          excerpt: 'A real review excerpt about the show.',
          wrongProductionAutoCleared: 'replayed: stale value echoed back by an import/scraper payload',
          wrongProductionAutoClearedAt: '2026-09-01',
        },
      }, { reviewTextsDir: tmp });

      assert.notEqual(result.action, 'skipped', `expected write, got skipped: ${result.reason}`);
      assert.equal(result.filepath, filepath, 'must merge into the existing file, not create a new one');
      const written = JSON.parse(fs.readFileSync(result.filepath, 'utf-8'));
      assert.equal(written.wrongProduction, true, 'Guard K must still re-flag the out-of-window URL');
      assert.equal(written.wrongProductionAutoCleared, undefined, 'echoed-back breadcrumb in the SAME payload must not survive the re-flag');
      assert.equal(written.wrongProductionAutoClearedAt, undefined);
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
