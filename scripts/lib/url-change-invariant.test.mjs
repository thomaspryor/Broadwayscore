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
 * Both directions are pinned so leg 281 cannot be deleted as dead: killing it fails the
 * first test, and dropping only its `!publishDateWillClear` conjunct fails the second,
 * which nothing pre-existing catches. Deleting it would silently re-clear
 * wrongProduction on records whose date basis is still live.
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
