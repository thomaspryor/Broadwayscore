/**
 * Unit tests for the aggregator-score-strip guard in safeWriteReview
 * (added 2026-05-25).
 *
 * Bug: gather-reviews.js / sweep-we-aggregators.js correctly write
 * `originalScore: null` when the review's score comes from an aggregator
 * (Show Score stars, Stagedoor stars, etc.). But safeWriteReview's merge
 * mode restored a stale `originalScore` value from the on-disk file,
 * re-introducing the contamination that validateAggregatorScoreContamination
 * fails CI on.
 *
 * The guard strips originalScore (and its derived fields) whenever
 * scoreSource is in AGGREGATOR_SCORE_SOURCES, regardless of merge state.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { safeWriteReview } = require('../../scripts/lib/review-write-guard');
const { AGGREGATOR_SCORE_SOURCES } = require('../../scripts/lib/review-normalization');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-score-strip-'));

describe('safeWriteReview — aggregator score contamination guard', () => {
  test('strips originalScore when scoreSource is stagedoor-star-rating', () => {
    const p = path.join(TMP, 'a.json');
    // Disk seeded with contaminated state
    fs.writeFileSync(p, JSON.stringify({
      url: 'https://example.com/r1', criticName: 'X', outletId: 'timeout',
      originalScore: '3/5 stars',
      originalScoreSource: 'stagedoor',
      originalScoreType: 'stars',
      originalScoreNormalized: 60,
      scoreSource: 'stagedoor-star-rating',
      aggregatorStars: '3/5 stars',
    }));
    // Scraper re-writes with originalScore=null (correct for aggregators)
    safeWriteReview(p, {
      url: 'https://example.com/r1', criticName: 'X', outletId: 'timeout',
      originalScore: null,
      scoreSource: 'stagedoor-star-rating',
      aggregatorStars: '3/5 stars',
    });
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(after.originalScore, null);
    assert.equal(after.originalScoreSource, null);
    assert.equal(after.originalScoreType, null);
    assert.equal(after.originalScoreNormalized, null);
    assert.equal(after.aggregatorStars, '3/5 stars');
    assert.equal(after.scoreSource, 'stagedoor-star-rating');
  });

  test('strips for every source in AGGREGATOR_SCORE_SOURCES', () => {
    let i = 0;
    for (const source of AGGREGATOR_SCORE_SOURCES) {
      const p = path.join(TMP, `s${i++}.json`);
      fs.writeFileSync(p, JSON.stringify({
        url: `https://example.com/r${i}`, criticName: 'X', outletId: 'timeout',
        originalScore: '4 stars', scoreSource: source, aggregatorStars: '4 stars',
      }));
      safeWriteReview(p, {
        url: `https://example.com/r${i}`, criticName: 'X', outletId: 'timeout',
        originalScore: null, scoreSource: source, aggregatorStars: '4 stars',
      });
      const after = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(after.originalScore, null, `source=${source} should have stripped originalScore`);
    }
  });

  test('preserves originalScore when scoreSource is a critic-text source (non-aggregator)', () => {
    const p = path.join(TMP, 'critic.json');
    fs.writeFileSync(p, JSON.stringify({
      url: 'https://example.com/r2', criticName: 'X', outletId: 'nytimes',
      originalScore: 'Critics Pick', scoreSource: 'critics-pick',
    }));
    safeWriteReview(p, {
      url: 'https://example.com/r2', criticName: 'X', outletId: 'nytimes',
      originalScore: 'Critics Pick', scoreSource: 'critics-pick',
    });
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    // critics-pick is NOT in AGGREGATOR_SCORE_SOURCES — originalScore must persist.
    assert.equal(after.originalScore, 'Critics Pick');
  });

  test('strips originalScore even when scraper omits it (merge would re-introduce)', () => {
    // This is the core failure mode: scraper writes a partial update that
    // doesn't include originalScore at all. Merge-mode pulls in the stale
    // contaminated value from disk. Guard must strip after merge.
    const p = path.join(TMP, 'omit.json');
    fs.writeFileSync(p, JSON.stringify({
      url: 'https://example.com/r3', criticName: 'X', outletId: 'timeout',
      originalScore: '3/5 stars',
      scoreSource: 'stagedoor-star-rating',
      aggregatorStars: '3/5 stars',
      // some other field a partial update preserves
      lastSeenAt: '2026-01-01',
    }));
    // Partial update — does NOT mention originalScore
    safeWriteReview(p, {
      url: 'https://example.com/r3',
      lastSeenAt: '2026-05-25',
    });
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(after.lastSeenAt, '2026-05-25', 'partial update field should persist');
    assert.equal(after.scoreSource, 'stagedoor-star-rating', 'scoreSource preserved by merge');
    assert.equal(after.aggregatorStars, '3/5 stars', 'aggregatorStars preserved by merge');
    assert.equal(after.originalScore, null, 'guard must strip the merged-back contaminated originalScore');
  });
});
