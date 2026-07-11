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
    assert.equal(merged.publishDate, undefined,
      'old article publishDate must clear — a stale date makes the rebuild date-guard re-flag the file');
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

  test('manual Tour-transfer wrongProduction is preserved; automatic date guards clear', () => {
    const tour = {
      url: DOLLY_URL,
      wrongProduction: true,
      wrongProductionNote: 'Tour transfer: flagged manually',
      llmScore: { score: 60 },
    };
    let merged = { ...tour, url: JCS_URL };
    applyUrlChangeInvariant(tour, merged, {});
    assert.equal(merged.wrongProduction, true, 'manual Tour transfer flag survives');
    assert.equal(merged.llmScore, undefined, 'non-WP fields still clear');

    // Automatic date guards were computed from the OLD article's publishDate,
    // which the invariant also clears — the rebuild re-derives them fresh.
    const dateGuard = {
      url: DOLLY_URL,
      publishDate: '2026-06-01',
      wrongProduction: true,
      wrongProductionNote: 'Pre-opening guard: published 2026-06-01, opening 2026-07-08',
    };
    merged = { ...dateGuard, url: JCS_URL };
    applyUrlChangeInvariant(dateGuard, merged, {});
    assert.equal(merged.wrongProduction, undefined, 'stale-date guard must clear with its stale basis');
    assert.equal(merged.publishDate, undefined);
  });

  test('auto date guard is preserved when a genuinely NEW publishDate survives', () => {
    // Clearing the flag while a date remains reds the validate-data
    // [wrong-production-by-date] gate until the next rebuild. With a fresh
    // date the rebuild re-evaluates the guard; the flag rides along until then.
    const existing = {
      url: DOLLY_URL,
      publishDate: '2023-10-12',
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2023-10-12 is 907d before 2026-05-11',
    };
    const merged = { ...existing, url: JCS_URL, publishDate: '2026-07-07' };
    applyUrlChangeInvariant(existing, merged, {});
    assert.equal(merged.publishDate, '2026-07-07', 'fresh date survives');
    assert.equal(merged.wrongProduction, true, 'flag preserved until rebuild re-evaluates the new date');
  });

  test('explicit publishDate:null counts as basis-gone — date guard clears, not strands', () => {
    // outlet-listing-poller writes publishDate:null; treating null as a
    // "fresh date" would preserve a Date-guard flag on a dateless record.
    const existing = {
      url: DOLLY_URL,
      publishDate: '2023-10-12',
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2023-10-12 is 907d before 2026-05-11',
    };
    const merged = { ...existing, url: JCS_URL, publishDate: null };
    applyUrlChangeInvariant(existing, merged, {});
    assert.equal(merged.publishDate, undefined);
    assert.equal(merged.wrongProduction, undefined, 'flag must clear with its vanished basis');
  });

  test('format-echoed publishDate clears together with its date guard', () => {
    const existing = {
      url: DOLLY_URL,
      publishDate: '2023-10-12',
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2023-10-12 is 907d before 2026-05-11',
    };
    // Aggregator re-supplies the SAME date in a different format — that's the
    // old article's date, not a fresh one.
    const merged = { ...existing, url: JCS_URL, publishDate: 'October 12, 2023' };
    applyUrlChangeInvariant(existing, merged, {});
    assert.equal(merged.publishDate, undefined, 'format-echoed stale date must clear');
    assert.equal(merged.wrongProduction, undefined, 'date guard clears with its basis');
    assert.ok(merged._urlChangedClear.cleared.includes('publishDate'));
  });

  test('garbage incoming URL never triggers a state wipe', () => {
    assert.equal(urlCanonicallyChanged(DOLLY_URL, 'https://x.com/undefined/review'), false);
    assert.equal(urlCanonicallyChanged(DOLLY_URL, 'N/A'), false);
    assert.equal(urlCanonicallyChanged(DOLLY_URL, '/relative/path'), false);
  });

  test('A→B→C hop chains the breadcrumb into the new era', () => {
    const URL_C = 'https://www.telegraph.co.uk/theatre/what-to-see/jcs-palladium-second-look/';
    // State after hop A→B: fields cleared, breadcrumb {to: B}.
    const afterHop1 = {
      url: JCS_URL,
      _urlChangedClear: { from: DOLLY_URL, to: JCS_URL, at: '2026-07-10T00:00:00Z', cleared: ['wrongShow', 'llmScore'] },
    };
    const merged = { ...afterHop1, url: URL_C };
    const result = applyUrlChangeInvariant(afterHop1, merged, {});
    assert.equal(result.changed, true, 'era must be re-stamped even when nothing new clears');
    assert.equal(merged._urlChangedClear.to, URL_C);
    assert.ok(merged._urlChangedClear.cleared.includes('wrongShow'),
      'hop-1 clears must carry into the new era or the push-restore resurrects them');
  });

  test('replacement-style writes record omitted URL-derived fields in the breadcrumb', () => {
    // gather-reviews' wrongShow replacement branch builds a FRESH record — old
    // flags are dropped by omission, not deleted. Without breadcrumb entries the
    // CI push-restore resurrects them from the committed state.
    const existing = dollyContaminatedFile();
    const replacement = {
      showId: existing.showId,
      outletId: 'telegraph',
      criticName: 'Dominic Cavendish',
      url: JCS_URL,
      bwwExcerpt: 'roundup excerpt keyed to the show',
    };
    const result = applyUrlChangeInvariant(existing, replacement, {
      preserveFields: new Set(['bwwExcerpt', 'bwwScore', 'dtliThumb']),
    });
    assert.equal(result.changed, true);
    assert.ok(replacement._urlChangedClear.cleared.includes('wrongShow'), 'omitted wrongShow must be in breadcrumb');
    assert.ok(replacement._urlChangedClear.cleared.includes('llmScore'), 'omitted llmScore must be in breadcrumb');
    assert.ok(!replacement._urlChangedClear.cleared.includes('bwwExcerpt'), 'preserveFields exempt from recording');
    assert.equal(replacement.bwwExcerpt, 'roundup excerpt keyed to the show');
    assert.equal(replacement.wrongShow, undefined);
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

  test('protocol-less variant of the same article never replaces the real url', () => {
    // 'telegraph.co.uk/x' normalizes EQUAL to 'https://telegraph.co.uk/x', so
    // a normalized-difference gate misses it — raw-string comparison must
    // reject it (ship-check 2026-07-11).
    const filePath = path.join(tmpDir, 'protocolless.json');
    fs.writeFileSync(filePath, JSON.stringify(dollyContaminatedFile(), null, 2));
    safeWriteReview(filePath, {
      outletId: 'telegraph',
      url: DOLLY_URL.replace(/^https:\/\//, ''),
    });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.url, DOLLY_URL, 'protocol-less garbage must not be written');
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

  test('same-era committed value is restorable (data-loss healing beats suppression)', () => {
    const local = {
      url: JCS_URL,
      _urlChangedClear: { from: DOLLY_URL, to: JCS_URL, cleared: ['fullText'] },
    };
    // Committed record from the OLD era → suppress the restore (resurrection).
    assert.equal(isIntentionalClear('fullText', local, { url: DOLLY_URL, fullText: 'Dolly text' }), true);
    // Committed record from the SAME era, PROVEN by its own matching breadcrumb
    // (a post-clear, post-refetch commit) → allow the restore; that empty local
    // fullText is real data loss, not the clear.
    assert.equal(isIntentionalClear('fullText', local, {
      url: JCS_URL,
      fullText: 'JCS text',
      _urlChangedClear: { from: DOLLY_URL, to: JCS_URL, cleared: ['fullText'] },
    }), false);
    // Frankenstein committed state: NEW url but no breadcrumb — produced by the
    // pre-invariant restores (url landed, clears didn't). Its field values may
    // be old-era contamination; the url match alone must NOT unlock restores.
    assert.equal(isIntentionalClear('fullText', local, { url: JCS_URL, fullText: 'Dolly text under JCS url' }), true);
  });

  test('gather replacement path: hop chaining works via the EXISTING record breadcrumb', () => {
    // gather's replacement builds a fresh record that never carries
    // _urlChangedClear forward — the chain must survive via existing's copy.
    const URL_C = 'https://www.telegraph.co.uk/theatre/what-to-see/jcs-palladium-second-look/';
    const existing = {
      url: JCS_URL,
      _urlChangedClear: { from: DOLLY_URL, to: JCS_URL, at: '2026-07-10T00:00:00Z', cleared: ['wrongShow', 'llmScore'] },
    };
    const replacement = { url: URL_C, outletId: 'telegraph' }; // fresh, no breadcrumb
    const result = applyUrlChangeInvariant(existing, replacement, {});
    assert.equal(result.changed, true);
    assert.ok(replacement._urlChangedClear.cleared.includes('wrongShow'),
      'hop-1 clears must chain via existing when the fresh record lacks the breadcrumb');
    assert.equal(replacement._urlChangedClear.to, URL_C);
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
