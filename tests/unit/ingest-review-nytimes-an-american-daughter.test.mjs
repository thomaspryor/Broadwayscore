/**
 * BRO-332: T1/T2 silent gap on near-opening show: An American Daughter —
 * nytimes--laura-collins-hughes.json was auto-filed as a gap
 * (rejected-unscoreable) by the owner-alert-router.
 *
 * Investigation found the file was NOT actually a silent gap by the time
 * this card was triaged: it had already been re-fetched in full via
 * browserbase (textFetchedAt 2026-08-23) after an earlier stub-page
 * rejection (rejectedAt 2026-08-15) and a stale gemini non-review
 * misclassification (classifiedAt 2026-08-16) — both stale-flag exceptions
 * in scripts/lib/review-guards.js (rejectedAt's `reFetched` check and
 * isNonReviewDemotedByFreshCV's fresh-contentVerification check) already
 * let the canonical predicate include it, and it is present with a real
 * score in reviews.json / the show's composite score.
 *
 * This fixture pins that outcome so a future regression (e.g. a change to
 * either stale-flag exception) can't silently re-exclude this file, or any
 * file shaped like it, without failing CI.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyGapCardState, GAP_CARD_STATE } = require('../../scripts/lib/t1-silent-gap.js');
const { explainExclusion } = require('../../scripts/lib/review-guards.js');

const SHOW = {
  id: 'an-american-daughter-off-broadway-2026',
  category: 'off-broadway',
  status: 'open',
  openingDate: '2026-08-11',
};

// Trimmed fixture mirroring the real broadway-review-texts file's field
// values as of the 2026-09-08 investigation (fullText itself omitted —
// only its length/presence matters to the guards under test).
function buildFile(overrides = {}) {
  return {
    showId: 'an-american-daughter-off-broadway-2026',
    outletId: 'nytimes',
    outlet: 'The New York Times',
    criticName: 'Laura Collins-Hughes',
    url: 'https://www.nytimes.com/2026/08/13/theater/american-daughter-review-wendy-wasserstein.html',
    publishDate: '2026-08-13',
    fullText: 'x'.repeat(5000),
    isFullReview: true,
    assignedScore: 60,
    scoreSource: 'llm-v6',
    contentTier: 'complete',
    contentTierReason: 'Truncation detected: nyt_bot_stub',
    textWordCount: 844,
    textFetchedAt: '2026-08-23T10:03:22.093Z',
    textStatus: 'complete',
    sourceMethod: 'browserbase',
    contentVerification: {
      isValid: true,
      confidence: 'high',
      wrongArticle: false,
      articleType: 'review',
      articleTypeConfidence: 'high',
      verifiedAt: '2026-08-23T10:03:22.578Z',
    },
    rejectedAt: '2026-08-15T19:46:58.235Z',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReason: null,
    isNonReview: true,
    nonReviewType: 'feature',
    nonReviewClassifiedBy: 'gemini',
    classifiedAt: '2026-08-16T10:53:32.369Z',
    needsReview: true,
    needsReviewReason: 'Collector LLM: not a review (preview, high conf) but already scored — needs human verification',
    flaggedForReview: true,
    flagReason: "LLM verification: Content does not contain a critic's evaluation of the show.",
    ...overrides,
  };
}

describe('BRO-332: an-american-daughter nytimes gap is resolved, not a silent gap', () => {
  test('canonical predicate no longer excludes the file (stale rejectedAt + isNonReview both stale-cleared)', () => {
    const file = buildFile();
    assert.equal(explainExclusion(file, SHOW, undefined), null);
  });

  test('gap classifier reports COLLECTED regardless of outletScored (the file itself now carries a valid score)', () => {
    const file = buildFile();
    const now = new Date('2026-09-08T00:00:00Z');
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 1, outletScored: false, now }),
      GAP_CARD_STATE.COLLECTED,
    );
    assert.equal(
      classifyGapCardState({ file, show: SHOW, tier: 1, outletScored: true, now }),
      GAP_CARD_STATE.COLLECTED,
    );
  });

  test('regression guard: without the re-fetch (textFetchedAt before rejectedAt), the file would still be excluded', () => {
    // Confirms the fixture's COLLECTED state above is actually driven by the
    // re-fetch/fresh-CV exceptions, not an unrelated pass-through.
    const staleFile = buildFile({
      textFetchedAt: '2026-08-10T00:00:00Z',
      contentVerification: {
        ...buildFile().contentVerification,
        verifiedAt: '2026-08-10T00:00:00Z',
      },
    });
    // isNonReview is checked before rejectedAt in explainExclusion; either
    // way the file is excluded once its re-fetch/fresh-CV timestamps no
    // longer postdate the stale rejection/classification.
    assert.equal(explainExclusion(staleFile, SHOW, undefined), 'nonReview');
  });
});
