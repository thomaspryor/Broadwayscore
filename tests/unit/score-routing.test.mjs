/**
 * Score Routing — unit tests
 *
 * Locks in the invariant enforced by `scripts/lib/score-routing.js`:
 *
 *   If EITHER the incoming extraction's source OR the file's existing
 *   scoreSource is in AGGREGATOR_SCORE_SOURCES, the value belongs in
 *   `aggregatorStars` — never in `originalScore`.
 *
 * This is the canonical write path for ALL extracted ratings. The bug it
 * exists to prevent: validate-data.js fails when it finds files where
 * `scoreSource ∈ AGGREGATOR_SCORE_SOURCES && originalScore != null`.
 *
 * History: this same bug was patched script-by-script over 4 months
 * (5a8cc86e, 9d36edbe, 532606e9, c7006ad2, d46463cee, …) before being
 * centralized into score-routing.js. These tests prevent it from coming
 * back through any future writer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  AGGREGATOR_SCORE_SOURCES,
  isAggregatorScore,
  setExtractedScore,
  repairAggregatorContamination,
} = require('../../scripts/lib/score-routing');

describe('AGGREGATOR_SCORE_SOURCES', () => {
  test('contains all known aggregator star-rating sources', () => {
    // These are the sources validate-data.js treats as aggregators. If a new
    // aggregator is added, add it to scripts/lib/review-normalization.js AND
    // here so the validator and the writer helper agree.
    for (const source of [
      'show-score-stars',
      'lbo-star-rating',
      'lbo-css-stars',
      'theatre-reviews-star-rating',
      'westendtheatre-star-rating',
      'stagedoor-star-rating',
      'thestage-roundup-star-rating',
    ]) {
      assert.ok(
        AGGREGATOR_SCORE_SOURCES.has(source),
        `${source} must be in AGGREGATOR_SCORE_SOURCES`
      );
    }
  });

  test('does not contain non-aggregator outlet sources', () => {
    for (const source of [
      'guardian-api',
      'json-ld',
      'letter-grade',
      'wp-api-title',
      'wp-api-excerpt',
      'extracted-grade',
      'manual-stars',
    ]) {
      assert.ok(
        !AGGREGATOR_SCORE_SOURCES.has(source),
        `${source} must NOT be in AGGREGATOR_SCORE_SOURCES`
      );
    }
  });
});

describe('isAggregatorScore', () => {
  test('returns true when incoming source is an aggregator', () => {
    assert.strictEqual(isAggregatorScore('lbo-css-stars', 'guardian-api'), true);
  });

  test('returns true when existing scoreSource is an aggregator', () => {
    assert.strictEqual(isAggregatorScore('json-ld', 'lbo-css-stars'), true);
  });

  test('returns true when both are aggregators', () => {
    assert.strictEqual(isAggregatorScore('lbo-css-stars', 'show-score-stars'), true);
  });

  test('returns false when neither is an aggregator', () => {
    assert.strictEqual(isAggregatorScore('json-ld', 'guardian-api'), false);
  });

  test('returns false when both are missing', () => {
    assert.strictEqual(isAggregatorScore(null, undefined), false);
  });
});

describe('setExtractedScore', () => {
  test('routes non-aggregator → originalScore', () => {
    const data = { scoreSource: 'guardian-api' };
    const result = setExtractedScore(data, {
      value: '4/5 stars',
      normalizedValue: 80,
      source: 'json-ld',
    });
    assert.strictEqual(result.field, 'originalScore');
    assert.strictEqual(result.wasAggregator, false);
    assert.strictEqual(data.originalScore, '4/5 stars');
    assert.strictEqual(data.originalScoreNormalized, 80);
    assert.strictEqual(data.originalScoreSource, 'json-ld');
    assert.strictEqual(data.aggregatorStars, undefined);
  });

  test('routes aggregator-incoming → aggregatorStars', () => {
    const data = {};
    const result = setExtractedScore(data, {
      value: '4/5 stars',
      normalizedValue: 80,
      source: 'lbo-css-stars',
    });
    assert.strictEqual(result.field, 'aggregatorStars');
    assert.strictEqual(result.wasAggregator, true);
    assert.strictEqual(data.aggregatorStars, '4/5 stars');
    assert.strictEqual(data.aggregatorStarsNormalized, 80);
    assert.strictEqual(data.aggregatorStarsSource, 'lbo-css-stars');
    assert.strictEqual(data.originalScore, undefined);
  });

  test('routes non-aggregator-incoming on aggregator-tagged file → aggregatorStars', () => {
    // This is the regression case that broke high-noon and oliver in Apr 2026:
    // an extractor reported a non-aggregator source (e.g. 'json-ld') but the
    // file was already tagged with an aggregator scoreSource. The OLD code
    // checked only the incoming source and dumped the value into originalScore.
    const data = {
      scoreSource: 'lbo-css-stars',
      outletId: 'london-box-office',
    };
    const result = setExtractedScore(data, {
      value: '4/5 stars',
      normalizedValue: 80,
      source: 'json-ld',
    });
    assert.strictEqual(result.field, 'aggregatorStars');
    assert.strictEqual(result.wasAggregator, true);
    assert.strictEqual(data.aggregatorStars, '4/5 stars');
    assert.strictEqual(data.originalScore, undefined, 'must NOT contaminate originalScore');
    // The file's scoreSource must be preserved — the helper does not retag it.
    assert.strictEqual(data.scoreSource, 'lbo-css-stars');
  });

  test('does not touch other fields', () => {
    const data = {
      scoreSource: 'guardian-api',
      outletId: 'guardian',
      criticName: 'Arifa Akbar',
      fullText: 'A wonderful production…',
    };
    setExtractedScore(data, { value: 'B+', normalizedValue: 85, source: 'letter-grade' });
    assert.strictEqual(data.criticName, 'Arifa Akbar');
    assert.strictEqual(data.fullText, 'A wonderful production…');
  });

  test('throws if value or source is missing', () => {
    assert.throws(() =>
      setExtractedScore({}, { normalizedValue: 80, source: 'json-ld' })
    );
    assert.throws(() =>
      setExtractedScore({}, { value: '4/5', normalizedValue: 80 })
    );
  });
});

describe('repairAggregatorContamination', () => {
  test('repairs a contaminated file', () => {
    const data = {
      scoreSource: 'lbo-css-stars',
      originalScore: '4/5 stars',
      originalScoreNormalized: 80,
      originalScoreSource: 'lbo-css-stars',
      outletId: 'london-box-office',
    };
    const repaired = repairAggregatorContamination(data);
    assert.strictEqual(repaired, true);
    assert.strictEqual(data.originalScore, null);
    assert.strictEqual(data.originalScoreNormalized, null);
    assert.strictEqual(data.originalScoreSource, null);
    assert.strictEqual(data.aggregatorStars, '4/5 stars');
    assert.strictEqual(data.aggregatorStarsNormalized, 80);
    // scoreSource is preserved — that's the file's actual outlet/critic source.
    assert.strictEqual(data.scoreSource, 'lbo-css-stars');
  });

  test('does nothing on a clean file', () => {
    const data = {
      scoreSource: 'guardian-api',
      originalScore: '4/5 stars',
      originalScoreNormalized: 80,
    };
    const repaired = repairAggregatorContamination(data);
    assert.strictEqual(repaired, false);
    assert.strictEqual(data.originalScore, '4/5 stars');
    assert.strictEqual(data.aggregatorStars, undefined);
  });

  test('does not overwrite an existing aggregatorStars value', () => {
    const data = {
      scoreSource: 'lbo-css-stars',
      originalScore: '3/5 stars',
      aggregatorStars: '5/5 stars', // pre-existing — must not be clobbered
    };
    repairAggregatorContamination(data);
    assert.strictEqual(data.aggregatorStars, '5/5 stars');
    assert.strictEqual(data.originalScore, null);
  });
});

describe('writer-script lint guard', () => {
  // The whole point of score-routing.js is that ALL writers go through it.
  // This test enforces that the known-buggy writers import the helper.
  // If anyone refactors a writer back to a direct `data.originalScore = …`
  // assignment without using setExtractedScore, this test fails.

  const REQUIRED_USERS = [
    'scripts/extract-explicit-ratings.js',
    'scripts/recover-wayback-reviews.js',
    'scripts/recover-explicit-ratings.js',
    'scripts/retry-pending-scores.js',
    'scripts/recollect-for-scores.js',
    'scripts/extract-scores-from-archives.js',
    'scripts/extract-we-star-ratings.js',
    'scripts/verify-showscore-stars.js',
    'scripts/collect-review-texts.js',
    'scripts/collect-review-texts-v2.js',
  ];

  test('all known writers import score-routing', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const ROOT = join(import.meta.dirname, '..', '..');
    for (const rel of REQUIRED_USERS) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      assert.ok(
        src.includes("require('./lib/score-routing')") ||
          src.includes('require("./lib/score-routing")'),
        `${rel} must require('./lib/score-routing') — direct originalScore writes are forbidden`
      );
    }
  });
});
