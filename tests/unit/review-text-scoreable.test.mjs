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

// check-review-count-drift.js reads REVIEW_TEXTS_DIR from env at load time —
// point it at a fixture dir BEFORE the require so findSuppressedForShow scans it.
const DRIFT_FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-suppress-'));
process.env.REVIEW_TEXTS_DIR = DRIFT_FIXTURE;
const { findSuppressedForShow, isInOpeningWindow } = require(
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

// ----- drift script: suppression scan (redesigned 2026-07-11) -----
test('drift script: findSuppressedForShow catches the JCS class, ignores prior-production files', () => {
  // Show opening now; production window ≈ [previews-21d, opening+30d].
  const show = {
    id: 'jcs-we-2026',
    category: 'west-end',
    previewsStartDate: '2026-07-01',
    openingDate: '2026-07-07',
  };
  const showDir = path.join(DRIFT_FIXTURE, 'jcs-we-2026');
  fs.mkdirSync(showDir, { recursive: true });

  const files = {
    // Suppressed: scored, canonical-includable, published on opening night,
    // NOT matched in reviews.json — the JCS 2026-07-09 class.
    'timeout-london--andrzej-lukowski.json': {
      outletId: 'timeout-london', criticName: 'Andrzej Lukowski',
      publishDate: '2026-07-07', fullText: 'review body',
      llmScore: { score: 78 }, url: 'https://timeout.com/jcs-review',
    },
    // NOT suppressed: matched by filename key against reviews.json entries.
    'guardian--arifa-akbar.json': {
      outletId: 'guardian', criticName: 'Arifa Akbar',
      publishDate: '2026-07-07', fullText: 'review body',
      llmScore: { score: 81 }, url: 'https://theguardian.com/jcs',
    },
    // NOT suppressed: prior-production review — flags manually cleared so the
    // canonical predicate accepts it, but publishDate fails the production
    // window (the Beetlejuice-WE dailybeast-2019 false-positive class).
    'dailybeast--tim-teeman.json': {
      outletId: 'dailybeast', criticName: 'Tim Teeman',
      publishDate: '2019-04-26', fullText: 'broadway 2019 review',
      wrongProduction: true, humanReviewedWrongProduction: false,
      llmScore: { score: 70 }, url: 'https://thedailybeast.com/beetlejuice-2019',
    },
    // NOT suppressed: in-window but unscored (pending scoring, not suppression).
    'westendtheatre--pending.json': {
      outletId: 'westendtheatre', criticName: 'Pending Critic',
      publishDate: '2026-07-08', fullText: 'review body',
      url: 'https://westendtheatre.com/jcs',
    },
    // NOT suppressed: matched by URL even though the filename key differs.
    'standard--unknown.json': {
      outletId: 'standard', criticName: 'Unknown',
      publishDate: '2026-07-07', fullText: 'review body',
      llmScore: { score: 65 }, url: 'https://www.standard.co.uk/jcs-review/',
    },
  };
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(showDir, name), JSON.stringify(data));
  }

  const showReviews = [
    { showId: 'jcs-we-2026', outletId: 'guardian', criticName: 'Arifa Akbar', url: 'https://theguardian.com/jcs' },
    { showId: 'jcs-we-2026', outletId: 'standard', criticName: 'Nick Curtis', url: 'https://standard.co.uk/jcs-review' },
  ];

  const { suppressed, scanned } = findSuppressedForShow('jcs-we-2026', show, showReviews);
  assert.equal(scanned, 5);
  assert.deepEqual(suppressed.map((s) => s.file), ['timeout-london--andrzej-lukowski.json']);
});

test('drift script: isInOpeningWindow gates the scan to ±7d of opening', () => {
  const now = new Date('2026-07-10').getTime();
  assert.equal(isInOpeningWindow({ openingDate: '2026-07-07' }, now), true);
  assert.equal(isInOpeningWindow({ openingDate: '2026-07-16' }, now), true);
  assert.equal(isInOpeningWindow({ openingDate: '2026-06-01' }, now), false);
  assert.equal(isInOpeningWindow({ openingDate: null }, now), false);
  assert.equal(isInOpeningWindow(undefined, now), false);
});

test('drift script: findSuppressedForShow handles missing show dir gracefully', () => {
  const { suppressed, scanned } = findSuppressedForShow('__definitely-not-a-real-show__', undefined, []);
  assert.deepEqual(suppressed, []);
  assert.equal(scanned, 0);
});
