/**
 * BRO-3171: a page-structure star (Time Out SVG, London Theatre page data)
 * retires an "extraction-no-evidence-in-text" / "outlet publishes no rating"
 * clear instead of sitting next to it, and the retirement survives the
 * rebase restore and safeWriteReview. Real functions only (CLAUDE.md §15).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { setExtractedScore, isScoreClearSupersededBy } = require('../../scripts/lib/score-routing.js');
const { isIntentionalClear, safeWriteReview } = require('../../scripts/lib/review-write-guard.js');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');

const cleared = (reason) => ({
  showId: 'noises-off-west-end-2019', outletId: 'london-theatre', outlet: 'London Theatre',
  criticName: 'Marianka Swain', url: 'https://www.londontheatre.co.uk/reviews/noises-off-review',
  publishDate: '2019-01-17',
  originalScoreCleared: true, originalScoreClearedReason: reason,
});

test('a page-structure star retires a no-evidence / no-rating clear', () => {
  for (const reason of ['outlet-publishes-no-critic-rating (tier 1d)', 'extraction-no-evidence-in-text (tier 1.5, was 4/5)']) {
    const d = cleared(reason);
    setExtractedScore(d, { value: '4/5 stars', normalizedValue: 80, source: 'londontheatre-page-json' });
    assert.equal(d.originalScoreCleared, undefined, reason);
    assert.equal(d.originalScoreClearSupersededBy, 'londontheatre-page-json');
    assert.equal(d.originalScoreClearSupersededReason, reason);
    assert.equal(d.originalScore, '4/5 stars');
  }
});

test('a text-derived star, or a clear about whose star it is, is left for the rebuild to arbitrate', () => {
  const text = cleared('extraction-no-evidence-in-text (tier 1.5, was 4/5)');
  setExtractedScore(text, { value: '4/5', normalizedValue: 80, source: 'unicode-stars' });
  assert.equal(text.originalScoreCleared, true);
  for (const reason of ['aggregator-score-in-p0-slot (tier 1b)', 'card-396: wp-api-title grabbed wrong show star']) {
    assert.equal(isScoreClearSupersededBy(cleared(reason), 'timeout-svg-stars'), false, reason);
  }
});

test('the retirement survives the rebase restore and a later safeWriteReview', () => {
  const d = cleared('outlet-publishes-no-critic-rating (tier 1d)');
  setExtractedScore(d, { value: '4/5 stars', normalizedValue: 80, source: 'londontheatre-page-json' });
  assert.equal(isIntentionalClear('originalScoreCleared', d), true);
  assert.equal(isIntentionalClear('originalScoreClearedReason', d), true);
  assert.equal(isIntentionalClear('originalScoreCleared', cleared('x')), false, 'no supersession, no clear');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-clear-'));
  const file = path.join(dir, 'london-theatre--marianka-swain.json');
  fs.writeFileSync(file, JSON.stringify({ ...cleared('outlet-publishes-no-critic-rating (tier 1d)'), assignedScore: 70 }));
  safeWriteReview(file, { ...d, assignedScore: 70 });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.originalScoreCleared, undefined, 'the preserve pass did not resurrect the clear');
  assert.equal(onDisk.originalScore, '4/5 stars');
});

test('the rebuild then scores the star inside its band (stars are score bands)', () => {
  const before = { ...cleared('outlet-publishes-no-critic-rating (tier 1d)'), originalScore: '4/5 stars', originalScoreNormalized: 80, originalScoreSource: 'londontheatre-page-json', scoreSource: 'londontheatre-page-json', llmScore: { score: 95 } };
  const after = { ...before };
  delete after.originalScoreCleared;
  after.originalScoreClearSupersededBy = 'londontheatre-page-json';
  const r = getBestScore(after);
  assert.ok(r && r.score >= 71 && r.score <= 90, `4/5 lands in 71-90, got ${r && r.score}`);
  assert.notEqual((getBestScore(before) || {}).source, 'originalScore-priority0', 'the stale clear hid the star');
});

test('a retired score clear does not let a write skip the flagged-file strip', () => {
  const { preserveFlaggedFields } = require('../../scripts/lib/review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-sup-'));
  const filePath = path.join(dir, 'londontheatre--x.json');
  fs.writeFileSync(filePath, JSON.stringify({ url: 'https://a/x', wrongShow: true, wrongShowReason: 'other show' }));
  const out = preserveFlaggedFields(filePath, {
    url: 'https://a/x', publishDate: '2026-01-01', originalScore: '4/5',
    originalScoreClearSupersededBy: 'londontheatre-page-json',
  });
  assert.equal(out.publishDate, undefined, 'stripped like any write to a flagged file');
});

test('a stale retired copy cannot delete a later re-clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-sup-'));
  const filePath = path.join(dir, 'timeout-london--x.json');
  const retired = {
    showId: 'x', outletId: 'timeout-london', criticName: 'X', url: 'https://t/x',
    originalScore: '4/5', originalScoreNormalized: 80, originalScoreSource: 'timeout-svg-stars',
    originalScoreClearSupersededBy: 'timeout-svg-stars', originalScoreClearSupersededAt: '2026-10-12T00:00:00Z',
  };
  const stale = JSON.parse(JSON.stringify(retired));
  fs.writeFileSync(filePath, JSON.stringify({ ...retired, originalScore: null, originalScoreNormalized: null,
    originalScoreSource: null, originalScoreCleared: true, originalScoreClearedReason: 'human: other show' }));
  safeWriteReview(filePath, stale);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.originalScoreCleared, true, 'the re-clear survives');
  assert.equal(onDisk.originalScoreClearedReason, 'human: other show');
});
