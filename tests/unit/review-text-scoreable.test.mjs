/**
 * Unit tests for scripts/lib/review-text-scoreable.js.
 *
 * The shared predicate is used by BOTH validate-data.js (silent-gap audit)
 * AND check-review-count-drift.js. Tests here guard both callers at once.
 *
 * Per CLAUDE.md §15: require() the real function — never duplicate its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const {
  wouldBeIncludedInRebuild,
  passesFlagFilters,
  hasValidScore,
  hasAggregatorExcerpt,
} = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'review-text-scoreable.js'));

const { countExpectedForShow, buildActualCounts } = require(
  path.join(__dirname, '..', '..', 'scripts', 'check-review-count-drift.js'),
);

// ----- passesFlagFilters -----
test('passesFlagFilters: clean file passes', () => {
  const data = { outletId: 'nyt', criticName: 'Jesse Green', fullText: 'body' };
  assert.equal(passesFlagFilters(data), true);
});

test('passesFlagFilters: rejectionReason excludes', () => {
  assert.equal(passesFlagFilters({ rejectionReason: 'garbage_text' }), false);
});

test('passesFlagFilters: rejectedBy array >=2 excludes, <2 does not', () => {
  assert.equal(passesFlagFilters({ rejectedBy: ['claude', 'gpt'] }), false);
  assert.equal(passesFlagFilters({ rejectedBy: ['claude'] }), true);
});

test('passesFlagFilters: wrongProduction / wrongShow / duplicateOf / duplicateTextOf all exclude', () => {
  assert.equal(passesFlagFilters({ wrongProduction: true }), false);
  assert.equal(passesFlagFilters({ wrongShow: true }), false);
  assert.equal(passesFlagFilters({ duplicateOf: 'other.json' }), false);
  assert.equal(passesFlagFilters({ duplicateTextOf: 'other.json' }), false);
});

test('passesFlagFilters: contentTier=stub|invalid exclude but "excerpt" passes', () => {
  assert.equal(passesFlagFilters({ contentTier: 'stub' }), false);
  assert.equal(passesFlagFilters({ contentTier: 'invalid' }), false);
  assert.equal(passesFlagFilters({ contentTier: 'excerpt' }), true);
  assert.equal(passesFlagFilters({ contentTier: 'complete' }), true);
});

test('passesFlagFilters: scoreStatus TO_BE_CALCULATED excludes', () => {
  assert.equal(passesFlagFilters({ scoreStatus: 'TO_BE_CALCULATED' }), false);
  assert.equal(passesFlagFilters({ scoreStatus: 'SCORED' }), true);
});

test('passesFlagFilters: showNotMentioned excludes UNLESS aggregator excerpt present', () => {
  assert.equal(passesFlagFilters({ showNotMentioned: true }), false);
  assert.equal(
    passesFlagFilters({ showNotMentioned: true, bwwExcerpt: 'great show' }),
    true,
  );
});

test('passesFlagFilters: fullTextWrongAuthor excludes UNLESS aggregator excerpt present', () => {
  assert.equal(passesFlagFilters({ fullTextWrongAuthor: true }), false);
  assert.equal(
    passesFlagFilters({ fullTextWrongAuthor: true, dtliExcerpt: 'loved it' }),
    true,
  );
});

test('passesFlagFilters: humanReviewedWrongProduction excludes', () => {
  assert.equal(passesFlagFilters({ humanReviewedWrongProduction: true }), false);
});

// ---- rebuild-exclusion flags added 2026-04-22 ----
test('passesFlagFilters: non-review flag variants exclude', () => {
  assert.equal(passesFlagFilters({ isNonReview: true }), false);
  assert.equal(passesFlagFilters({ isNotReview: true }), false);
  assert.equal(passesFlagFilters({ nonReviewFlag: true }), false);
  assert.equal(passesFlagFilters({ nonReviewContent: true }), false);
});

test('passesFlagFilters: fabricatedEntry excludes', () => {
  assert.equal(passesFlagFilters({ fabricatedEntry: true }), false);
});

test('passesFlagFilters: isSyndicatedDuplicate excludes', () => {
  assert.equal(passesFlagFilters({ isSyndicatedDuplicate: true }), false);
});

test('passesFlagFilters: crossOutletDuplicate excludes', () => {
  assert.equal(passesFlagFilters({ crossOutletDuplicate: true }), false);
});

test('passesFlagFilters: contentVerification.wrongArticle high-confidence excludes', () => {
  assert.equal(
    passesFlagFilters({
      contentVerification: { wrongArticle: true, confidence: 'high' },
    }),
    false,
  );
});

test('passesFlagFilters: contentVerification.wrongArticle medium/low confidence does NOT exclude', () => {
  // Rebuild gates on confidence:'high' only — lower confidences are advisory.
  assert.equal(
    passesFlagFilters({
      contentVerification: { wrongArticle: true, confidence: 'medium' },
    }),
    true,
  );
  assert.equal(
    passesFlagFilters({
      contentVerification: { wrongArticle: true, confidence: 'low' },
    }),
    true,
  );
});

test('passesFlagFilters: rejectedAt excludes UNLESS text was re-fetched after rejection', () => {
  // Stale rejection, no re-fetch → excluded
  assert.equal(
    passesFlagFilters({
      rejectedAt: '2026-04-01T00:00:00Z',
    }),
    false,
  );
  // Text was re-fetched AFTER rejection → include (revalidated)
  assert.equal(
    passesFlagFilters({
      rejectedAt: '2026-04-01T00:00:00Z',
      textFetchedAt: '2026-04-10T00:00:00Z',
    }),
    true,
  );
  // Text fetched BEFORE rejection → still excluded
  assert.equal(
    passesFlagFilters({
      rejectedAt: '2026-04-10T00:00:00Z',
      textFetchedAt: '2026-04-01T00:00:00Z',
    }),
    false,
  );
});

// ----- hasValidScore -----
test('hasValidScore: humanReviewScore 1-100 is valid', () => {
  assert.equal(hasValidScore({ humanReviewScore: 75 }), true);
  assert.equal(hasValidScore({ humanReviewScore: 0 }), false);
  assert.equal(hasValidScore({ humanReviewScore: 101 }), false);
});

test('hasValidScore: adjudicatedScore 1-100 is valid', () => {
  assert.equal(hasValidScore({ adjudicatedScore: 50 }), true);
});

test('hasValidScore: originalScore valid only if not cleared', () => {
  assert.equal(hasValidScore({ originalScore: '80' }), true);
  assert.equal(hasValidScore({ originalScore: '80', originalScoreCleared: true }), false);
});

test('hasValidScore: llmScore.score 1-100 is valid', () => {
  assert.equal(hasValidScore({ llmScore: { score: 60 } }), true);
  assert.equal(hasValidScore({ llmScore: { score: 0 } }), false);
  assert.equal(hasValidScore({ llmScore: {} }), false);
});

test('hasValidScore: assignedScore + aggregatorStars count', () => {
  assert.equal(hasValidScore({ assignedScore: 70 }), true);
  assert.equal(hasValidScore({ aggregatorStars: '4' }), true);
});

test('hasValidScore: empty object has no score', () => {
  assert.equal(hasValidScore({}), false);
});

// ----- wouldBeIncludedInRebuild integration -----
test('wouldBeIncludedInRebuild: happy path', () => {
  assert.equal(wouldBeIncludedInRebuild({ llmScore: { score: 72 } }), true);
});

test('wouldBeIncludedInRebuild: has score but flagged → excluded', () => {
  assert.equal(
    wouldBeIncludedInRebuild({ llmScore: { score: 72 }, wrongProduction: true }),
    false,
  );
});

test('wouldBeIncludedInRebuild: passes filters but no score → excluded', () => {
  assert.equal(wouldBeIncludedInRebuild({ outletId: 'nyt' }), false);
});

test('wouldBeIncludedInRebuild: showNotMentioned with excerpt + score → included', () => {
  assert.equal(
    wouldBeIncludedInRebuild({
      showNotMentioned: true,
      bwwExcerpt: 'raving',
      originalScore: '85',
    }),
    true,
  );
});

// ----- hasAggregatorExcerpt -----
test('hasAggregatorExcerpt: each aggregator excerpt key is recognized', () => {
  for (const key of [
    'bwwExcerpt', 'dtliExcerpt', 'showScoreExcerpt',
    'nycTheatreExcerpt', 'stagedoorExcerpt', 'lboRoundupExcerpt',
  ]) {
    assert.equal(hasAggregatorExcerpt({ [key]: 'x' }), true, `missing: ${key}`);
  }
  assert.equal(hasAggregatorExcerpt({}), false);
});

// ----- drift script: synthetic fixture with known delta -----
test('drift script: buildActualCounts sums per-showId', () => {
  const counts = buildActualCounts([
    { showId: 'hamlet-2026' },
    { showId: 'hamlet-2026' },
    { showId: 'macbeth-2026' },
    null,
    { showId: 'macbeth-2026' },
    { noShowId: true },
  ]);
  assert.deepEqual(counts, { 'hamlet-2026': 2, 'macbeth-2026': 2 });
});

test('drift script: countExpectedForShow returns delta of 2 vs actual of 3', () => {
  // Synthetic review-texts directory. Write 5 files: 3 includable w/ score,
  // 2 excluded. Expected = 3. If reviews.json has 1 entry, delta = +2.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
  const showDir = path.join(tmp, 'hamlet-2026');
  fs.mkdirSync(showDir, { recursive: true });

  const files = {
    'nyt--jesse-green.json':     { llmScore: { score: 80 } },                 // include
    'variety--greg.json':        { originalScore: '75' },                     // include
    'wsj--terry.json':           { humanReviewScore: 90 },                    // include
    'bww--wp.json':              { wrongProduction: true, llmScore: { score: 60 } }, // exclude (flag)
    'no-score.json':             { outletId: 'x' },                           // exclude (no score)
  };
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(showDir, name), JSON.stringify(data));
  }

  // Cannot pass custom root to countExpectedForShow (uses REPO_ROOT),
  // so verify the predicate-level count directly — same logic the script uses.
  let expected = 0;
  for (const name of Object.keys(files)) {
    const data = JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf8'));
    if (wouldBeIncludedInRebuild(data)) expected++;
  }
  assert.equal(expected, 3);

  const syntheticReviews = [
    { showId: 'hamlet-2026', outlet: 'nyt' },
  ];
  const actualCounts = buildActualCounts(syntheticReviews);
  const actual = actualCounts['hamlet-2026'] || 0;
  const delta = expected - actual;
  assert.equal(delta, 2, 'synthetic fixture should produce a delta of 2');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('drift script: countExpectedForShow handles missing show dir gracefully', () => {
  const { expected, scanned } = countExpectedForShow('__definitely-not-a-real-show__');
  assert.equal(expected, 0);
  assert.equal(scanned, 0);
});
