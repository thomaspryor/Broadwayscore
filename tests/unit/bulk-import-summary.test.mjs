/**
 * Unit tests for scripts/lib/bulk-import-summary.js.
 *
 * Per CLAUDE.md §15: logic is require()'d from the lib, never copied.
 *
 * Run: node --test tests/unit/bulk-import-summary.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { summarizeBulkImport, renderReport, EXPECT_ADD_TOLERANCE, MIN_REVIEWS_FOR_DISPLAY } = require('../../scripts/lib/bulk-import-summary');

const happy = (id, n = 5) => ({
  showId: id,
  reviewCount: n,
  unknownCriticCount: 0,
  hasValidPoster: true,
  wrongProductionAll: false,
  gatherError: null,
});

describe('summarizeBulkImport — partition correctness', () => {
  it('treats a healthy show as succeeded', () => {
    const r = summarizeBulkImport([happy('hamilton-2015', 8)]);
    assert.strictEqual(r.summary.succeeded, 1);
    assert.strictEqual(r.buckets.succeeded.length, 1);
    assert.strictEqual(r.buckets.thinReviews.length, 0);
  });

  it('routes thin-review show to thinReviews bucket', () => {
    const r = summarizeBulkImport([{ ...happy('thin-show'), reviewCount: 1 }]);
    assert.strictEqual(r.summary.thinReviews, 1);
    assert.strictEqual(r.buckets.thinReviews[0].showId, 'thin-show');
    assert.strictEqual(r.buckets.succeeded.length, 0);
  });

  it('routes missing-poster show to missingPoster bucket only when reviews are sufficient', () => {
    const r = summarizeBulkImport([{ ...happy('poster-fail'), hasValidPoster: false }]);
    assert.strictEqual(r.summary.missingPoster, 1);
    assert.strictEqual(r.buckets.missingPoster[0].showId, 'poster-fail');
  });

  it('routes 100%-wrongProduction show to allWrongProduction bucket', () => {
    const r = summarizeBulkImport([{ ...happy('dead-show'), wrongProductionAll: true }]);
    assert.strictEqual(r.summary.allWrongProduction, 1);
  });

  it('routes gather error to failedGather bucket regardless of other fields', () => {
    const r = summarizeBulkImport([
      { ...happy('errored'), gatherError: 'ScrapingBee 429', reviewCount: 5, hasValidPoster: true },
    ]);
    assert.strictEqual(r.summary.failedGather, 1);
    assert.strictEqual(r.buckets.failedGather[0].gatherError, 'ScrapingBee 429');
  });

  it('failure modes are mutually exclusive — a show appears in at most one of failedGather/allWrongProduction/thinReviews/missingPoster', () => {
    // gatherError takes priority over wrongProductionAll over thin reviews over missing poster
    const r = summarizeBulkImport([
      { ...happy('s1'), gatherError: 'err', wrongProductionAll: true, reviewCount: 0, hasValidPoster: false },
    ]);
    assert.strictEqual(r.summary.failedGather, 1);
    assert.strictEqual(r.summary.allWrongProduction, 0);
    assert.strictEqual(r.summary.thinReviews, 0);
    assert.strictEqual(r.summary.missingPoster, 0);
  });

  it('unknownCriticHotspots is orthogonal — a succeeded show can also be a hotspot', () => {
    const r = summarizeBulkImport([
      { ...happy('s1', 5), unknownCriticCount: 3 },
    ]);
    assert.strictEqual(r.summary.succeeded, 1);
    assert.strictEqual(r.summary.unknownCriticHotspots, 1);
    assert.strictEqual(r.buckets.unknownCriticHotspots[0].showId, 's1');
  });

  it('does NOT flag <2-unknown-critic shows as hotspots', () => {
    const r = summarizeBulkImport([
      { ...happy('s1', 5), unknownCriticCount: 1 },
    ]);
    assert.strictEqual(r.summary.unknownCriticHotspots, 0);
  });
});

describe('summarizeBulkImport — totals', () => {
  it('sums total reviews added across all shows', () => {
    const r = summarizeBulkImport([
      happy('s1', 5),
      happy('s2', 8),
      { ...happy('s3'), reviewCount: 0, gatherError: 'fail' },
    ]);
    assert.strictEqual(r.summary.totalReviewsAdded, 13);
  });

  it('sums total unknown critics across all shows', () => {
    const r = summarizeBulkImport([
      { ...happy('s1'), unknownCriticCount: 3 },
      { ...happy('s2'), unknownCriticCount: 0 },
      { ...happy('s3'), unknownCriticCount: 5 },
    ]);
    assert.strictEqual(r.summary.totalUnknownCritics, 8);
  });
});

describe('summarizeBulkImport — inverseDropAlert', () => {
  it('null when expectAdd is unset', () => {
    const r = summarizeBulkImport([happy('s1', 5)]);
    assert.strictEqual(r.inverseDropAlert, null);
  });

  it('null when actual matches expected', () => {
    const r = summarizeBulkImport([happy('s1', 100)], { expectAdd: 100 });
    assert.strictEqual(r.inverseDropAlert, null);
  });

  it('null when actual at threshold (70%)', () => {
    const r = summarizeBulkImport([happy('s1', 70)], { expectAdd: 100 });
    assert.strictEqual(r.inverseDropAlert, null);
  });

  it('alerts when actual below threshold', () => {
    const r = summarizeBulkImport([happy('s1', 60)], { expectAdd: 100 });
    assert.ok(r.inverseDropAlert, 'expected an alert');
    assert.strictEqual(r.inverseDropAlert.expected, 100);
    assert.strictEqual(r.inverseDropAlert.actual, 60);
    assert.strictEqual(r.inverseDropAlert.ratio, 0.6);
  });

  it('rounds ratio to 3 decimals for display', () => {
    const r = summarizeBulkImport([happy('s1', 33)], { expectAdd: 100 });
    assert.strictEqual(r.inverseDropAlert.ratio, 0.33);
  });
});

describe('summarizeBulkImport — input validation', () => {
  it('throws on non-array input', () => {
    assert.throws(() => summarizeBulkImport('not-an-array'), TypeError);
  });

  it('handles empty array', () => {
    const r = summarizeBulkImport([]);
    assert.strictEqual(r.summary.totalShows, 0);
    assert.strictEqual(r.summary.succeeded, 0);
    assert.strictEqual(r.inverseDropAlert, null);
  });

  it('skips entries missing showId', () => {
    const r = summarizeBulkImport([{ reviewCount: 5 }, happy('s1', 5)]);
    assert.strictEqual(r.summary.succeeded, 1);
  });
});

describe('renderReport', () => {
  it('produces a human-readable string with summary + failure bucket details', () => {
    const r = summarizeBulkImport([
      happy('hamilton-2015', 8),
      { ...happy('errored'), gatherError: 'timeout' },
    ]);
    const text = renderReport(r);
    assert.match(text, /BULK HISTORICAL IMPORT — SUMMARY/);
    assert.match(text, /Shows processed:\s+2/);
    assert.match(text, /Succeeded.*1/);
    assert.match(text, /Gather failures:\s+1/);
    // Failure-bucket action list names the show
    assert.match(text, /errored.*timeout/);
    // Succeeded shows aren't named individually — just counted (intentional —
    // operator only needs to act on failures)
  });

  it('shows the inverse-drop alert when present', () => {
    const r = summarizeBulkImport([happy('s1', 30)], { expectAdd: 100 });
    const text = renderReport(r);
    assert.match(text, /INVERSE-DROP ALERT/);
    assert.match(text, /30/);
    assert.match(text, /100/);
  });

  it('omits empty bucket action-lists (summary block always shows zero counts)', () => {
    const r = summarizeBulkImport([happy('s1', 5)]);
    const text = renderReport(r);
    // The action-list section headers (with parens explaining triage) only render
    // when the bucket has at least one item. The summary block at the top still
    // shows the count even when zero — that's intentional for at-a-glance reading.
    assert.doesNotMatch(text, /Failed gather \(RETRY\)/);
    assert.doesNotMatch(text, /DEAD SHOWS/);
  });
});

describe('exported constants are sensible', () => {
  it('EXPECT_ADD_TOLERANCE is between 0 and 1', () => {
    assert.ok(EXPECT_ADD_TOLERANCE > 0 && EXPECT_ADD_TOLERANCE < 1);
  });

  it('MIN_REVIEWS_FOR_DISPLAY matches scoring suppression threshold or is more permissive', () => {
    // Bulk-import success bar should be at most as strict as the scoring threshold (5).
    assert.ok(MIN_REVIEWS_FOR_DISPLAY <= 5);
  });
});
