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
