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
