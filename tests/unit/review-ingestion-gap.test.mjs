/**
 * BRO-329: T1/T2 silent gap on "An American Daughter" —
 * data/review-texts/an-american-daughter-off-broadway-2026/nysr--david-finkle.json.
 *
 * Root cause: the NYSR "An American Daughter" article was ingested twice under
 * two different byline files (nysr--david-finkle.json and nysr--frank-scheck.json)
 * for the SAME url + identical fullText. Live fetch (2026-09-08) confirmed the
 * article is actually bylined Frank Scheck — "David Finkle" was a misattribution
 * (outlet-listing-poller source). A later contentVerification pass separately
 * (and wrongly — La Femme Theatre Productions IS the company staging this show
 * at Signature Center, not a different production) flagged the david-finkle
 * copy wrongProduction, which promoted it to isNonReview:true at rebuild time.
 * That got the file excluded from scoring, but for the WRONG, revisable reason.
 *
 * Why "excluded via isNonReview" isn't good enough: scripts/lib/flag-contradiction.js's
 * two stale-flag detectors (detectFlagContradiction, detectCvFlagContradiction)
 * only watch the top-level wrongProduction/wrongShow/isRoundupArticle flags — not
 * isNonReview — so a file excluded only via isNonReview sits outside the
 * pipeline's own staleness-monitoring, permanently invisible to future triage.
 * duplicateOf, by contrast, is a durable, correct exclusion: review-guards.js
 * excludes it via a dedicated 'duplicateOf' reason, and flag-contradiction.js's
 * module header explicitly documents duplicateOf as "OUT OF SCOPE... stays
 * flag-only" — i.e. it is never subject to (or needs) contradiction re-litigation.
 *
 * The fix: data/review-texts/.../nysr--david-finkle.json now carries
 * duplicateOf: "nysr--frank-scheck.json" (the correctly-attributed, already-scored
 * copy), which is the correct and stable terminal state.
 *
 * Run: node --test tests/unit/review-ingestion-gap.test.mjs
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isIncludableForRebuild, explainExclusion } = require('../../scripts/lib/review-guards.js');
const { detectFlagContradiction, detectCvFlagContradiction } = require('../../scripts/lib/flag-contradiction.js');

const SHOW = {
  id: 'an-american-daughter-off-broadway-2026',
  venue: 'The Irene Diamond Stage at the Pershing Square Signature Center',
  openingDate: '2026-08-11',
};

// Minimal fixture mirroring the real nysr--david-finkle.json BEFORE this fix
// (isNonReview promoted from a low-confidence wrongProduction CV verdict,
// no duplicateOf recorded yet).
const PRE_FIX_FIXTURE = {
  showId: SHOW.id,
  outletId: 'nysr',
  criticName: 'David Finkle',
  url: 'https://nystagereview.com/2026/08/11/an-american-daughter-wendy-wassersteins-play-shows-its-age/',
  fullText: 'x'.repeat(4780),
  textWordCount: 745,
  contentTier: 'complete',
  isNonReview: true,
  flaggedForReview: true,
  contentVerification: {
    isValid: false,
    confidence: 'low',
    wrongProduction: true,
    verifiedAt: '2026-09-07T10:02:08.917Z',
    verifiedBy: 'llm:claude-haiku',
  },
};

// The actual fix: duplicateOf pointing at the correctly-attributed, already-scored sibling.
const POST_FIX_FIXTURE = {
  ...PRE_FIX_FIXTURE,
  duplicateOf: 'nysr--frank-scheck.json',
  duplicateTextOf: 'nysr--frank-scheck.json',
};

describe('BRO-329: nysr--david-finkle.json duplicate exclusion', () => {
  test('both pre-fix and post-fix states are excluded from rebuild', () => {
    assert.equal(isIncludableForRebuild(PRE_FIX_FIXTURE, SHOW), false);
    assert.equal(isIncludableForRebuild(POST_FIX_FIXTURE, SHOW), false);
  });

  test('the fix changes the exclusion reason to the correct, durable one', () => {
    assert.equal(explainExclusion(PRE_FIX_FIXTURE, SHOW), 'nonReview');
    assert.equal(explainExclusion(POST_FIX_FIXTURE, SHOW), 'duplicateOf');
  });

  test('the pre-fix isNonReview exclusion is invisible to both stale-flag contradiction detectors', () => {
    // Neither detector inspects isNonReview — only top-level wrongProduction /
    // wrongShow / isRoundupArticle. This file's wrongProduction verdict lives
    // one level down, inside contentVerification, and was never copied to a
    // top-level flag — so even though the exclusion came from a low-confidence,
    // reversible LLM call, nothing in the pipeline would ever have flagged it
    // for re-triage. This is the actual "not legitimately excluded" bug BRO-329
    // reports: correctly excluded today, with no mechanism to catch it if wrong.
    assert.equal(detectFlagContradiction(PRE_FIX_FIXTURE), null);
    assert.equal(detectCvFlagContradiction(PRE_FIX_FIXTURE), null);
  });

  test('a comparable top-level wrongProduction flag WOULD have been caught (contrast case)', () => {
    // Proves the gap above is real and specific to isNonReview: the identical
    // CV verdict, if it had also stamped the top-level wrongProduction flag
    // fields the detectors actually watch, is exactly the shape
    // detectCvFlagContradiction is designed to surface.
    const withTopLevelFlag = {
      ...PRE_FIX_FIXTURE,
      wrongProduction: true,
      contentVerification: {
        ...PRE_FIX_FIXTURE.contentVerification,
        isValid: true,
        confidence: 'high',
        wrongProduction: false,
      },
    };
    assert.notEqual(detectCvFlagContradiction(withTopLevelFlag), null);
  });
});
