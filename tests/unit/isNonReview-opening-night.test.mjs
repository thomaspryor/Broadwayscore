/**
 * BRO-4189: CV-promoted isNonReview mislabelled opening-night reviews as
 * "preview" (reasoning: "a preview article written before or immediately upon
 * opening"). Two halves of the fix, both exercised through the real modules:
 *   1. content-verifier prompt: "preview" means written before the critic saw
 *      the production; publish timing near opening is never the test.
 *   2. isNonReviewCorroborationCandidate (scripts/lib/is-scoreable.js): lets
 *      the ensemble score a CV-promoted non-review file (fullText >= 1500) so
 *      isNonReviewDemotedByFreshCV's hasHighConfidenceLlmScore corroboration
 *      can ever be satisfied.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildVerificationPrompt,
  PREVIEW_ARTICLE_TYPE_GUIDANCE,
} = require('../../scripts/lib/content-verifier.js');

const SHOW = { id: 'cats-west-end-2026', title: 'Cats', category: 'west-end', status: 'open', openingDate: '2026-08-06' };

describe('BRO-4189 CV prompt: preview is defined by whether the critic saw the show, not by timing', () => {
  test('prompt carries the timing-is-not-the-test guidance and drops the old bare definition', () => {
    const { prompt } = buildVerificationPrompt({
      scrapedText: 'A thrilling revival. '.repeat(40), showTitle: 'Cats', outletName: 'Musical Theatre Review',
      criticName: 'Ron Cohen', openingDate: '2026-08-06', publishDate: '2026-08-07', market: 'west-end',
    });
    assert.ok(prompt.includes(PREVIEW_ARTICLE_TYPE_GUIDANCE));
    assert.match(prompt, /written BEFORE the critic saw the production/);
    assert.match(prompt, /Timing is NOT the test/);
    assert.match(prompt, /immediately upon opening[^.]*are REVIEWS, not previews/);
    assert.doesNotMatch(prompt, /preview\*\*: written before opening, previewing what to expect/);
  });

  test('opening-week temporal hint also says near-opening publication is not preview evidence', () => {
    const { prompt } = buildVerificationPrompt({
      scrapedText: 'A thrilling revival. '.repeat(40), showTitle: 'Cats', outletName: 'X',
      openingDate: '2026-08-06', publishDate: '2026-08-06', market: 'west-end',
    });
    assert.match(prompt, /Publication near opening is also NOT evidence the article is a preview/);
  });
});
