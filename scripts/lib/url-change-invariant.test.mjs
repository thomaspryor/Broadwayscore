/**
 * URL-change invariant gap (#483): maybeUpgradeUrl() wiped a review's body
 * fields (fullText/contentTier/textStatus) directly, in place, without ever
 * consulting applyUrlChangeInvariant() — so wrongProduction/wrongShow/
 * contentVerification describing the OLD article rode along, permanently
 * blocking rebuild of the freshly-corrected URL. 112 corpus files matched
 * this exact signature on 2026-07-26.
 *
 * The escape path was specifically a COSMETIC url "upgrade" (tracking params,
 * protocol, trailing slash, AMP suffix): maybeUpgradeUrl compares the two URLs
 * as RAW STRINGS (`existingData.url === newUrl`), while applyUrlChangeInvariant
 * (the module that actually clears stale flags) gates on `urlCanonicallyChanged`
 * — a NORMALIZED comparison. A raw-string change that normalizes equal fired
 * the content wipe but never fired the flag-clearing invariant.
 *
 * These tests exercise the REAL write path an aggregator scraper uses
 * (createOrMergeReviewFile -> _mergeIntoExisting -> maybeUpgradeUrl ->
 * safeWriteReview -> applyUrlChangeInvariant), not a reimplementation of the
 * logic, per CLAUDE.md §15.
 *
 * Run: node --test scripts/lib/url-change-invariant.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const { applyUrlChangeInvariant } = require('./url-change-invariant.js');

const quiet = (fn) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
};

function makeFixture(reviewTextsDir, showId, filename, data) {
  const dir = path.join(reviewTextsDir, showId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2) + '\n');
  return path.join(dir, filename);
}

const STALE_FLAGS = {
  showId: 'hamilton-test-fixture',
  outletId: 'vulture',
  outlet: 'Vulture',
  criticName: 'Jesse Green',
  url: 'https://www.vulture.com/hamilton-review',
  source: 'gather-reviews',
  sources: ['gather-reviews'],
  fullText: null,
  needsRefetch: true,
  contentTier: 'stub',
  wrongProduction: true,
  wrongProductionReason: 'Pre-opening guard: dated before earliest known preview',
  contentVerification: {
    verified: false,
    reason: 'Article discusses a different production entirely',
    checkedAt: '2026-06-01T00:00:00.000Z',
  },
};

test('maybeUpgradeUrl write path clears stale wrongProduction/contentVerification on a COSMETIC url swap (the actual #483 escape path)', () => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-cosmetic-'));
  const showId = 'hamilton-test-fixture';
  makeFixture(reviewTextsDir, showId, 'vulture--jesse-green.json', STALE_FLAGS);

  // Only a tracking-param suffix — normalizeUrl() treats this as the SAME
  // canonical article as the existing url.
  const result = quiet(() => createOrMergeReviewFile(showId, {
    outlet: 'Vulture',
    criticName: 'Jesse Green',
    url: 'https://www.vulture.com/hamilton-review?utm_source=broadwayworld&utm_medium=referral',
    source: 'bww-aggregator',
    fields: {},
  }, { reviewTextsDir }));

  assert.equal(result.action, 'updated');
  const after = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));

  assert.equal(after.wrongProduction, undefined, 'stale wrongProduction must not survive a maybeUpgradeUrl cosmetic swap');
  assert.equal(after.wrongProductionReason, undefined);
  assert.equal(after.contentVerification, undefined, 'stale contentVerification must not survive a maybeUpgradeUrl cosmetic swap');
  assert.equal(after.contentTier, undefined);
  assert.ok(after.needsRefetch, 'needsRefetch must stay true so the corrected url gets refetched');
  assert.ok(after.urlCorrectedFrom, 'urlCorrectedFrom breadcrumb must be stamped');
  assert.ok(after._urlChangedClear, 'the clear must be recorded so CI push-restore does not resurrect the stale flags');
  assert.ok(after._urlChangedClear.cleared.includes('wrongProduction'));
  assert.ok(after._urlChangedClear.cleared.includes('contentVerification'));

  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});

test('maybeUpgradeUrl write path clears stale wrongProduction/contentVerification on a genuinely different url', () => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-real-'));
  const showId = 'hamilton-test-fixture';
  makeFixture(reviewTextsDir, showId, 'vulture--jesse-green.json', {
    ...STALE_FLAGS,
    url: 'https://www.vulture.com/hamilton-old-broken-scrape',
  });

  const result = quiet(() => createOrMergeReviewFile(showId, {
    outlet: 'Vulture',
    criticName: 'Jesse Green',
    url: 'https://www.vulture.com/hamilton-corrected-url',
    source: 'bww-aggregator',
    fields: {},
  }, { reviewTextsDir }));

  assert.equal(result.action, 'updated');
  const after = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));

  assert.equal(after.wrongProduction, undefined);
  assert.equal(after.contentVerification, undefined);
  assert.equal(after.url, 'https://www.vulture.com/hamilton-corrected-url');

  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});

test('maybeUpgradeUrl refuses to touch a locked/urlVerified file', () => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-locked-'));
  const showId = 'hamilton-test-fixture';
  makeFixture(reviewTextsDir, showId, 'vulture--jesse-green.json', {
    ...STALE_FLAGS,
    urlVerified: true,
  });

  const result = quiet(() => createOrMergeReviewFile(showId, {
    outlet: 'Vulture',
    criticName: 'Jesse Green',
    url: 'https://www.vulture.com/hamilton-corrected-url',
    source: 'bww-aggregator',
    fields: {},
  }, { reviewTextsDir }));

  const after = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
  assert.equal(after.url, 'https://www.vulture.com/hamilton-review', 'a urlVerified file must keep its verified url');
  assert.equal(after.wrongProduction, true, 'flags on a urlVerified file are untouched since no upgrade happened');

  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});

test('applyUrlChangeInvariant force:true clears URL-derived fields even when normalizeUrl() calls the urls the same article', () => {
  const existing = {
    url: 'https://www.vulture.com/hamilton-review',
    wrongProduction: true,
    wrongProductionReason: 'stale',
    contentVerification: { verified: false },
    fullText: null,
  };
  const merged = {
    ...existing,
    url: 'https://www.vulture.com/hamilton-review?utm_source=x',
  };

  // Without force, a cosmetic-only change is a no-op (this is the bug).
  const unforced = applyUrlChangeInvariant({ ...existing }, { ...merged }, {});
  assert.equal(unforced.changed, false);

  const forced = applyUrlChangeInvariant({ ...existing }, merged, { force: true });
  assert.equal(forced.changed, true);
  assert.ok(forced.cleared.includes('wrongProduction'));
  assert.ok(forced.cleared.includes('contentVerification'));
  assert.equal(merged.wrongProduction, undefined);
  assert.equal(merged.contentVerification, undefined);
});
