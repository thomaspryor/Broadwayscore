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
const { mergeGapAudit, countsFor, gapStateFor, stateMap, censusVerdictFor, riskStateMap, isRiskyGapChange } = require('./gap-audit-merge.js');

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

test('duplicate showIds collapse to one row (ship-check: append list inflated counts)', () => {
  // Two rows for the same show — from the run, and across a merge — must never
  // both survive: an append list would add another copy on every subsequent
  // merge and quietly double the gap counts.
  const dup = mergeGapAudit(null, runOf([
    result('a-show'),
    result('a-show', { missing: [{ host: 'x.com', url: 'https://x.com/1' }] }),
  ]));
  assert.strictEqual(dup.results.length, 1);
  assert.strictEqual(dup.results[0].missing.length, 1, 'last row for a showId wins');
  assert.strictEqual(dup.counts.totalMissing, 1);

  // and a prior file that already contains duplicates gets de-duplicated too
  const dirtyPrev = { generatedAt: '2026-08-01T00:00:00.000Z', results: [result('b-show'), result('b-show')] };
  const cleaned = mergeGapAudit(dirtyPrev, runOf([result('a-show')]));
  assert.deepStrictEqual(cleaned.results.map(r => r.showId), ['a-show', 'b-show']);
  assert.strictEqual(cleaned.carriedForward, 1);
});

test('an entry with an unparseable computedAt is kept, not silently pruned', () => {
  const prev = { generatedAt: '2026-08-01T00:00:00.000Z', results: [{ ...result('weird-show'), computedAt: 'not-a-date' }] };
  const after = mergeGapAudit(prev, runOf([result('a-show')]), { retentionDays: 1 });
  assert.deepStrictEqual(after.results.map(r => r.showId).sort(), ['a-show', 'weird-show']);
  assert.strictEqual(after.prunedStale, 0);
});

test('gapStateFor: empty census is never "complete" (task #906: now reuses censusVerdict)', () => {
  // An aggregator article was seen but it extracted ZERO review URLs — the
  // vacuous-truth trap review-census.js's own docstring warns about. This is
  // the ONE deliberate behavior change from the pre-#906 hand-rolled version
  // (which read this as "complete"): finding no URLs is ignorance, not proof.
  assert.strictEqual(gapStateFor(result('a')), 'no-census-yet');
  // at least one real, covered URL and zero gaps == genuinely complete
  assert.strictEqual(gapStateFor(result('a', { aggregatorListedUrls: ['https://x.com/review'] })), 'complete');
  assert.strictEqual(gapStateFor(result('a', { missing: [{ host: 'x.com', url: 'https://x.com/1' }] })), 'incomplete');
  assert.strictEqual(gapStateFor(result('a', { flaggedMisses: [{ host: 'y.com', url: 'https://y.com/1' }] })), 'incomplete');
  assert.strictEqual(gapStateFor(result('a', { citedNoUrl: [{ outletId: 'o' }] })), 'incomplete');
  // no aggregator reference at all == ignorance, not proof of coverage
  assert.strictEqual(gapStateFor(result('a', { aggregatorArticles: [], aggregatorListedUrls: [] })), 'no-census-yet');
  assert.strictEqual(gapStateFor(null), 'no-census-yet');
});

test('stateMap keys by showId and skips junk rows', () => {
  const m = stateMap([
    result('a-show', { aggregatorListedUrls: ['https://x.com/review'] }),
    result('b-show', { missing: [{ host: 'x', url: 'https://x.com/1' }] }),
    null,
    { title: 'no id' },
  ]);
  assert.deepStrictEqual(m, { 'a-show': 'complete', 'b-show': 'incomplete' });
});

// BRO-513: review-gap's blast-radius guard needs to tell "the census found a
// genuine NEW gap" apart from "we lost coverage we used to have" even though
// both are the SAME complete -> incomplete verdict transition. riskStateMap +
// isRiskyGapChange are the real functions the guard call site uses (not
// hand-rolled test doubles), exercised against realistic result() shapes.
test('riskStateMap/isRiskyGapChange: a NEW aggregator-listed gap is not risky', () => {
  const prev = result('a-show', { aggregatorListedUrls: ['https://x.com/review-a'] });
  // Same covered URL still present, PLUS a brand-new URL the census just found
  // that we don't have yet — candidateCount grows, liveCount is unaffected.
  const next = result('a-show', {
    aggregatorListedUrls: ['https://x.com/review-a'],
    missing: [{ host: 'y.com', url: 'https://y.com/review-b' }],
  });
  const prevMap = riskStateMap([prev]);
  const nextMap = riskStateMap([next]);
  assert.strictEqual(prevMap['a-show'], 'complete:1:1');
  assert.strictEqual(nextMap['a-show'], 'incomplete:1:2');
  assert.strictEqual(isRiskyGapChange(prevMap['a-show'], nextMap['a-show']), false);
});

test('riskStateMap/isRiskyGapChange: the SAME URL flipping from covered to missing IS risky (broken checkout)', () => {
  // Simulates a broken/partial review-texts checkout: the exact same
  // aggregator-listed URL that used to resolve as covered now shows up in
  // `missing` (loadDirFiles() returned [] this run) — liveCount drops even
  // though the verdict transition (complete -> incomplete) looks identical
  // to the benign new-gap case above.
  const prev = result('a-show', { aggregatorListedUrls: ['https://x.com/review-a'] });
  const next = result('a-show', {
    aggregatorListedUrls: ['https://x.com/review-a'],
    missing: [{ host: 'x.com', url: 'https://x.com/review-a' }],
  });
  const prevMap = riskStateMap([prev]);
  const nextMap = riskStateMap([next]);
  assert.strictEqual(prevMap['a-show'], 'complete:1:1');
  assert.strictEqual(nextMap['a-show'], 'incomplete:0:1');
  assert.strictEqual(isRiskyGapChange(prevMap['a-show'], nextMap['a-show']), true);
});

test('countsFor tolerates missing arrays on legacy rows', () => {
  const c = countsFor([{ showId: 'x' }, { showId: 'y', missing: [{ host: 'h' }], flaggedMisses: [{ recoverable: true }] }]);
  assert.strictEqual(c.withGap, 1);
  assert.strictEqual(c.totalMissing, 1);
  assert.strictEqual(c.totalRecoverable, 1);
  assert.strictEqual(c.totalRecovered, 0);
});

// #906 follow-up: candidates are URL-level, not host-level. Two reviewed URLs
// from the SAME outlet each owe a state — deduping by host left the sibling URL
// stateless, which report-stateless-candidates.js caught on real data
// (tao-of-glass: timeout.com + londontheatre.co.uk; les-miserables-arena).
test('censusVerdictFor: sibling URLs from one outlet each get their own candidate', () => {
  const v = censusVerdictFor(result('a', {
    aggregatorListedUrls: ['https://timeout.com/a', 'https://timeout.com/b', 'https://other.com/c'],
  }), { now: '2026-08-03T00:00:00.000Z' });
  assert.strictEqual(v.candidates.length, 3);
  assert.deepStrictEqual(v.candidates.map((c) => c.url).sort(),
    ['https://other.com/c', 'https://timeout.com/a', 'https://timeout.com/b']);
  assert.ok(v.candidates.every((c) => c.state === 'live'));
  // The PUBLIC pair stays OUTLET-level (2 outlets, not 3 URLs): the audit
  // resolves coverage per host, so publishing "3 of 3 reviews live" off one
  // review file per host would claim more than we can vouch for.
  assert.strictEqual(v.liveCount, 2);
  assert.strictEqual(v.candidateCount, 2);
  // and the verdict itself is unchanged by the extra sibling
  assert.strictEqual(v.verdict, 'complete');
});

test('censusVerdictFor: an identical repeated URL still collapses to one candidate', () => {
  const v = censusVerdictFor(result('a', {
    aggregatorListedUrls: ['https://timeout.com/a', 'https://timeout.com/a'],
  }), { now: '2026-08-03T00:00:00.000Z' });
  assert.strictEqual(v.candidates.length, 1);
  assert.strictEqual(v.candidateCount, 1);
});

test('censusVerdictFor: liveCount excludes non-live candidates', () => {
  const v = censusVerdictFor(result('a', {
    aggregatorListedUrls: ['https://ok.com/1'],
    missing: [{ host: 'gone.com', url: 'https://gone.com/2' }],
  }), { now: '2026-08-03T00:00:00.000Z' });
  assert.strictEqual(v.candidateCount, 2);
  assert.strictEqual(v.liveCount, 1);
  assert.strictEqual(v.verdict, 'incomplete');
});

test('censusVerdictFor: public counts are outlet-level even as candidates stay URL-level', () => {
  const v = censusVerdictFor(result('a', {
    aggregatorListedUrls: ['https://timeout.com/listing', 'https://timeout.com/review'],
    missing: [{ host: 'gone.com', url: 'https://gone.com/1' }, { host: 'gone.com', url: 'https://gone.com/2' }],
  }), { now: '2026-08-03T00:00:00.000Z' });
  assert.strictEqual(v.candidates.length, 4);   // private detail: one row per URL
  assert.strictEqual(v.candidateCount, 2);      // public: timeout.com + gone.com
  assert.strictEqual(v.liveCount, 1);           // public: only timeout.com is covered
  assert.ok(v.liveCount <= v.candidateCount);
});
