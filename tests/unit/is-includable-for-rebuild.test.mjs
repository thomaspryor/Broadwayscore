/**
 * Unit tests for isIncludableForRebuild from scripts/lib/review-guards.js.
 *
 * Each exclusion condition in the function is covered by at least one case.
 * Logic is require()'d from the lib — never copied (CLAUDE.md §15).
 *
 * Run: node --test tests/unit/is-includable-for-rebuild.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isIncludableForRebuild } = require('../../scripts/lib/review-guards');

const withText = { fullText: 'A real review.' };
const withAgg = { aggregatorStars: 4 };

describe('isIncludableForRebuild — null / falsy input', () => {
  it('returns false for null', () => {
    assert.strictEqual(isIncludableForRebuild(null), false);
  });

  it('returns false for undefined', () => {
    assert.strictEqual(isIncludableForRebuild(undefined), false);
  });
});

describe('isIncludableForRebuild — text / aggregator signal requirement', () => {
  it('returns false for empty object (no text, no aggregator signal)', () => {
    assert.strictEqual(isIncludableForRebuild({}), false);
  });

  it('returns true when fullText is present', () => {
    assert.strictEqual(isIncludableForRebuild({ fullText: 'Great show.' }), true);
  });

  it('returns false when fullText is whitespace only', () => {
    assert.strictEqual(isIncludableForRebuild({ fullText: '   ' }), false);
  });

  it('returns true when aggregatorStars is present (no fullText)', () => {
    assert.strictEqual(isIncludableForRebuild({ aggregatorStars: 3 }), true);
  });

  it('returns true when originalScore is 0 (0 is a valid score, != null)', () => {
    assert.strictEqual(isIncludableForRebuild({ originalScore: 0 }), true);
  });

  it('returns false when originalScore is null', () => {
    assert.strictEqual(isIncludableForRebuild({ originalScore: null }), false);
  });

  it('returns true when llmScore object present (no fullText)', () => {
    assert.strictEqual(isIncludableForRebuild({ llmScore: { score: 75 } }), true);
  });
});

describe('isIncludableForRebuild — wrongProduction', () => {
  it('returns false when wrongProduction: true (no overrides)', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, wrongProduction: true }), false);
  });

  it('returns true when wrongProduction: true + wrongProductionManualClear: true', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, wrongProduction: true, wrongProductionManualClear: true }),
      true
    );
  });

  it('returns true when wrongProduction: true + wrongProductionOverride: true', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, wrongProduction: true, wrongProductionOverride: true }),
      true
    );
  });

  it('returns true when wrongProduction: true + humanReviewedWrongProduction: false', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, wrongProduction: true, humanReviewedWrongProduction: false }),
      true
    );
  });

  it('returns false when wrongProduction: true + humanReviewedWrongProduction: true (not a clear)', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, wrongProduction: true, humanReviewedWrongProduction: true }),
      false
    );
  });
});

describe('isIncludableForRebuild — single-flag exclusions', () => {
  it('returns false when wrongShow: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, wrongShow: true }), false);
  });

  it('returns false when wrongAttribution: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, wrongAttribution: true }), false);
  });

  it('returns false when duplicateOf is a truthy string', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, duplicateOf: 'other.json' }), false);
  });

  it('returns false when isRoundupArticle: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, isRoundupArticle: true }), false);
  });

  it('returns false when isNonReview: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, isNonReview: true }), false);
  });

  // Blocked-URL mirror (JCS 2026-07-09: google-wrapped artsdesk URL + WET roundup
  // page were rebuild-dropped as skippedBlockedUrl, but this predicate counted them
  // includable, so check-review-count-drift reported them "suppressed" forever).
  it('returns false when url is a google.com/url redirect wrapper', () => {
    assert.strictEqual(isIncludableForRebuild({
      ...withText,
      url: 'https://www.google.com/url?q=https://theartsdesk.com/theatre/some-review&sa=D&source=editors',
    }), false);
  });

  it('returns false when url is a blocked aggregator domain (westendtheatre.com)', () => {
    assert.strictEqual(isIncludableForRebuild({
      ...withText,
      url: 'https://www.westendtheatre.com/359762/news/jesus-christ-superstar-reviews/',
    }), false);
  });

  it('returns true for a normal outlet review URL', () => {
    assert.strictEqual(isIncludableForRebuild({
      ...withText,
      url: 'https://theartsdesk.com/theatre/jesus-christ-superstar-london-palladium-review',
    }), true);
  });

  it('returns false when isNotReview: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, isNotReview: true }), false);
  });

  it('returns false when nonReviewFlag: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, nonReviewFlag: true }), false);
  });

  it('returns false when nonReviewContent: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, nonReviewContent: true }), false);
  });

  it('returns false when fabricatedEntry: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, fabricatedEntry: true }), false);
  });

  it('returns false when isSyndicatedDuplicate: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, isSyndicatedDuplicate: true }), false);
  });

  it('returns false when crossOutletDuplicate: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, crossOutletDuplicate: true }), false);
  });

  it('returns false when suspectedMisattribution: true', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, suspectedMisattribution: true }), false);
  });
});

describe('isIncludableForRebuild — contentVerification.wrongArticle', () => {
  it('returns false when wrongArticle: true + confidence: high', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        contentVerification: { wrongArticle: true, confidence: 'high' },
      }),
      false
    );
  });

  it('returns true when wrongArticle: true + confidence: low (low conf is not authoritative)', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        contentVerification: { wrongArticle: true, confidence: 'low' },
      }),
      true
    );
  });

  it('returns true when wrongArticle: false + confidence: high (wrongArticle not set)', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        contentVerification: { wrongArticle: false, confidence: 'high' },
      }),
      true
    );
  });
});

describe('isIncludableForRebuild — duplicateTextOf is intentionally not excluded', () => {
  it('returns true when duplicateTextOf is present and fullText is valid', () => {
    // rebuild keeps duplicateTextOf when the referenced entry is also excluded;
    // mirroring that precisely requires context this predicate does not have.
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, duplicateTextOf: 'other-review.json' }),
      true
    );
  });
});

describe('isIncludableForRebuild — aggregator-only signal', () => {
  it('returns true with only aggregatorStars (no text)', () => {
    assert.strictEqual(isIncludableForRebuild({ aggregatorStars: 5 }), true);
  });

  it('returns true with originalScore: 100 (no text)', () => {
    assert.strictEqual(isIncludableForRebuild({ originalScore: 100 }), true);
  });

  it('returns false with aggregatorStars but also wrongShow (agg signal does not override exclusions)', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withAgg, wrongShow: true }), false);
  });
});

describe('isIncludableForRebuild — garbage text flags (ship-check additions)', () => {
  it('returns false when rejectionReason is set (any truthy string)', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withText, rejectionReason: 'garbage_text' }), false);
  });

  it('returns false when rejectionReason is set even with aggregator signal', () => {
    assert.strictEqual(isIncludableForRebuild({ ...withAgg, rejectionReason: 'ocr_junk' }), false);
  });

  it('returns false when rejectedBy has 2+ entries', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, rejectedBy: ['llm1', 'llm2'] }),
      false
    );
  });

  it('returns true when rejectedBy has only 1 entry (rebuild threshold is ≥2)', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, rejectedBy: ['llm1'] }),
      true
    );
  });

  it('returns true when rejectedBy is empty array', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, rejectedBy: [] }),
      true
    );
  });
});

describe('isIncludableForRebuild — rejectedAt canonical signal', () => {
  it('returns false when rejectedAt is set and text was fetched before rejection', () => {
    // Regression test: Vulture FILM review of Hamlet (2026-04-20) — rejectionReason was
    // cleared by clear-failure-flags (text was long), so the legacy rejectionReason check
    // missed it. rejectedAt persists and is the canonical "excluded" signal.
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        rejectedAt: '2026-04-20T11:15:36.117Z',
        textFetchedAt: '2026-04-19T09:20:05.710Z',
      }),
      false
    );
  });

  it('returns false when rejectedAt is set and no textFetchedAt recorded', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, rejectedAt: '2026-04-20T11:15:36.117Z' }),
      false
    );
  });

  it('returns true when textFetchedAt is newer than rejectedAt (successful re-scrape)', () => {
    // Re-scrape brought in better content — collect-review-texts.js should have cleared
    // rejectedAt but only does so when rejectionReason is still set. This handles the leak.
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        rejectedAt: '2026-02-16T00:08:28.925Z',
        textFetchedAt: '2026-04-04T01:21:59.594Z',
      }),
      true
    );
  });

  // Notion 34b637c5-416f-81ff-a6d6-d453e7ed537c (2026-04-22):
  // rejectedAt guard must respect manual clears — mirrors the existing manual-clear
  // carve-outs on the wrongProduction guard (lines 1225-1230) and contentTier=invalid
  // guard (lines 1289-1296). Discovered when 4 audit B-class false-positive clears
  // stayed excluded because LLM ensemble had rejected them with wrong show-context.
  it('returns true when rejectedAt is set but wrongProductionManualClear: true', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        rejectedAt: '2026-04-20T11:15:36.117Z',
        rejectedBy: 'ensemble-scoreability-check',
        wrongProductionManualClear: true,
      }),
      true
    );
  });

  it('returns true when rejectedAt is set but humanReviewedWrongProduction: false', () => {
    // humanReviewedWrongProduction === false means "human verified this IS the correct production"
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        rejectedAt: '2026-04-20T11:15:36.117Z',
        rejectedBy: 'ensemble-scoreability-check',
        humanReviewedWrongProduction: false,
      }),
      true
    );
  });

  it('returns true when rejectedAt is set but wrongProductionOverride: true', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        rejectedAt: '2026-04-20T11:15:36.117Z',
        rejectedBy: 'ensemble-scoreability-check',
        wrongProductionOverride: true,
      }),
      true
    );
  });

  it('still excludes when rejectedAt is set and no manual-clear flags (Vulture Hamlet protection preserved)', () => {
    // Manual-clear carve-out must not weaken the existing guard for genuine rejections.
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        rejectedAt: '2026-04-20T11:15:36.117Z',
        rejectedBy: 'ensemble-scoreability-check',
        wrongProductionManualClear: false,
        humanReviewedWrongProduction: true,
      }),
      false
    );
  });
});

// Notion 34b637c5-416f-81ad-8afb-e39b9de9e926 continued (2026-04-23 ship-check):
// wrongShow guard must respect the same manual-clear flags as wrongProduction.
// Surfaced when the Giant (Mark Rosenblatt play) B-class file was re-rejected
// with wrong_show despite wrongProductionManualClear=true — LLM ensemble knew
// "Giant the musical" from training and mis-identified the Broadway play.
describe('isIncludableForRebuild — wrongShow manual-clear carve-out', () => {
  it('returns true when wrongShow: true but wrongProductionManualClear: true', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        wrongShow: true,
        wrongProductionManualClear: true,
      }),
      true
    );
  });

  it('returns true when wrongShow: true but humanReviewedWrongProduction: false', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        wrongShow: true,
        humanReviewedWrongProduction: false,
      }),
      true
    );
  });

  it('returns true when wrongShow: true but wrongShowManualClear: true', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        wrongShow: true,
        wrongShowManualClear: true,
      }),
      true
    );
  });

  it('returns true when wrongShow: true but wrongShowOverride: true', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        ...withText,
        wrongShow: true,
        wrongShowOverride: true,
      }),
      true
    );
  });

  it('still excludes when wrongShow: true and no manual-clear flags', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...withText, wrongShow: true }),
      false
    );
  });
});

describe('isIncludableForRebuild — fullTextWrongAuthor (ship-check additions)', () => {
  it('returns false when fullTextWrongAuthor: true and no excerpts', () => {
    // rebuild deletes fullText in memory and checks excerpts — on disk fullText still exists
    // so we must check excerpt fields, not fullText
    assert.strictEqual(
      isIncludableForRebuild({ fullText: 'Some text.', fullTextWrongAuthor: true }),
      false
    );
  });

  it('returns true when fullTextWrongAuthor: true but dtliExcerpt present', () => {
    assert.strictEqual(
      isIncludableForRebuild({ fullText: 'Some text.', fullTextWrongAuthor: true, dtliExcerpt: 'Great show' }),
      true
    );
  });

  it('returns true when fullTextWrongAuthor: true and bwwExcerpt present', () => {
    assert.strictEqual(
      isIncludableForRebuild({ fullText: 'Some text.', fullTextWrongAuthor: true, bwwExcerpt: 'Excellent' }),
      true
    );
  });

  it('returns false when fullTextWrongAuthor: true and originalScore exists but no excerpts (score alone does not save it)', () => {
    // rebuild explicitly checks excerpts, not aggregator score, in the fullTextWrongAuthor path
    assert.strictEqual(
      isIncludableForRebuild({ fullText: 'Some text.', fullTextWrongAuthor: true, originalScore: 85 }),
      false
    );
  });
});

// Pattern Card #1 (Notion 346637c5-416f-8154-9500-f09fd49e5a2a):
// isIncludableForRebuild must mirror the drift-checker exclusions at rebuild line 3158.
describe('isIncludableForRebuild — incompleteReason=wrong_content (Pattern Card #1)', () => {
  it('excludes when wrong_content + wrongShow still set (stale flag is correct)', () => {
    assert.strictEqual(
      isIncludableForRebuild({ fullText: 'Long review text here.', incompleteReason: 'wrong_content', wrongShow: true }),
      false
    );
  });

  it('excludes when wrong_content + wrongProduction still set', () => {
    assert.strictEqual(
      isIncludableForRebuild({ fullText: 'Long review text here.', incompleteReason: 'wrong_content', wrongProduction: true }),
      false
    );
  });

  it('excludes when wrong_content + no substantial text + no aggregator signal', () => {
    assert.strictEqual(
      isIncludableForRebuild({ incompleteReason: 'wrong_content' }),
      false
    );
  });

  it('allows through when wrong_content + wrongShow/wrongProduction cleared + substantial text', () => {
    // This is the key case: stale flag on a now-valid review.
    // clearFailureFlags() clears it proactively; but if it wasn't cleared,
    // isIncludableForRebuild should still allow it through when flags are clear.
    const longText = 'A'.repeat(250);
    assert.strictEqual(
      isIncludableForRebuild({ fullText: longText, incompleteReason: 'wrong_content', llmScore: { score: 80 } }),
      true
    );
  });

  it('allows through when wrong_content + aggregator signal present (no substantial text)', () => {
    assert.strictEqual(
      isIncludableForRebuild({ aggregatorStars: 4, incompleteReason: 'wrong_content' }),
      true
    );
  });
});

describe('isIncludableForRebuild — contentTier=invalid (Pattern Card #1)', () => {
  it('excludes when contentTier: invalid regardless of text or score', () => {
    assert.strictEqual(
      isIncludableForRebuild({ fullText: 'A review.', contentTier: 'invalid', llmScore: { score: 80 } }),
      false
    );
  });

  it('allows through when contentTier: complete', () => {
    assert.strictEqual(
      isIncludableForRebuild({ fullText: 'A review.', contentTier: 'complete' }),
      true
    );
  });
});

// WE star-extraction bug regression suite (2026-05-18)
// Covers the 4 pre-existing bugs surfaced by Phase B-WE rescore.
describe('isIncludableForRebuild — not_a_review + json-ld star exception (Bug 3 class)', () => {
  // Base object matching the Avenue Q / Independent / Chilton pattern:
  // LBO promo excerpt was scored as 'not_a_review', but Independent json-ld had '2/5 stars'.
  const bug3Base = {
    outletId: 'independent',
    originalScore: '2/5 stars',
    originalScoreNormalized: 40,
    originalScoreSource: 'json-ld',
    aggregatorStars: '2/5 stars',
    aggregatorStarsSource: 'json-ld',
    rejectionReason: 'not_a_review',
    rejectedAt: '2026-04-20T18:40:57.086Z',
    textFetchedAt: '2026-04-18T05:47:09.213Z',
    fullText: 'A real critical assessment of the show.',
  };

  it('allows inclusion: not_a_review + json-ld originalScore + known star outlet', () => {
    assert.strictEqual(isIncludableForRebuild(bug3Base), true);
  });

  it('blocks when rejectionReason is not_a_review but NO json-ld source', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...bug3Base, originalScoreSource: 'text-pattern', aggregatorStarsSource: undefined }),
      false
    );
  });

  it('blocks when rejectionReason is not_a_review + json-ld but outlet NOT in KNOWN_STAR_OUTLETS', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...bug3Base, outletId: 'some-unknown-outlet' }),
      false
    );
  });

  it('blocks when rejectionReason is garbage_text even with json-ld star (only not_a_review gets exception)', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...bug3Base, rejectionReason: 'garbage_text' }),
      false
    );
  });

  it('blocks when rejectionReason is wrong_production even with json-ld star', () => {
    assert.strictEqual(
      isIncludableForRebuild({ ...bug3Base, rejectionReason: 'wrong_production' }),
      false
    );
  });

  it('allows inclusion when rejectedAt set + not_a_review + json-ld star (rejectedAt exception)', () => {
    // textFetchedAt < rejectedAt so the re-fetch exception does not apply.
    // The json-ld exception must carry both the rejectionReason AND rejectedAt gates.
    assert.strictEqual(
      isIncludableForRebuild({
        ...bug3Base,
        rejectedAt: '2026-04-20T18:40:57.086Z',
        textFetchedAt: '2026-04-18T05:47:09.213Z', // before rejectedAt
      }),
      true
    );
  });
});

describe('isIncludableForRebuild — contamination regression (date-guard FP clear + roundup)', () => {
  // Regression for the 2026-05-29 contamination sweep: a date guard fired
  // wrongProduction against a stale/incorrect show closingDate (since
  // corrected). The reviews are legit (within 30d of opening, CV says correct
  // production). Clearing via wrongProductionManualClear must make them
  // includable again; an UNCLEARED date-guard flag must stay excluded.
  it('excludes an uncleared date-guard wrongProduction false positive', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        fullText: 'A real review of the production.',
        wrongProduction: true,
        wrongProductionNote: 'Date guard: review 2025-03-10 is 106d after 2024-11-17 (close+7d)',
        contentVerification: { wrongProduction: false },
      }),
      false
    );
  });

  it('includes the same review once wrongProductionManualClear clears it', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        fullText: 'A real review of the production.',
        wrongProduction: false,
        wrongProductionManualClear: true,
        wrongProductionReason: 'Date-guard false positive: stale closingDate since corrected.',
        contentVerification: { wrongProduction: false },
      }),
      true
    );
  });

  it('excludes a BWW Review-Roundup page flagged isRoundupArticle', () => {
    assert.strictEqual(
      isIncludableForRebuild({
        fullText: 'Critics weigh in on the new show...',
        isRoundupArticle: true,
        roundupArticleReason: 'manual: URL matches Review-Roundup pattern',
        url: 'https://www.broadwayworld.com/off-broadway/article/Review-Roundup-FOO-20260508',
      }),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Pre-opening temporal gate (isPrematureReviewForUnopenedShow)
// Benjamin Button OB incident, 2026-07-21: WET title-match attached 2023
// Southwark Playhouse reviews to the unopened 2026 Public Theater entry; the
// async wrongProduction classifier caught 3 of 5 and the 2 leaked reviews were
// scored, moving the show 67→78 in the daily digest.
// ---------------------------------------------------------------------------
const { isPrematureReviewForUnopenedShow } = require('../../scripts/lib/review-guards');

// Fixed "now" for deterministic tests: 2026-07-21T12:00:00Z
const NOW = Date.parse('2026-07-21T12:00:00Z');

describe('isPrematureReviewForUnopenedShow', () => {
  const bbShow = { status: 'announced', previewsStartDate: null, openingDate: null };
  const bbReview = { publishDate: '2023-06-09', fullText: 'London review.' };

  it('Benjamin Button case: 2023 review on dateless announced show → premature', () => {
    assert.strictEqual(isPrematureReviewForUnopenedShow(bbReview, bbShow, NOW), true);
  });

  it('fresh review on a dateless announced show is NOT premature (review-driven flip backstop)', () => {
    assert.strictEqual(
      isPrematureReviewForUnopenedShow({ publishDate: '2026-07-18' }, bbShow, NOW),
      false
    );
  });

  it('review 3 years before previewsStartDate on a previews show → premature', () => {
    assert.strictEqual(
      isPrematureReviewForUnopenedShow(
        { publishDate: '2023-06-09' },
        { status: 'previews', previewsStartDate: '2026-08-01' },
        NOW
      ),
      true
    );
  });

  it('review just before previews (within the 120-day lead) is NOT premature', () => {
    assert.strictEqual(
      isPrematureReviewForUnopenedShow(
        { publishDate: '2026-07-15' },
        { status: 'previews', previewsStartDate: '2026-08-01' },
        NOW
      ),
      false
    );
  });

  it('openingDate-only show: review 90d before opening (long preview period) is NOT premature', () => {
    assert.strictEqual(
      isPrematureReviewForUnopenedShow(
        { publishDate: '2026-07-03' },
        { status: 'previews', previewsStartDate: null, openingDate: '2026-10-01' },
        NOW
      ),
      false
    );
  });

  it('anchor is MIN of dates — inverted previewsStartDate cannot push the window later', () => {
    // previewsStartDate wrongly recorded AFTER openingDate; a review near the
    // (earlier) openingDate must not be excluded.
    assert.strictEqual(
      isPrematureReviewForUnopenedShow(
        { publishDate: '2026-07-01' },
        { status: 'previews', previewsStartDate: '2026-12-04', openingDate: '2026-08-22' },
        NOW
      ),
      false
    );
  });

  it('junk priorRuns entries without dates do NOT bypass the gate', () => {
    assert.strictEqual(
      isPrematureReviewForUnopenedShow(bbReview, { ...bbShow, priorRuns: [{}] }, NOW),
      true
    );
  });

  it('open / closed shows are never gated (unreliable historical publishDates)', () => {
    for (const status of ['open', 'closed']) {
      assert.strictEqual(
        isPrematureReviewForUnopenedShow(bbReview, { ...bbShow, status }, NOW),
        false
      );
    }
  });

  it('declared priorRuns bypasses the gate (returning productions)', () => {
    assert.strictEqual(
      isPrematureReviewForUnopenedShow(bbReview, { ...bbShow, priorRuns: [{ openingDate: '2023-05-01' }] }, NOW),
      false
    );
  });

  it('manual-clear / early-date overrides bypass the gate', () => {
    for (const override of [
      { wrongProductionManualClear: true },
      { wrongProductionOverride: true },
      { humanReviewedWrongProduction: false },
      { allowEarlyDate: true },
      { allowCrossMarket: true },
    ]) {
      assert.strictEqual(
        isPrematureReviewForUnopenedShow({ ...bbReview, ...override }, bbShow, NOW),
        false,
        `override ${JSON.stringify(override)} must bypass`
      );
    }
  });

  it('missing / unparseable publishDate is not judged', () => {
    assert.strictEqual(isPrematureReviewForUnopenedShow({ publishDate: null }, bbShow, NOW), false);
    assert.strictEqual(isPrematureReviewForUnopenedShow({ publishDate: 'garbage' }, bbShow, NOW), false);
  });

  it('missing show object is not judged', () => {
    assert.strictEqual(isPrematureReviewForUnopenedShow(bbReview, null, NOW), false);
    assert.strictEqual(isPrematureReviewForUnopenedShow(bbReview, undefined, NOW), false);
  });
});

describe('isIncludableForRebuild — pre-opening temporal gate integration', () => {
  it('excludes a years-early review filed under an unopened dated show', () => {
    assert.strictEqual(
      isIncludableForRebuild(
        { publishDate: '2023-06-09', fullText: 'London review of the 2023 run.' },
        { status: 'announced', openingDate: '2026-10-01' }
      ),
      false
    );
  });

  it('includes the same review when the show declares priorRuns', () => {
    assert.strictEqual(
      isIncludableForRebuild(
        { publishDate: '2023-06-09', fullText: 'London review of the 2023 run.' },
        { status: 'announced', openingDate: '2026-10-01', priorRuns: [{ openingDate: '2023-05-01' }] }
      ),
      true
    );
  });

  it('includes an in-window review on a previews show', () => {
    const nearNow = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    assert.strictEqual(
      isIncludableForRebuild(
        { publishDate: nearNow, fullText: 'Fresh previews review.' },
        { status: 'previews', previewsStartDate: nearNow }
      ),
      true
    );
  });
});
