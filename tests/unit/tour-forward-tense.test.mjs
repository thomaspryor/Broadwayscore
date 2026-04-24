/**
 * Tour Forward-Tense Carve-Out
 *
 * A Broadway review that mentions "a national tour is planned" is NOT a tour
 * review — it's a Broadway review mentioning a future tour. The pre-fix guard
 * excluded these reviews, costing us real data on Beaches 2026-04-22 and
 * Rocky Horror 2026-04-23 opening nights.
 *
 * Postmortem #18: tighten excerpt/content guards to fire only on past-tense or
 * in-progress tour signals, with a forward-tense carve-out.
 *
 * Per CLAUDE.md §15, we require() the real functions — do not copy logic here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isTourReviewExcerpt, hasOnlyForwardTenseTourMention } =
  require('../../scripts/lib/excerpt-validation');
const { isNotBroadway } = require('../../scripts/lib/content-filters');

describe('tour forward-tense carve-out', () => {
  const forwardCases = [
    'A national tour is planned for 2027.',
    'An upcoming national tour will launch in fall 2026.',
    'A North American tour is scheduled to begin next year.',
    'Producers have announced a national tour.',
    'The show will tour in 2026.',
    'To embark on a national tour in 2026.',
    'Plans for a future tour are in the works.',
    // Edge cases added post-ship-check review (Session 4 P1):
    'A national tour planned for 2027.',                 // bare participle, no helper verb
    'The tour is launching next spring.',                // launching + time modifier
    'Tour announced today for a 2027 kickoff.',          // bare announced
    'The show will eventually tour North America.',      // will + adverb + tour
    'The tour starts tomorrow in Boston.',               // tour starts tomorrow
  ];

  const pastCases = [
    'I caught the national tour at the Pantages.',
    'The national tour opened in Chicago last week.',
    'This touring production has settled in at Cadillac Palace.',
    'The tour arrived at Kennedy Center.',
    'Currently on tour in North America.',
    'During its national tour, the show stopped in Boston.',
    'The touring company toured 20 cities.',
    'This touring production was seen in Chicago.',
    'The national tour opened in Chicago; a second national tour is planned.',
  ];

  for (const excerpt of forwardCases) {
    test(`forward-tense: ${excerpt}`, () => {
      const { isTourReview } = isTourReviewExcerpt(excerpt);
      assert.strictEqual(isTourReview, false,
        `expected forward-tense mention to pass, got isTourReview=true`);
      assert.strictEqual(hasOnlyForwardTenseTourMention(excerpt), true);
      assert.strictEqual(isNotBroadway(excerpt), false);
    });
  }

  for (const excerpt of pastCases) {
    test(`past-tense / in-progress: ${excerpt}`, () => {
      const { isTourReview } = isTourReviewExcerpt(excerpt);
      assert.strictEqual(isTourReview, true,
        `expected past-tense tour signal to fire, got isTourReview=false`);
    });
  }

  test('no tour mention is not flagged', () => {
    assert.strictEqual(
      isTourReviewExcerpt('A stunning Broadway revival at the Winter Garden.').isTourReview,
      false,
    );
  });
});
