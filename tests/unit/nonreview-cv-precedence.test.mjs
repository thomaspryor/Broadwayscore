/**
 * Unit tests for isNonReviewDemotedByFreshCV + its wiring into
 * isIncludableForRebuild (task #1255 — Telegraph-class stale isNonReview).
 *
 * Logic is require()'d from scripts/lib/review-guards.js — never copied
 * (CLAUDE.md §15).
 *
 * Run: node --test tests/unit/nonreview-cv-precedence.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNonReviewDemotedByFreshCV, isIncludableForRebuild } = require('../../scripts/lib/review-guards');

// Real-corpus snapshot: the-present-2017/wsj--edward-rothstein.json.
// gemini classified this a "preview" on 2026-03-25; a later claude-haiku
// contentVerification pass (2026-06-10) reads the full text and affirms it's
// a legitimate review, high confidence.
const BASE = {
  fullText: 'A real Broadway review of substantial length evaluating the production.',
  isNonReview: true,
  nonReviewType: 'preview',
  nonReviewClassifiedBy: 'gemini',
  classifiedAt: '2026-03-25T13:25:31.432Z',
  textFetchedAt: '2026-06-10T08:51:32.333Z',
  contentVerification: {
    isValid: true,
    confidence: 'high',
    wrongArticle: false,
    articleType: 'review',
    articleTypeConfidence: 'high',
    verifiedBy: 'llm:claude-haiku',
    verifiedAt: '2026-06-10T08:51:32.863Z',
  },
};

describe('isNonReviewDemotedByFreshCV — newer high-confidence CV demotes the flag', () => {
  it('returns true for the real-corpus stale-flag snapshot', () => {
    assert.equal(isNonReviewDemotedByFreshCV(BASE), true);
  });

  it('isIncludableForRebuild no longer excludes it as nonReview', () => {
    assert.equal(isIncludableForRebuild(BASE), true);
  });

  it('demotes even with zero classifier metadata (9-file corpus sub-shape)', () => {
    const noMetadata = { ...BASE, nonReviewType: undefined, nonReviewClassifiedBy: undefined, classifiedAt: undefined };
    assert.equal(isNonReviewDemotedByFreshCV(noMetadata), true);
  });
});

describe('isNonReviewDemotedByFreshCV — older CV does NOT demote the flag', () => {
  it('CV verifiedAt before classifiedAt: flag still wins', () => {
    const olderCv = {
      ...BASE,
      contentVerification: { ...BASE.contentVerification, verifiedAt: '2026-01-01T00:00:00.000Z' },
    };
    assert.equal(isNonReviewDemotedByFreshCV(olderCv), false);
    assert.equal(isIncludableForRebuild(olderCv), false);
  });

  it('CV verifiedAt exactly equal to classifiedAt: flag still wins (not strictly newer)', () => {
    const sameTime = {
      ...BASE,
      contentVerification: { ...BASE.contentVerification, verifiedAt: BASE.classifiedAt },
    };
    assert.equal(isNonReviewDemotedByFreshCV(sameTime), false);
  });
});

describe('isNonReviewDemotedByFreshCV — guard conditions', () => {
  it('no contentVerification block: flag still wins', () => {
    const noCv = { ...BASE, contentVerification: undefined };
    assert.equal(isNonReviewDemotedByFreshCV(noCv), false);
  });

  it('cv.isValid === false: flag still wins', () => {
    const invalid = { ...BASE, contentVerification: { ...BASE.contentVerification, isValid: false } };
    assert.equal(isNonReviewDemotedByFreshCV(invalid), false);
  });

  it('cv.wrongArticle === true: flag still wins', () => {
    const wrongArticle = { ...BASE, contentVerification: { ...BASE.contentVerification, wrongArticle: true } };
    assert.equal(isNonReviewDemotedByFreshCV(wrongArticle), false);
  });

  it("cv.articleType !== 'review': flag still wins", () => {
    const notReview = { ...BASE, contentVerification: { ...BASE.contentVerification, articleType: 'preview' } };
    assert.equal(isNonReviewDemotedByFreshCV(notReview), false);
  });

  it('cv confidence is medium (not high): flag still wins', () => {
    const medConf = {
      ...BASE,
      contentVerification: { ...BASE.contentVerification, articleTypeConfidence: 'medium', confidence: 'medium' },
    };
    assert.equal(isNonReviewDemotedByFreshCV(medConf), false);
  });

  it('cv has no verifiedAt: flag still wins', () => {
    const noVerifiedAt = { ...BASE, contentVerification: { ...BASE.contentVerification, verifiedAt: undefined } };
    assert.equal(isNonReviewDemotedByFreshCV(noVerifiedAt), false);
  });

  it('isNonReview !== true: not applicable (nothing to demote)', () => {
    assert.equal(isNonReviewDemotedByFreshCV({ ...BASE, isNonReview: false }), false);
    assert.equal(isNonReviewDemotedByFreshCV({ ...BASE, isNonReview: undefined }), false);
  });

  it('null/undefined data: returns false, does not throw', () => {
    assert.equal(isNonReviewDemotedByFreshCV(null), false);
    assert.equal(isNonReviewDemotedByFreshCV(undefined), false);
  });

  it('CV is stale against re-fetched text (textFetchedAt after verifiedAt): flag still wins', () => {
    const staleCv = { ...BASE, textFetchedAt: '2026-06-24T22:16:02.192Z' };
    assert.equal(isNonReviewDemotedByFreshCV(staleCv), false);
  });
});

describe('isNonReviewDemotedByFreshCV — CV-promoted provenance requires corroboration', () => {
  // rebuild-all-reviews.js's own CV-promotion pre-pass sets isNonReview from a
  // PAST contentVerification snapshot and never stamps classifiedAt. If the
  // file's contentVerification field is later overwritten by an unrelated
  // re-verify, there is no timestamp to prove the new CV postdates the one
  // that justified the promotion — recency alone can't be trusted here.
  const cvPromoted = {
    ...BASE,
    nonReviewType: undefined,
    nonReviewClassifiedBy: undefined,
    classifiedAt: undefined,
    isNonReviewReason: "CV-promoted (not a review): This is a preview article, not a review.",
    contentVerificationPromoted: 'rebuild: promoted from contentVerification (llm:claude-haiku, high)',
  };

  it('does NOT demote without independent ensemble corroboration', () => {
    assert.equal(isNonReviewDemotedByFreshCV(cvPromoted), false);
    assert.equal(isIncludableForRebuild(cvPromoted), false);
  });

  it('DOES demote when a high/medium-confidence ensemble score corroborates', () => {
    const corroborated = { ...cvPromoted, llmScore: { score: 67, confidence: 'medium' } };
    assert.equal(isNonReviewDemotedByFreshCV(corroborated), true);
  });
});

describe('isIncludableForRebuild — other nonReview flags are unaffected', () => {
  it('nonReviewFlag=true is still excluded even with a fresh affirming CV', () => {
    const otherFlag = { ...BASE, isNonReview: false, nonReviewFlag: true };
    assert.equal(isIncludableForRebuild(otherFlag), false);
  });

  it('nonReviewContent=true is still excluded even with a fresh affirming CV', () => {
    const otherFlag = { ...BASE, isNonReview: false, nonReviewContent: true };
    assert.equal(isIncludableForRebuild(otherFlag), false);
  });
});
