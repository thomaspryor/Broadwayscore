/**
 * Task #1695: maybeUpgradeUrl() (review-normalization.js) treated a flagged
 * file's contentTier==='invalid' as generic "bad content" worth a URL
 * upgrade. contentTier:'invalid' on a wrongProduction/wrongShow/duplicateOf
 * file is FLAG-DRIVEN (content-quality.js's T5 check), not a genuine
 * content-quality signal — but badContent's check couldn't tell the
 * difference. A re-scrape bringing a different URL for the same outlet+critic
 * (outlet redirect/republish, scraper self-heal) "upgraded" the URL and
 * applyUrlChangeInvariant(force:true) cleared every old-URL-derived field
 * along with it, INCLUDING wrongProduction/wrongShow — silently
 * un-excluding a review that was deliberately flagged out of scoring.
 *
 * The fix is scoped to contentTier === 'invalid', not the flags alone: a
 * file flagged via an unrelated auto-guard but with genuinely missing/stub
 * content (contentTier stays e.g. 'stub') must still be upgradeable — see
 * url-change-invariant.test.mjs's STALE_FLAGS fixture, which this test suite
 * deliberately does not regress (last test below).
 *
 * Run: node --test tests/unit/review-file-writer-preserves-flags-on-url-change.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');

const quiet = (fn) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
};

function writeFlaggedFile(dir, showId, filename, extra = {}) {
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir, { recursive: true });
  const fp = path.join(showDir, filename);
  fs.writeFileSync(fp, JSON.stringify({
    showId,
    outletId: 'vulture',
    outlet: 'Vulture',
    criticName: 'Jesse Green',
    url: 'https://www.vulture.com/some-review-old',
    source: 'gather-reviews',
    sources: ['gather-reviews'],
    fullText: 'x'.repeat(4000),
    isFullReview: true,
    contentTier: 'invalid',
    contentTierReason: 'Wrong production',
    ...extra,
  }, null, 2));
  return fp;
}

describe('maybeUpgradeUrl preserves flag-driven exclusion verdicts on URL change (#1695)', () => {
  test('wrongProduction + contentTier:invalid survives an incoming write with a different url', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-flags-wp-'));
    const fp = writeFlaggedFile(dir, 'flagged-show', 'vulture--jesse-green.json', {
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review predates this production',
    });
    const res = quiet(() => createOrMergeReviewFile('flagged-show', {
      outletId: 'vulture', outlet: 'Vulture', criticName: 'Jesse Green',
      url: 'https://www.vulture.com/some-review-refetched',
      source: 'bww-aggregator',
      fields: {},
    }, { reviewTextsDir: dir }));
    const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(after.wrongProduction, true, 'wrongProduction was dropped — the flagged review will re-enter reviews.json');
    assert.equal(after.contentTier, 'invalid', 'contentTier was downgraded away from its excluded state');
    assert.equal(after.url, 'https://www.vulture.com/some-review-old', "the flagged file's own url must survive");
    assert.ok(res);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('wrongShow + contentTier:invalid survives an incoming write with a different url', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-flags-ws-'));
    const fp = writeFlaggedFile(dir, 'flagged-show-2', 'vulture--jesse-green.json', {
      wrongShow: true,
      wrongShowReason: 'Slug identifies a different show',
    });
    quiet(() => createOrMergeReviewFile('flagged-show-2', {
      outletId: 'vulture', outlet: 'Vulture', criticName: 'Jesse Green',
      url: 'https://www.vulture.com/some-review-refetched',
      source: 'bww-aggregator',
      fields: {},
    }, { reviewTextsDir: dir }));
    const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(after.wrongShow, true, 'wrongShow was dropped');
    assert.equal(after.contentTier, 'invalid');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('duplicateOf + contentTier:invalid survives an incoming write with a different url', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-flags-dup-'));
    // The sibling duplicateOf points at must exist on disk AND share this
    // file's (pre-upgrade) url, or review-write-guard's own unrelated
    // dangling/stale-duplicateOf self-heal (Can I Be Frank, 2026-05-24) clears
    // duplicateOf before this test can observe maybeUpgradeUrl's behavior.
    const showDir = path.join(dir, 'flagged-show-3');
    fs.mkdirSync(showDir, { recursive: true });
    fs.writeFileSync(path.join(showDir, 'vulture--jesse-green-other.json'), JSON.stringify({
      showId: 'flagged-show-3', outletId: 'vulture', outlet: 'Vulture', criticName: 'Jesse Green Other',
      url: 'https://www.vulture.com/some-review-old', fullText: 'canonical body', contentTier: 'complete',
    }, null, 2));
    const fp = writeFlaggedFile(dir, 'flagged-show-3', 'vulture--jesse-green.json', {
      duplicateOf: 'vulture--jesse-green-other.json',
    });
    quiet(() => createOrMergeReviewFile('flagged-show-3', {
      outletId: 'vulture', outlet: 'Vulture', criticName: 'Jesse Green',
      url: 'https://www.vulture.com/some-review-refetched',
      source: 'bww-aggregator',
      fields: {},
    }, { reviewTextsDir: dir }));
    const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(after.duplicateOf, 'vulture--jesse-green-other.json', 'duplicateOf was dropped');
    assert.equal(after.contentTier, 'invalid');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a wrongProduction flag WITHOUT contentTier:invalid (genuinely missing content) still upgrades — does not regress #483', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-flags-stub-'));
    const fp = writeFlaggedFile(dir, 'flagged-show-4', 'vulture--jesse-green.json', {
      wrongProduction: true,
      wrongProductionReason: 'Pre-opening guard: dated before earliest known preview',
      contentTier: 'stub',
      fullText: null,
      needsRefetch: true,
    });
    quiet(() => createOrMergeReviewFile('flagged-show-4', {
      outletId: 'vulture', outlet: 'Vulture', criticName: 'Jesse Green',
      url: 'https://www.vulture.com/some-review-refetched',
      source: 'bww-aggregator',
      fields: {},
    }, { reviewTextsDir: dir }));
    const after = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(after.wrongProduction, undefined, 'auto-guard flag on genuinely stub content must still clear on a real url upgrade');
    assert.equal(after.url, 'https://www.vulture.com/some-review-refetched');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
