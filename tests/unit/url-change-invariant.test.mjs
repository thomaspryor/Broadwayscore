/**
 * Write-topology invariant: URL change must clear old-URL-derived state
 * (Notion 399637c5-416f-81fc).
 *
 * Replay fixture from the JCS Palladium incident (2026-07-08..10): the real
 * Telegraph/Guardian/Standard/FT reviews were merged IN PLACE into files still
 * carrying Hello Dolly state (wrongShow + manual reason, westEndTheatreExcerpt,
 * aggregatorStars, llmScore) from the URL each file used to hold — and were
 * suppressed. The invariant clears everything derived from the old URL, leaves
 * fresh incoming values and manual-clear fields alone, and records a durable
 * _urlChangedClear breadcrumb honored by isIntentionalClear() so CI
 * rebase-restores don't resurrect the cleared state.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { applyUrlChangeInvariant, urlCanonicallyChanged, URL_DERIVED_FIELDS } =
  require('../../scripts/lib/url-change-invariant');
const { safeWriteReview, isIntentionalClear } = require('../../scripts/lib/review-write-guard');
const { mergeReviews } = require('../../scripts/lib/review-normalization');

const DOLLY_URL = 'https://www.telegraph.co.uk/theatre/what-to-see/hello-dolly-imelda-staunton-palladium-review/';
const JCS_URL = 'https://www.telegraph.co.uk/theatre/what-to-see/jesus-christ-superstar-review/';

// The telegraph--dominic-cavendish state BEFORE the fix commit (2cf99135174),
// reconstructed to its pre-in-place-update shape: old Dolly URL + Dolly state.
function dollyContaminatedFile() {
  return {
    showId: 'jesus-christ-superstar-west-end-2026',
    outletId: 'telegraph',
    criticName: 'Dominic Cavendish',
    url: DOLLY_URL,
    fullText: 'Imelda Staunton is back where she belongs. Hello Dolly at the Palladium is a triumph of...',
    textWordCount: 1200,
    textStatus: 'complete',
    contentTier: 'complete',
    wrongShow: true,
    wrongShowReason: 'Manual: WET venue-page contamination — this is the Hello Dolly review',
    westEndTheatreExcerpt: 'Imelda Staunton is back where she belongs',
    aggregatorStars: '4/5',
    llmScore: { score: 75, confidence: 'high' },
    llmMetadata: { model: 'claude-x', scoredAt: '2026-07-07T00:00:00Z' },
    publishDate: '2024-07-01',
  };
}

describe('applyUrlChangeInvariant (pure)', () => {
  test('JCS replay: in-place URL update clears flags, excerpt, stars, score, old text; breadcrumb set', () => {
    const existing = dollyContaminatedFile();
    // Simulate what a merge produces when a writer updates url in place
    // without supplying fresh values: old state rides along.
    const merged = { ...existing, url: JCS_URL };
    const result = applyUrlChangeInvariant(existing, merged, { fileLabel: 'telegraph--dominic-cavendish.json' });

    assert.equal(result.changed, true);
    assert.equal(merged.wrongShow, undefined, 'wrongShow must not survive URL change');
    assert.equal(merged.wrongShowReason, undefined, 'manual wrongShowReason flags the URL, not the slot');
    assert.equal(merged.westEndTheatreExcerpt, undefined, 'stale WET excerpt must clear');
    assert.equal(merged.aggregatorStars, undefined, 'stale Dolly stars must clear');
    assert.equal(merged.llmScore, undefined, 'llmScore computed from Dolly content must clear');
    assert.equal(merged.llmMetadata, undefined);
    assert.equal(merged.fullText, undefined, 'old article text must clear');
    assert.equal(merged.contentTier, undefined);
    // Breadcrumb
    assert.ok(merged._urlChangedClear, 'breadcrumb field required (acceptance criterion)');
    assert.equal(merged._urlChangedClear.from, DOLLY_URL);
    assert.equal(merged._urlChangedClear.to, JCS_URL);
    assert.ok(merged._urlChangedClear.cleared.includes('wrongShow'));
    assert.ok(merged._urlChangedClear.cleared.includes('llmScore'));
    // Re-fetch signal for the collector
    assert.equal(merged.needsRefetch, true);
    assert.equal(merged.urlCorrectedFrom, DOLLY_URL);
  });

  test('fresh incoming values survive; only carried-over state clears', () => {
    const existing = dollyContaminatedFile();
    const merged = {
      ...existing,
      url: JCS_URL,
      fullText: 'The Palladium resurrection of Jesus Christ Superstar finds Judas centre stage...',
      westEndTheatreExcerpt: 'A thunderous, arena-scale resurrection',
      aggregatorStars: '3/5',
    };
    applyUrlChangeInvariant(existing, merged, {});
    assert.match(merged.fullText, /Judas/);
    assert.equal(merged.westEndTheatreExcerpt, 'A thunderous, arena-scale resurrection');
    assert.equal(merged.aggregatorStars, '3/5');
    assert.equal(merged.wrongShow, undefined);
    assert.equal(merged.needsRefetch, undefined, 'fresh text present — no refetch needed');
  });

  test('manual-clear and human-decision fields are never touched', () => {
    const existing = {
      ...dollyContaminatedFile(),
      wrongShowManualClear: true,
      wrongProductionManualClear: true,
      humanReviewScore: 80,
      allowEarlyDate: true,
    };
    const merged = { ...existing, url: JCS_URL };
    applyUrlChangeInvariant(existing, merged, {});
    assert.equal(merged.wrongShowManualClear, true);
    assert.equal(merged.wrongProductionManualClear, true);
    assert.equal(merged.humanReviewScore, 80);
    assert.equal(merged.allowEarlyDate, true);
  });

  test('normalization-only URL differences are NOT a change', () => {
    assert.equal(urlCanonicallyChanged(
      'http://www.telegraph.co.uk/theatre/x/',
      'https://telegraph.co.uk/theatre/x?utm_source=feed',
    ), false);
    const existing = dollyContaminatedFile();
    const merged = { ...existing, url: `${DOLLY_URL}?utm_source=rss` };
    const result = applyUrlChangeInvariant(existing, merged, {});
    assert.equal(result.changed, false);
    assert.equal(merged.wrongShow, true, 'same canonical URL — state untouched');
  });

  test('first-URL-set and broken-URL repair do not trigger', () => {
    assert.equal(urlCanonicallyChanged(undefined, JCS_URL), false);
    assert.equal(urlCanonicallyChanged('', JCS_URL), false);
    assert.equal(urlCanonicallyChanged('https://x.com/undefined/undefined', JCS_URL), false);
  });

  test('date-based wrongProduction flags are preserved across URL change', () => {
    const existing = {
      url: DOLLY_URL,
      wrongProduction: true,
      wrongProductionNote: 'Pre-opening guard: published 2026-06-01, opening 2026-07-08',
      llmScore: { score: 60 },
    };
    const merged = { ...existing, url: JCS_URL };
    applyUrlChangeInvariant(existing, merged, {});
    assert.equal(merged.wrongProduction, true, 'date-based flag keys on publishDate, not URL');
    assert.equal(merged.llmScore, undefined, 'non-WP fields still clear');
  });

  test('stale duplicateOf clears with duplicateClearReason breadcrumb', () => {
    const existing = {
      url: DOLLY_URL,
      duplicateOf: 'guardian--mark-lawson.json',
      duplicateReason: 'url-collision-detected-at-write',
    };
    const merged = { ...existing, url: JCS_URL };
    applyUrlChangeInvariant(existing, merged, {});
    assert.equal(merged.duplicateOf, undefined);
    assert.ok(merged.duplicateClearReason.includes('url changed'));
  });
});

describe('safeWriteReview integration', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-inv-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('replay: writing a new-URL stub onto a flagged file clears state despite PROTECTED preservation', () => {
    const filePath = path.join(tmpDir, 'telegraph--dominic-cavendish.json');
    fs.writeFileSync(filePath, JSON.stringify(dollyContaminatedFile(), null, 2));

    const result = safeWriteReview(filePath, {
      showId: 'jesus-christ-superstar-west-end-2026',
      outletId: 'telegraph',
      criticName: 'Dominic Cavendish',
      url: JCS_URL,
    });

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.url, JCS_URL);
    assert.equal(written.wrongShow, undefined);
    assert.equal(written.wrongShowReason, undefined);
    assert.equal(written.westEndTheatreExcerpt, undefined);
    assert.equal(written.aggregatorStars, undefined);
    assert.equal(written.llmScore, undefined);
    assert.equal(written.fullText, undefined);
    assert.ok(written._urlChangedClear);
    assert.equal(written._urlChangedClear.from, DOLLY_URL);
    // preserved[] must not claim fields the invariant then cleared
    for (const f of written._urlChangedClear.cleared) {
      assert.ok(!result.preserved.includes(f), `preserved[] still lists cleared field ${f}`);
    }
  });

  test('urlVerified blocks the URL change instead of clearing', () => {
    const filePath = path.join(tmpDir, 'verified.json');
    fs.writeFileSync(filePath, JSON.stringify({
      ...dollyContaminatedFile(), urlVerified: true,
    }, null, 2));
    safeWriteReview(filePath, { outletId: 'telegraph', url: JCS_URL });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.url, DOLLY_URL, 'verified URL must not be replaced without force');
    assert.equal(written.wrongShow, true, 'no URL change — no clearing');
  });

  test('_locked blocks the URL change', () => {
    const filePath = path.join(tmpDir, 'locked.json');
    fs.writeFileSync(filePath, JSON.stringify({
      ...dollyContaminatedFile(), _locked: true,
    }, null, 2));
    safeWriteReview(filePath, { outletId: 'telegraph', url: JCS_URL });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.url, DOLLY_URL);
  });
});

describe('mergeReviews integration (gather-reviews merge path)', () => {
  test('manual wrongShowReason no longer survives a different-URL merge', () => {
    const existing = dollyContaminatedFile();
    const merged = mergeReviews(existing, {
      url: JCS_URL,
      source: 'gather-reviews',
      publishDate: '2026-07-07',
    }, {}, { script: 'test', showId: 'jcs' });
    assert.equal(merged.url, JCS_URL);
    assert.equal(merged.wrongShow, undefined);
    assert.equal(merged.wrongShowReason, undefined);
    assert.equal(merged.llmScore, undefined);
    assert.equal(merged.publishDate, '2026-07-07');
    assert.ok(merged._urlChangedClear);
  });

  test('incoming shorter fullText replaces old-URL longer text on URL change', () => {
    const existing = dollyContaminatedFile();
    const merged = mergeReviews(existing, {
      url: JCS_URL,
      fullText: 'Short but real JCS review about Judas.',
    }, {}, {});
    assert.match(merged.fullText, /Judas/, 'fresh URL text beats old text regardless of length');
  });

  test('urlVerified still blocks URL change in mergeReviews', () => {
    const existing = { ...dollyContaminatedFile(), urlVerified: true };
    const merged = mergeReviews(existing, { url: JCS_URL }, {}, {});
    assert.equal(merged.url, DOLLY_URL);
    assert.equal(merged.wrongShow, true);
  });
});

describe('isIntentionalClear honors _urlChangedClear (rebase-restore durability)', () => {
  test('cleared fields are treated as intentional clears in the same URL era', () => {
    const local = {
      url: JCS_URL,
      _urlChangedClear: { from: DOLLY_URL, to: JCS_URL, at: '2026-07-10T00:00:00Z', cleared: ['wrongShow', 'llmScore', 'fullText'] },
    };
    assert.equal(isIntentionalClear('wrongShow', local), true);
    assert.equal(isIntentionalClear('llmScore', local), true);
    assert.equal(isIntentionalClear('fullText', local), true);
    assert.equal(isIntentionalClear('humanReviewScore', local), false, 'fields not in cleared[] are unaffected');
  });

  test('breadcrumb from an older URL era is not honored', () => {
    const local = {
      url: 'https://www.telegraph.co.uk/theatre/some-third-article/',
      _urlChangedClear: { from: DOLLY_URL, to: JCS_URL, cleared: ['wrongShow'] },
    };
    assert.equal(isIntentionalClear('wrongShow', local), false);
  });

  test('every URL_DERIVED_FIELD records into the breadcrumb shape isIntentionalClear reads', () => {
    // Guard against drift: any field the invariant can clear must be honorable.
    const local = {
      url: JCS_URL,
      _urlChangedClear: { from: DOLLY_URL, to: JCS_URL, cleared: [...URL_DERIVED_FIELDS] },
    };
    for (const f of URL_DERIVED_FIELDS) {
      assert.equal(isIntentionalClear(f, local), true, `isIntentionalClear must honor url-change clear of ${f}`);
    }
  });
});
