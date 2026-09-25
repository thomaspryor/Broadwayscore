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
const { applyUrlChangeInvariant, isUrlFlipFlop } = require('./url-change-invariant.js');

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

test('BRO-4130: a fresh originalScore arriving in the SAME write as a fresh url survives the url swap', () => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-paired-score-'));
  const showId = 'hamilton-test-fixture';
  // No score on disk yet — a paywalled stub with no fullText, no url-derived
  // state to protect other than the fact it's badContent (no fullText).
  makeFixture(reviewTextsDir, showId, 'thestage--unknown.json', {
    showId,
    outletId: 'thestage',
    outlet: 'The Stage',
    criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/hamilton-old-broken-scrape',
    source: 'gather-reviews',
    sources: ['gather-reviews'],
    fullText: null,
    needsRefetch: true,
    contentTier: 'stub',
  });

  // A SERP-recovery style write: fetches a fresh (non-roundup) url AND
  // extracts a fresh star rating from it in the same call — the _mergeIntoExisting
  // field-merge loop plants originalScore/originalScoreSource onto `existing`
  // BEFORE maybeUpgradeUrl runs, so without the pre-merge snapshot fix the
  // invariant sees them as "unchanged old-url state" and wipes them.
  const result = quiet(() => createOrMergeReviewFile(showId, {
    outlet: 'The Stage',
    criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/hamilton-corrected-review',
    source: 'serp-discovery',
    fields: { originalScore: '4', originalScoreSource: 'stage-star-svg' },
  }, { reviewTextsDir }));

  assert.equal(result.action, 'updated');
  const after = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));

  assert.equal(after.url, 'https://www.thestage.co.uk/reviews/hamilton-corrected-review');
  assert.equal(after.originalScore, '4', 'a score paired with its own new url in the same write must not be wiped');
  assert.equal(after.originalScoreSource, 'stage-star-svg');

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

// BRO-121: flip-flop breaker. isUrlFlipFlop() reads the _urlChangedClear
// breadcrumb applyUrlChangeInvariant stamps on every real url change, so a
// swap-back to the pre-change url (the ping-pong half of the cycle) can be
// detected without any new state.
test('isUrlFlipFlop detects a swap back to the pre-change url', () => {
  const urlA = 'https://www.independent.co.uk/review-b123.html';
  const urlB = 'https://www.independent.co.uk/review-b123.html?loginSuccessful=true';
  const existing = {
    url: urlA,
    _urlChangedClear: { from: urlB, to: urlA, at: '2026-08-01T00:00:00.000Z', cleared: ['llmScore'] },
  };
  assert.equal(isUrlFlipFlop(existing, urlB), true, 'swap back to the pre-change url is a flip-flop');
  assert.equal(isUrlFlipFlop(existing, 'https://www.independent.co.uk/a-totally-different-review.html'), false, 'a genuinely new url is not a flip-flop');
});

test('isUrlFlipFlop is false with no breadcrumb (first-ever url change)', () => {
  const existing = { url: 'https://www.independent.co.uk/review-a.html' };
  assert.equal(isUrlFlipFlop(existing, 'https://www.independent.co.uk/review-b.html'), false);
});

// Codex adversarial review (BRO-121): a breadcrumb whose `to` no longer
// matches the file's actual current url is stale (something changed `url`
// without going through applyUrlChangeInvariant) and must not be trusted.
test('isUrlFlipFlop ignores a stale breadcrumb whose "to" does not match the current url', () => {
  const existing = {
    url: 'https://www.independent.co.uk/review-hand-corrected.html',
    _urlChangedClear: { from: 'https://www.independent.co.uk/review-old.html', to: 'https://www.independent.co.uk/review-mid.html', at: '2026-07-01T00:00:00.000Z', cleared: ['llmScore'] },
  };
  assert.equal(isUrlFlipFlop(existing, 'https://www.independent.co.uk/review-old.html'), false, 'stale breadcrumb must not block a genuinely new url');
});

test('safeWriteReview write chokepoint blocks a flip-flop swap-back and pins urlVerified', () => {
  const { safeWriteReview } = require('./review-write-guard.js');
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-flipflop-'));
  const showId = 'hamilton-test-fixture';
  const urlA = 'https://www.vulture.com/hamilton-review';
  const urlB = 'https://www.vulture.com/hamilton-review-alt-slug';
  // A file that already swapped A -> B once and carries the breadcrumb
  // applyUrlChangeInvariant stamped for that swap.
  const target = makeFixture(reviewTextsDir, showId, 'vulture--jesse-green.json', {
    showId, outletId: 'vulture', outlet: 'Vulture', criticName: 'Jesse Green',
    url: urlB,
    source: 'gather-reviews',
    fullText: 'The real scored review text.',
    contentTier: 'complete',
    llmScore: { score: 82 },
    _urlChangedClear: { from: urlA, to: urlB, at: '2026-08-01T00:00:00.000Z', cleared: ['llmScore', 'fullText'] },
  });

  // A poller/direct writer re-scrapes and swings the url back to A — the
  // ping-pong — calling safeWriteReview directly (the shared chokepoint every
  // writer besides mergeReviews goes through, per CLAUDE.md §15).
  const result = quiet(() => safeWriteReview(target, {
    criticName: 'Jesse Green',
    url: urlA,
    source: 'bww-aggregator',
  }));

  assert.equal(result.wrote, true);
  const after = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(after.url, urlB, 'flip-flop swap-back must be refused, keeping the current url');
  assert.equal(after.llmScore.score, 82, 'scored state must survive — this is the BRO-121 regression');
  assert.equal(after.fullText, 'The real scored review text.');
  assert.equal(after.urlVerified, true, 'file must be pinned after a detected flip-flop');
  assert.equal(after.urlVerifiedAuto, true, 'auto-pin must be distinguishable from a real human urlVerified decision');
  assert.ok(after.urlVerifiedNote && after.urlVerifiedNote.includes('flip-flop'));

  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});

test('BRO-4130: a flip-flop-rejected swap does not leave its own paired score misattributed to the pinned url', () => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-flipflop-score-'));
  const showId = 'hamilton-test-fixture';
  const urlA = 'https://www.thestage.co.uk/reviews/hamilton-review-a';
  const urlB = 'https://www.thestage.co.uk/reviews/hamilton-review-b';
  // File currently at A, badContent (no fullText), with a breadcrumb saying
  // it was corrected FROM B to A previously.
  makeFixture(reviewTextsDir, showId, 'thestage--unknown.json', {
    showId, outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown',
    url: urlA,
    source: 'gather-reviews',
    fullText: null,
    needsRefetch: true,
    contentTier: 'stub',
    _urlChangedClear: { from: urlB, to: urlA, at: '2026-08-01T00:00:00.000Z', cleared: ['fullText'] },
  });

  // A write proposes swapping back to B (the flip-flop half of the cycle),
  // WITH a fresh score paired with that same url in the same call. The BRO-4130
  // fix correctly lets maybeUpgradeUrl preserve the paired score through its
  // own applyUrlChangeInvariant call — but safeWriteReview's flip-flop guard
  // downstream then rejects the url swap itself and pins the file back to A.
  // The score arrived describing article B; it must not end up stranded on A.
  const result = quiet(() => createOrMergeReviewFile(showId, {
    outlet: 'The Stage',
    criticName: 'Unknown',
    url: urlB,
    source: 'serp-discovery',
    fields: { originalScore: '4', originalScoreSource: 'stage-star-svg' },
  }, { reviewTextsDir }));

  assert.equal(result.action, 'updated');
  const after = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));

  assert.equal(after.url, urlA, 'flip-flop swap-back must be refused, keeping the pinned url');
  assert.equal(after.originalScore, undefined, 'a score paired with the REJECTED url must not survive misattributed to the pinned url');
  assert.equal(after.originalScoreSource, undefined);

  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});

// ── BRO-2740: provenance must not outlive the flag ────────────────────────
//
// Corpus signature (measured 2026-09-02 over 42,520 review files): 204 files
// carry wrongProduction provenance with no `wrongProduction: true`. 138 of
// them have the flag KEY ABSENT, no `wrongProductionReason`, and NO
// `wrongProductionAutoCleared` breadcrumb — a shape no rebuild-all-reviews
// auto-clear path can produce (all of them stamp that breadcrumb), but exactly
// what the URL-change clear produced when its field list was the hand-written
// triple `wrongProduction` / `Reason` / `Note`.

test('BRO-2740: URL change clears wrongProduction provenance with the flag', () => {
  const existing = {
    url: 'https://www.telegraph.co.uk/theatre/old-production-review/',
    wrongProduction: true,
    wrongProductionReason: 'anticipatory_pre_opening_post',
    wrongProductionDetail: 'Published 9 days before opening night',
    wrongProductionDetectedAt: '2026-07-14T02:11:03.000Z',
    wrongProductionDetectedBy: 'ingest-anticipatory-gate',
    anticipatoryGateOutletCategory: 'broadsheet',
    anticipatoryGateDaysBeforeOpening: 9,
    wrongProductionProvenance: 'date',
    _wrongProductionDetectedBy: 'cleanup-dedup-comprehensive',
  };
  // A replacement-style write carries the old record forward and swaps the url,
  // which is the shape maybeUpgradeUrl / mergeReviews hand to the invariant.
  const merged = { ...existing, url: 'https://www.telegraph.co.uk/theatre/the-real-review/' };

  const { changed, cleared } = applyUrlChangeInvariant(existing, merged, { fileLabel: 'bro2740' });

  assert.equal(changed, true);
  assert.equal(merged.wrongProduction, undefined, 'flag must clear (pre-existing behaviour)');
  for (const f of [
    'wrongProductionReason', 'wrongProductionDetail', 'wrongProductionDetectedAt',
    'wrongProductionDetectedBy', 'anticipatoryGateOutletCategory',
    'anticipatoryGateDaysBeforeOpening', 'wrongProductionProvenance',
    '_wrongProductionDetectedBy',
  ]) {
    assert.equal(merged[f], undefined, `${f} must not outlive the flag it explains`);
    assert.ok(cleared.includes(f), `${f} must be recorded in the _urlChangedClear breadcrumb`);
  }
});

test('BRO-2740: a preserved Tour-transfer flag keeps its provenance', () => {
  // Mirror-image orphan: when the carve-out preserves the FLAG, deleting the
  // reason it was set would strand a flag no auditor can explain.
  const existing = {
    url: 'https://www.example.com/tour-leg-review/',
    publishDate: '2025-11-02',
    wrongProduction: true,
    wrongProductionNote: 'Tour transfer — reviewed on the pre-Broadway leg',
    wrongProductionDetail: 'Cleveland tryout, not the Broadway run',
    wrongProductionDetectedBy: 'auto-triage-cross-production',
    wrongProductionProvenance: 'manual',
  };
  const merged = { ...existing, url: 'https://www.example.com/tour-leg-review-amp/', publishDate: '2025-11-02' };

  applyUrlChangeInvariant(existing, merged, { fileLabel: 'bro2740-tour', force: true });

  assert.equal(merged.wrongProduction, true, 'Tour transfer flag survives (pre-existing behaviour)');
  assert.equal(merged.wrongProductionNote, existing.wrongProductionNote);
  assert.equal(merged.wrongProductionDetail, existing.wrongProductionDetail,
    'provenance must survive alongside a preserved flag');
  assert.equal(merged.wrongProductionDetectedBy, existing.wrongProductionDetectedBy);
  assert.equal(merged.wrongProductionProvenance, 'manual');
});

test('BRO-2740: human-decision fields are NOT treated as provenance', () => {
  // A human's clear stays valid across a URL change. Regression guard against
  // widening WRONG_PRODUCTION_PROVENANCE_FIELDS into the decision family.
  const { WRONG_PRODUCTION_PROVENANCE_FIELDS } = require('./wrongproduction-provenance.js');
  for (const f of [
    'wrongProductionManualClear', 'humanReviewedWrongProduction',
    'wrongProductionOverride', 'wrongProductionAutoCleared',
    'wrongProductionAutoClearedAt',
  ]) {
    assert.ok(!WRONG_PRODUCTION_PROVENANCE_FIELDS.includes(f),
      `${f} is a decision/outcome field, not flag provenance`);
  }
});

test('BRO-2740: both clear paths source the same provenance list', () => {
  // The drift that produced this bug class was two hand-maintained triples.
  const { WRONG_PRODUCTION_PROVENANCE_FIELDS } = require('./wrongproduction-provenance.js');
  const { REPLACE_CLEAR_FIELDS } = require('./wrongprod-replacement-preserve.js');
  const { URL_DERIVED_FIELDS } = require('./url-change-invariant.js');
  for (const f of WRONG_PRODUCTION_PROVENANCE_FIELDS) {
    assert.ok(REPLACE_CLEAR_FIELDS.has(f), `${f} missing from REPLACE_CLEAR_FIELDS`);
    assert.ok(URL_DERIVED_FIELDS.includes(f), `${f} missing from URL_DERIVED_FIELDS`);
  }
});

test('BRO-2740: re-stamped provenance is cleared with the flag, not kept as a "fresh" value', () => {
  // The hole the first cut of this fix left, found by review. The loop only
  // deletes a field whose post-merge value is IDENTICAL to the on-disk one, and
  // collect-review-texts.js:4401 re-stamps wrongProductionDetectedAt with
  // new Date().toISOString() on every pass — so its value ALWAYS differs and it
  // always survived, while wrongProduction (true on both sides) was deleted.
  const existing = {
    url: 'https://www.example.com/old-article/',
    wrongProduction: true,
    wrongProductionReason: 'anticipatory_pre_opening_post',
    wrongProductionDetail: 'Published 9 days before opening night',
    wrongProductionDetectedAt: '2026-07-14T02:11:03.000Z',
    wrongProductionDetectedBy: 'ingest-anticipatory-gate',
    anticipatoryGateDaysBeforeOpening: 9,
  };
  const merged = {
    ...existing,
    url: 'https://www.example.com/the-real-review/',
    // Same detector, re-run: different timestamp, different day count.
    wrongProductionDetectedAt: '2026-09-02T18:00:00.000Z',
    anticipatoryGateDaysBeforeOpening: 4,
  };

  const { cleared } = applyUrlChangeInvariant(existing, merged, { fileLabel: 'bro2740-restamp' });

  const survivors = Object.keys(merged).filter((k) => /^_?wrongProduction|^anticipatoryGate/.test(k));
  assert.deepEqual(survivors, [], `no provenance may outlive the flag, got: ${survivors.join(',')}`);
  assert.ok(cleared.includes('wrongProductionDetectedAt'));
  assert.ok(cleared.includes('anticipatoryGateDaysBeforeOpening'));
});

test('BRO-2740: a genuinely NEW flag raised by the incoming write keeps its provenance', () => {
  // Guard against the second pass over-clearing: the record was not previously
  // flagged, so the flag standing after the loop describes the NEW url.
  const existing = { url: 'https://www.example.com/old-article/', fullText: 'old body' };
  const merged = {
    url: 'https://www.example.com/new-article/',
    fullText: 'new body',
    wrongProduction: true,
    wrongProductionDetail: 'Published 6 days before opening night',
    wrongProductionDetectedBy: 'ingest-anticipatory-gate',
  };

  applyUrlChangeInvariant(existing, merged, { fileLabel: 'bro2740-newflag' });

  assert.equal(merged.wrongProduction, true);
  assert.equal(merged.wrongProductionDetail, 'Published 6 days before opening night');
  assert.equal(merged.wrongProductionDetectedBy, 'ingest-anticipatory-gate');
});

test('BRO-2740: date-guard carve-out with a surviving publishDate keeps provenance too', () => {
  // The AUTO_DATE_WP_PREFIXES half of the carve-out (the Tour-transfer test
  // above covers MANUAL_WP_PREFIXES). A genuinely new publishDate arrives, so
  // the guard's basis survives and the rebuild re-evaluates it — provenance
  // must still be there when it does.
  const existing = {
    url: 'https://www.example.com/old-article/',
    publishDate: '2026-05-01',
    wrongProduction: true,
    wrongProductionNote: 'Pre-opening guard: published before opening night',
    wrongProductionDetail: 'Published 12 days before opening night',
    wrongProductionDetectedBy: 'ingest-anticipatory-gate',
  };
  const merged = { ...existing, url: 'https://www.example.com/new-article/', publishDate: '2026-06-20' };

  applyUrlChangeInvariant(existing, merged, { fileLabel: 'bro2740-dateguard' });

  assert.equal(merged.publishDate, '2026-06-20', 'a fresh date survives');
  assert.equal(merged.wrongProduction, true, 'guard survives while its date basis survives');
  assert.equal(merged.wrongProductionDetail, 'Published 12 days before opening night');
  assert.equal(merged.wrongProductionDetectedBy, 'ingest-anticipatory-gate');
});

/**
 * BRO-2877: these two tests pin the REASON-keyed preserve leg at
 * url-change-invariant.js:281 — `_reasonIsDateOnly(existing) && !publishDateWillClear
 * && mergedHasPublishDate`. Scope deliberately stated precisely: the fixture below
 * sets wrongProductionReason and NO wrongProductionNote, so `_noteStartsWith` is false
 * and the MANUAL leg (279) and the note-keyed AUTO_DATE leg (280) never fire here.
 * Leg 280 is covered by the "BRO-2740: date-guard carve-out" test above; killing 280
 * alone leaves both tests below green. Verified by mutation, not assumed.
 *
 * Why the leg needed pinning at all: it is unreachable from updateFileUrlWithInvariant,
 * whose `metadata` is only {urlDiscoveredAt, urlDiscoveryMethod}, so merged.publishDate
 * there ALWAYS equals existing.publishDate and !publishDateWillClear is never true. A
 * v33 crown handoff read exactly that and concluded the fix was dead code. It is not.
 * The leg is live from the OTHER production caller, gather-reviews.js:3496, which calls
 * applyUrlChangeInvariant(existingReview, replacement) with `replacement` built FRESH
 * from the newly-discovered URL and so able to carry a genuinely new publishDate.
 *
 * All THREE of leg 281's conjuncts are pinned, one test each, so it cannot be deleted
 * as dead nor weakened a conjunct at a time. Measured, per mutation:
 *   kill the whole leg              -> only the NEW-date test below fails
 *   drop only !publishDateWillClear -> only the CARRIED-date test below fails
 *   drop only mergedHasPublishDate  -> the DATELESS test below fails, AND two
 *                                      pre-existing BRO-2740 tests fail with it
 * So the middle conjunct is the one nothing else covers. The third is partly covered
 * already; the test below is still worth its lines because it is the only one that
 * states the dateless contract directly rather than catching it as a side effect,
 * and because the other two would not tell a reader WHICH conjunct they tripped.
 * Deleting the leg would silently re-clear wrongProduction on records whose date basis
 * is still live; weakening it would strand an unclearable flag on a dateless record,
 * the case the comment at lines 270-277 argues at length.
 *
 * These fixtures are hand-built, like every other test in this file. They mirror the
 * gather-reviews call in the field that matters (a fresh publishDate on a fresh URL);
 * they do not import gather-reviews.js, and they omit its
 * preserveFields: new Set(AGGREGATOR_FIELDS), which is inert here because
 * AGGREGATOR_FIELDS holds no publishDate or wrongProduction* key.
 */
const BRO2877_BASE = {
  url: 'https://old.example.com/review-a',
  publishDate: '2023-10-12',
  wrongProduction: true,
  wrongProductionReason: 'anticipatory_pre_opening_post',
  contentTier: 'complete',
};

test('BRO-2877: a genuinely NEW publishDate PRESERVES the date-based wrongProduction flag (leg 281)', () => {
  const existing = { ...BRO2877_BASE };
  const replacement = {
    ...BRO2877_BASE,
    url: 'https://new.example.com/review-b',
    publishDate: '2026-03-01',
  };

  const res = quiet(() => applyUrlChangeInvariant(existing, replacement, { fileLabel: 'bro-2877.json' }));

  assert.equal(replacement.wrongProduction, true,
    'a fresh publishDate gives the date-guard a live basis, so wrongProduction must survive the URL change');
  assert.equal(replacement.publishDate, '2026-03-01', 'the genuinely new date must not be cleared');
  assert.ok(!res.cleared.includes('wrongProduction'),
    `wrongProduction must not be cleared, got ${JSON.stringify(res.cleared)}`);
  assert.ok(!res.cleared.includes('publishDate'),
    `publishDate must not be cleared, got ${JSON.stringify(res.cleared)}`);
  // contentTier is NOT in WP_FIELDS, so the preserve leg must not rescue it: it is
  // ordinary old-URL-derived state and still clears. Asserted so the fixture field
  // is load-bearing rather than decorative.
  assert.ok(res.cleared.includes('contentTier'),
    `contentTier is not a WP field and must still clear, got ${JSON.stringify(res.cleared)}`);
});

test('BRO-2877: a CARRIED-OVER publishDate still clears the date-based wrongProduction flag (leg 281 must not over-preserve)', () => {
  const existing = { ...BRO2877_BASE };
  // The updateFileUrlWithInvariant shape: the same date carried across, only the URL moves.
  const merged = { ...BRO2877_BASE, url: 'https://new.example.com/review-b' };

  const res = quiet(() => applyUrlChangeInvariant(existing, merged, { fileLabel: 'bro-2877.json' }));

  assert.equal(merged.wrongProduction, undefined,
    'a date merely carried over from the old record is stale basis, so the flag clears with its URL (BRO-2740)');
  assert.ok(res.cleared.includes('wrongProduction'),
    `expected wrongProduction cleared, got ${JSON.stringify(res.cleared)}`);
  assert.ok(res.cleared.includes('publishDate'),
    `expected publishDate cleared, got ${JSON.stringify(res.cleared)}`);
});

// ── BRO-4128: maybeUpgradeUrl must not swap a scored paywall stub for a
// roundup page ──────────────────────────────────────────────────────────
//
// SERP discovery on the-last-ship-west-end-2026 found The Stage's own
// review-round-ups article and offered it to maybeUpgradeUrl as an
// "upgrade" for a paywalled thestage--unknown.json stub carrying a real
// originalScore (3/5, extracted from the outlet's stage-star-svg star
// markup). The stub has no fullText, which satisfies maybeUpgradeUrl's
// badContent check — that's the normal, permanent shape of a paywalled
// star-only review, not evidence the score is wrong. The swap replaced the
// url with the roundup page, and applyUrlChangeInvariant(force:true) wiped
// originalScore along with the rest of the old-url-derived state, dropping
// the show from 21 scored reviews to 20.
test('BRO-4128: maybeUpgradeUrl refuses to swap a scored paywall stub for a roundup page (The Stage / The Last Ship)', () => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-roundup-'));
  const showId = 'the-last-ship-west-end-2026';
  const fixture = {
    showId,
    outletId: 'thestage',
    outlet: 'The Stage',
    criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/the-last-ship-review-sting',
    source: 'gather-reviews',
    fullText: null,
    contentTier: 'stub',
    originalScore: '3',
    originalScoreSource: 'stage-star-svg',
    originalScoreNormalized: 60,
  };
  makeFixture(reviewTextsDir, showId, 'thestage--unknown.json', fixture);

  const result = quiet(() => createOrMergeReviewFile(showId, {
    outlet: 'The Stage',
    criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/review-round-ups/the-last-ship-starring-sting-review-round-up',
    source: 'serp-discovery',
    fields: {},
  }, { reviewTextsDir }));

  const after = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
  assert.equal(after.url, fixture.url, 'roundup-page candidate must be refused; original review url must survive');
  assert.equal(after.originalScore, '3', 'the real star score must survive — this is the BRO-4128 regression');
  assert.equal(after.originalScoreSource, 'stage-star-svg');
  assert.equal(after.urlCorrectedFrom, undefined, 'no swap should have been recorded at all');

  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});

test('BRO-4128: maybeUpgradeUrl refuses to swap ANY unflagged scored stub, not just roundup-URL-matched ones', () => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-scoreloss-'));
  const showId = 'the-last-ship-west-end-2026';
  const fixture = {
    showId,
    outletId: 'thestage',
    outlet: 'The Stage',
    criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/the-last-ship-review-sting',
    source: 'gather-reviews',
    fullText: null,
    contentTier: 'stub',
    originalScore: '3',
    originalScoreSource: 'stage-star-svg',
  };
  makeFixture(reviewTextsDir, showId, 'thestage--unknown.json', fixture);

  // A candidate that is NOT a recognized roundup-URL pattern, but would still
  // discard the real score on an unflagged file — the general score-loss
  // guard must catch this even when isRoundupUrl doesn't recognize the shape.
  const result = quiet(() => createOrMergeReviewFile(showId, {
    outlet: 'The Stage',
    criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/some-other-article-entirely',
    source: 'serp-discovery',
    fields: {},
  }, { reviewTextsDir }));

  const after = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
  assert.equal(after.url, fixture.url, 'swap that would discard originalScore on an unflagged file must be refused');
  assert.equal(after.originalScore, '3');

  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});

test('BRO-4128: maybeUpgradeUrl still allows a score-discarding swap when the existing file is already flagged wrong', () => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-flagged-swap-'));
  const showId = 'the-last-ship-west-end-2026';
  // Named critic (not "Unknown") and slugs sharing the "last-ship" token with
  // showTitle so this exercises ONLY the score-loss exemption under test —
  // an unresolved-critic wrongProduction record hits an unrelated, earlier
  // "flagged/rejected record" refusal in review-file-writer.js regardless of
  // maybeUpgradeUrl, and a slug with no shared token trips the pre-existing
  // cross-show guard (slugLooksLikeDifferentShow) instead.
  const fixture = {
    showId,
    outletId: 'thestage',
    outlet: 'The Stage',
    criticName: 'John Smith',
    url: 'https://www.thestage.co.uk/reviews/the-last-ship-wrong-production',
    source: 'gather-reviews',
    fullText: null,
    contentTier: 'stub',
    originalScore: '3',
    originalScoreSource: 'stage-star-svg',
    wrongProduction: true,
    wrongProductionReason: 'Pre-opening guard: dated before earliest known preview',
  };
  makeFixture(reviewTextsDir, showId, 'thestage--john-smith.json', fixture);

  const result = quiet(() => createOrMergeReviewFile(showId, {
    outlet: 'The Stage',
    criticName: 'John Smith',
    url: 'https://www.thestage.co.uk/reviews/the-last-ship-sting-review',
    source: 'serp-discovery',
    fields: {},
  }, { reviewTextsDir }));

  const after = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
  assert.equal(after.url, 'https://www.thestage.co.uk/reviews/the-last-ship-sting-review', 'a flagged file may still recover onto a fresh individual-review url');
  assert.equal(after.originalScore, undefined, 'the stale score describing the wrong-production article is discarded, as intended');

  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});

test('BRO-4128: the roundup-URL guard refuses the swap even when the existing stub carries NO score at all', () => {
  // Isolates guard #1 (roundup-URL predicate) from guard #2 (score-loss):
  // an unscored stub must still be refused a roundup-page url — a roundup
  // page can never be a genuine "upgrade" for an individual review,
  // independent of whether there's a score to lose.
  const { maybeUpgradeUrl } = require('./review-normalization.js');
  const existing = {
    outletId: 'thestage',
    url: 'https://www.thestage.co.uk/reviews/the-last-ship-broken-scrape',
    fullText: null,
    contentTier: 'stub',
  };
  const result = quiet(() => maybeUpgradeUrl(
    existing,
    'https://www.thestage.co.uk/review-round-ups/the-last-ship-starring-sting-review-round-up',
    'serp-discovery',
    { showTitle: 'The Last Ship' },
  ));
  assert.equal(result, false, 'roundup-page candidate must be refused even with nothing to lose');
  assert.equal(existing.url, 'https://www.thestage.co.uk/reviews/the-last-ship-broken-scrape');
});

test('BRO-4128: score-loss guard also covers wrongShow and duplicateOf, not just wrongProduction', () => {
  const { maybeUpgradeUrl } = require('./review-normalization.js');
  for (const flagField of ['wrongShow', 'duplicateOf']) {
    const existing = {
      outletId: 'thestage',
      url: 'https://www.thestage.co.uk/reviews/the-last-ship-flagged',
      fullText: null,
      contentTier: 'stub',
      originalScore: '3',
      [flagField]: true,
    };
    const result = quiet(() => maybeUpgradeUrl(
      existing,
      'https://www.thestage.co.uk/reviews/the-last-ship-sting-review',
      'serp-discovery',
      { showTitle: 'The Last Ship' },
    ));
    assert.equal(result, true, `${flagField}=true must still exempt the swap from the score-loss guard`);
  }
});

test('BRO-4128: score-loss guard also refuses on aggregatorStars, not just originalScore', () => {
  const { maybeUpgradeUrl } = require('./review-normalization.js');
  const existing = {
    outletId: 'thestage',
    url: 'https://www.thestage.co.uk/reviews/the-last-ship-broken-scrape',
    fullText: null,
    contentTier: 'stub',
    aggregatorStars: 4,
  };
  const result = quiet(() => maybeUpgradeUrl(
    existing,
    'https://www.thestage.co.uk/reviews/the-last-ship-sting-review',
    'serp-discovery',
    { showTitle: 'The Last Ship' },
  ));
  assert.equal(result, false, 'an aggregatorStars-only score must be protected the same as originalScore');
});

// ship-check/Codex adversarial finding: review-file-writer.js's field-merge
// loop runs BEFORE maybeUpgradeUrl, so a single incoming write that supplies
// BOTH a fresh score AND a fresh url for a previously-unscored stub would
// otherwise see its OWN incoming score reflected on existingData and refuse
// to also apply its own url — stranding the new score on the old url. The
// opts.preMergeScore snapshot (wired in review-file-writer.js's
// _mergeIntoExisting) fixes this: it tells the guard the score didn't exist
// before this write, so there's nothing stale to protect.
test('BRO-4128: opts.preMergeScore stops the guard from blocking a url paired with its OWN freshly-supplied score', () => {
  const { maybeUpgradeUrl } = require('./review-normalization.js');
  // Simulates existingData AFTER the caller's field-merge already planted the
  // incoming score (the exact shape review-file-writer.js hands in).
  const existing = {
    outletId: 'thestage',
    url: 'https://www.thestage.co.uk/reviews/the-last-ship-broken-scrape',
    fullText: null,
    contentTier: 'stub',
    originalScore: '4', // just planted by THIS write's own fields, not pre-existing
    originalScoreSource: 'stage-star-svg',
  };
  const result = quiet(() => maybeUpgradeUrl(
    existing,
    'https://www.thestage.co.uk/reviews/the-last-ship-sting-review',
    'serp-discovery',
    {
      showTitle: 'The Last Ship',
      preMergeScore: { originalScore: null, aggregatorStars: null }, // no score before this write
    },
  ));
  assert.equal(result, true, 'a score supplied by THIS SAME write must not block applying its own paired url');
});

test('BRO-4128: isRoundupUrl matches The Stage review-round-ups path directly', () => {
  const { isRoundupUrl } = require('./review-guards.js');
  const verdict = isRoundupUrl('https://www.thestage.co.uk/review-round-ups/the-last-ship-starring-sting-review-round-up');
  assert.equal(verdict.isRoundup, true);
});

test('BRO-2877: a DATELESS record clears the date-based wrongProduction flag (leg 281 mergedHasPublishDate conjunct)', () => {
  // Both records dateless. !publishDateWillClear is TRUE here (nothing clears, because
  // there was never a date), so without the mergedHasPublishDate conjunct the leg would
  // PRESERVE the flag — stranding a wrongProduction the rebuild's anticipatory
  // auto-clear can never lift, since that path needs a reviewDate to even enter. That
  // is the BRO-2740 contract the third conjunct exists to hold, and no other fixture in
  // this file pairs a date-only reason with an absent publishDate.
  const dateless = {
    url: 'https://old.example.com/review-a',
    wrongProduction: true,
    wrongProductionReason: 'anticipatory_pre_opening_post',
  };
  const existing = { ...dateless };
  const merged = { ...dateless, url: 'https://new.example.com/review-b' };

  const res = quiet(() => applyUrlChangeInvariant(existing, merged, { fileLabel: 'bro-2877.json' }));

  assert.equal(merged.wrongProduction, undefined,
    'a dateless record gives the date-derived verdict nothing to stand on, so the flag must clear with its URL');
  assert.ok(res.cleared.includes('wrongProduction'),
    `expected wrongProduction cleared on a dateless record, got ${JSON.stringify(res.cleared)}`);
});

test('flip-flop between a named non-review url and a review url resolves to the review, even over an AUTO pin', () => {
  const { safeWriteReview } = require('./review-write-guard.js');
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-invariant-flipflop-news-'));
  const showId = 'white-rabbit-test-fixture';
  const news = 'https://www.thestage.co.uk/news/some-unrelated-news-item';
  const review = 'https://www.thestage.co.uk/reviews/white-rabbit-red-rabbit-review';
  const target = makeFixture(reviewTextsDir, showId, 'thestage--dave-fargnoli.json', {
    showId, outletId: 'thestage', outlet: 'The Stage', criticName: 'Dave Fargnoli',
    url: news, source: 'show-score', contentTier: 'excerpt',
    urlVerified: true, urlVerifiedAuto: true, urlVerifiedNote: 'Auto-pinned: url flip-flopped (BRO-121)',
    _urlChangedClear: { from: review, to: news, at: '2026-08-01T00:00:00.000Z', cleared: [] },
  });
  quiet(() => safeWriteReview(target, { criticName: 'Dave Fargnoli', url: review, source: 'show-score' }));
  const after = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(after.url, review, 'the review url must win over a /news/ url');
  assert.equal(after.urlVerifiedAuto, undefined, 'the stale auto-pin must not carry over onto the new url');

  // A HUMAN pin is never overridden.
  const human = makeFixture(reviewTextsDir, showId, 'thestage--human.json', {
    showId, outletId: 'thestage', outlet: 'The Stage', criticName: 'Human Pin',
    url: news, source: 'show-score', urlVerified: true,
  });
  quiet(() => safeWriteReview(human, { criticName: 'Human Pin', url: review, source: 'show-score' }));
  assert.equal(JSON.parse(fs.readFileSync(human, 'utf8')).url, news);
  fs.rmSync(reviewTextsDir, { recursive: true, force: true });
});
