// Coverage Verdict S0 / task #893 — per-show merge for show-review-gap.json.
//
// The regression under test: a `--show=X` run used to overwrite the whole file
// from its single result, wiping every other show's audited state. That is what
// made newsletter-preflight report "review-completeness unverified" for every
// featured show the moment anyone ran the audit for one show.
//
// Run: node --test scripts/lib/gap-audit-merge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mergeGapAudit, countsFor, gapStateFor, stateMap } = require('./gap-audit-merge.js');

const result = (showId, over = {}) => ({
  showId,
  title: showId,
  aggregatorArticles: ['https://www.broadwayworld.com/article/Review-Roundup-X'],
  aggregatorListedUrls: [],
  missing: [],
  flaggedMisses: [],
  citedNoUrl: [],
  recoveryResults: [],
  ...over,
});
const runOf = (results, generatedAt = '2026-08-02T12:00:00.000Z') => ({ generatedAt, windowDays: 21, targets: results.length, results });

test('#893 repro: a single-show run no longer wipes the other shows', () => {
  const prev = mergeGapAudit(null, runOf(
    ['a-show', 'b-show', 'c-show'].map(id => result(id)),
    '2026-08-01T00:00:00.000Z'
  ));
  assert.strictEqual(prev.results.length, 3);

  // now the send-day `--show=b-show` run
  const after = mergeGapAudit(prev, runOf([result('b-show', { missing: [{ host: 'x.com', url: 'https://x.com/r' }] })]));
  assert.deepStrictEqual(after.results.map(r => r.showId), ['a-show', 'b-show', 'c-show']);
  assert.strictEqual(after.auditedThisRun, 1);
  assert.strictEqual(after.carriedForward, 2);
  // this run's entry wins for b-show
  assert.strictEqual(after.results.find(r => r.showId === 'b-show').missing.length, 1);
  // and the carried-forward entries keep their ORIGINAL stamp, not this run's
  assert.strictEqual(after.results.find(r => r.showId === 'a-show').computedAt, '2026-08-01T00:00:00.000Z');
  assert.strictEqual(after.results.find(r => r.showId === 'b-show').computedAt, '2026-08-02T12:00:00.000Z');
});

test('counts describe the merged file, not just the run', () => {
  const prev = mergeGapAudit(null, runOf([
    result('a-show', { missing: [{ host: 'x.com', url: 'https://x.com/1' }] }),
    result('b-show'),
  ], '2026-08-01T00:00:00.000Z'));
  assert.strictEqual(prev.counts.withGap, 1);
  assert.strictEqual(prev.counts.totalMissing, 1);

  const after = mergeGapAudit(prev, runOf([result('b-show', { citedNoUrl: [{ outletId: 'times-uk' }] })]));
  assert.strictEqual(after.counts.withGap, 2, 'a-show carries its gap forward into the file counts');
  assert.strictEqual(after.counts.totalMissing, 1);
  assert.strictEqual(after.counts.totalCitedNoUrl, 1);
});

test('a re-audit that CLEARS a gap replaces the stale entry (no zombie gaps)', () => {
  const prev = mergeGapAudit(null, runOf([result('a-show', { missing: [{ host: 'x.com', url: 'https://x.com/1' }] })], '2026-08-01T00:00:00.000Z'));
  assert.strictEqual(prev.counts.withGap, 1);
  const after = mergeGapAudit(prev, runOf([result('a-show')]));
  assert.strictEqual(after.results.length, 1);
  assert.strictEqual(after.counts.withGap, 0);
  assert.strictEqual(after.counts.totalMissing, 0);
});

test('carried-forward entries age out; this run’s entries never do', () => {
  const prev = mergeGapAudit(null, runOf([result('old-show'), result('fresh-show')], '2026-01-01T00:00:00.000Z'));
  const after = mergeGapAudit(prev, runOf([result('fresh-show')]), { retentionDays: 45 });
  assert.deepStrictEqual(after.results.map(r => r.showId), ['fresh-show'], 'old-show is >45d stale and pruned');
  assert.strictEqual(after.prunedStale, 1);

  // same inputs, generous retention → nothing pruned
  const kept = mergeGapAudit(prev, runOf([result('fresh-show')]), { retentionDays: 3650 });
  assert.deepStrictEqual(kept.results.map(r => r.showId), ['fresh-show', 'old-show']);
  assert.strictEqual(kept.prunedStale, 0);
});

test('a pre-#893 file (no per-result computedAt) is adopted, not discarded', () => {
  const legacy = { generatedAt: '2026-08-01T00:00:00.000Z', windowDays: 21, targets: 2, results: [result('a-show'), result('b-show')] };
  const after = mergeGapAudit(legacy, runOf([result('b-show')]));
  assert.strictEqual(after.results.length, 2);
  // a-show inherits the legacy file's generatedAt so it ages out normally
  assert.strictEqual(after.results.find(r => r.showId === 'a-show').computedAt, '2026-08-01T00:00:00.000Z');
});

test('a missing / unreadable previous file just means "nothing to carry"', () => {
  for (const prev of [null, undefined, {}, { results: null }, 'garbage']) {
    const after = mergeGapAudit(prev, runOf([result('a-show')]));
    assert.strictEqual(after.results.length, 1);
    assert.strictEqual(after.carriedForward, 0);
  }
});

test('gapStateFor: empty census is never "complete"', () => {
  assert.strictEqual(gapStateFor(result('a')), 'complete');
  assert.strictEqual(gapStateFor(result('a', { missing: [{ host: 'x.com' }] })), 'incomplete');
  assert.strictEqual(gapStateFor(result('a', { flaggedMisses: [{ url: 'u' }] })), 'incomplete');
  assert.strictEqual(gapStateFor(result('a', { citedNoUrl: [{ outletId: 'o' }] })), 'incomplete');
  // no aggregator reference at all == ignorance, not proof of coverage
  assert.strictEqual(gapStateFor(result('a', { aggregatorArticles: [], aggregatorListedUrls: [] })), 'no-census-yet');
  assert.strictEqual(gapStateFor(null), 'no-census-yet');
});

test('stateMap keys by showId and skips junk rows', () => {
  const m = stateMap([result('a-show'), result('b-show', { missing: [{ host: 'x' }] }), null, { title: 'no id' }]);
  assert.deepStrictEqual(m, { 'a-show': 'complete', 'b-show': 'incomplete' });
});

test('countsFor tolerates missing arrays on legacy rows', () => {
  const c = countsFor([{ showId: 'x' }, { showId: 'y', missing: [{ host: 'h' }], flaggedMisses: [{ recoverable: true }] }]);
  assert.strictEqual(c.withGap, 1);
  assert.strictEqual(c.totalMissing, 1);
  assert.strictEqual(c.totalRecoverable, 1);
  assert.strictEqual(c.totalRecovered, 0);
});
