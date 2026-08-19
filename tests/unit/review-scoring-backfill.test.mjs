/**
 * BRO-115: excerpt-only-unscored backfill candidate identification.
 *
 * Task #501 fixed isIncludableForRebuild() to recognize excerpt fields, not
 * just fullText — unlocking LLM-scoring eligibility for a corpus-wide backlog
 * of excerpt-only, unscored reviews. These tests pin the predicate
 * (scripts/lib/excerpt-backfill-eligibility.js) that identifies exactly that
 * cohort, composed from the same canonical gates the production scorer uses
 * (isScoreable, selectScorableText, isBlockedFromRescore) so it never flags a
 * file the scorer would not actually act on, or misses one it would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isExcerptOnlyBackfillCandidate } = require('../../scripts/lib/excerpt-backfill-eligibility.js');

// A believable excerpt bundle: well over the scorer's 50-char floor
// (scripts/lib/scorable-text.js DEFAULT_MIN_TEXT_LENGTH).
const REAL_EXCERPT = 'A blistering, funny production that never loses sight of its own melancholy heart.';

const baseFile = (over = {}) => ({
  showId: 'a-test-show-2026',
  outletId: 'bww',
  criticName: 'A Critic',
  fullText: null,
  bwwExcerpt: REAL_EXCERPT,
  aggregatorStars: '4/5',
  ...over,
});

test('flags an excerpt-only, unscored, includable review as a backfill candidate', () => {
  assert.equal(isExcerptOnlyBackfillCandidate(baseFile()), true);
});

test('excludes a review that already has an LLM score', () => {
  assert.equal(
    isExcerptOnlyBackfillCandidate(baseFile({ llmScore: { score: 70, bucket: 'Positive' } })),
    false
  );
});

test('excludes a review with real fullText — not excerpt-only', () => {
  assert.equal(
    isExcerptOnlyBackfillCandidate(baseFile({ fullText: 'A full review body that easily clears every length gate the scorer applies here today.' })),
    false
  );
});

test('excludes a review with no excerpt fields at all', () => {
  assert.equal(
    isExcerptOnlyBackfillCandidate(baseFile({ bwwExcerpt: undefined, aggregatorStars: undefined })),
    false
  );
});

test('excludes a review flagged wrongProduction — unrelated to the #501 fix', () => {
  assert.equal(
    isExcerptOnlyBackfillCandidate(baseFile({ wrongProduction: true })),
    false
  );
});

test('excludes a review flagged scraper_garbage — LLM-only extra gate in is-scoreable', () => {
  assert.equal(
    isExcerptOnlyBackfillCandidate(baseFile({ incompleteReason: 'scraper_garbage' })),
    false
  );
});

test('excludes a review with an excerpt bundle under the scorer\'s minimum text length', () => {
  assert.equal(
    isExcerptOnlyBackfillCandidate(baseFile({ bwwExcerpt: 'Good.' })),
    false
  );
});

test('excludes a review terminally blocked from rescore with an unchanged text fingerprint', () => {
  const file = baseFile({
    rescoreBlockedReason: 'input_validation_failed:body_too_short',
    rescoreBlockedTextLength: 0, // matches fullText:null -> ('' ).length === 0
    rescoreBlockedHadExcerpt: true, // matches hasExcerpt(file) === true
  });
  assert.equal(isExcerptOnlyBackfillCandidate(file), false);
});

test('a rescore-blocked review self-heals once its excerpt state changes since the block', () => {
  // Blocked when it had NO excerpt yet; an excerpt has since appeared —
  // isBlockedFromRescore must re-evaluate rather than trust the stale stamp.
  const file = baseFile({
    rescoreBlockedReason: 'input_validation_failed:body_too_short',
    rescoreBlockedTextLength: 0,
    rescoreBlockedHadExcerpt: false,
  });
  assert.equal(isExcerptOnlyBackfillCandidate(file), true);
});

test('excludes a review in manual-clear fallback cooldown — delegated gate, not reimplemented', () => {
  const file = baseFile({
    manualClearFallbackFailedAt: '2026-08-01T00:00:00.000Z',
    manualClearFallbackAbandoned: true, // never auto-retries
  });
  assert.equal(isExcerptOnlyBackfillCandidate(file), false);
});

test('excludes a review whose score is an authoritative manually-extracted star rating', () => {
  const file = baseFile({
    assignedScore: 80,
    scoreSource: 'manual_extracted_star_rating',
  });
  assert.equal(isExcerptOnlyBackfillCandidate(file), false);
});

test('returns false for null/undefined input', () => {
  assert.equal(isExcerptOnlyBackfillCandidate(null), false);
  assert.equal(isExcerptOnlyBackfillCandidate(undefined), false);
});
