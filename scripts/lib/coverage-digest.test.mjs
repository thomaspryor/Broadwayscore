// Coverage Verdict S3 (task #905) — coverage digest line formatting.
// Run: node --test scripts/lib/coverage-digest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { coverageDigestLine, coverageDigestLines, coverageDigestItems } = require('./coverage-digest.js');

test('Car Man-shaped result renders the plan\'s exact example line', () => {
  const line = coverageDigestLine({
    title: 'The Car Man',
    showId: 'the-car-man-west-end-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14 },
    missing: [
      { url: 'a', host: 'a.com' },
      { url: 'b', host: 'b.com' },
      { url: 'c', host: 'c.com', priorRun: true },
    ],
  });
  assert.strictEqual(line, 'The Car Man: 11 of 14 known reviews live — 2 being fetched, 1 excluded (older production)');
});

test('no-census-yet never renders a line (fail open)', () => {
  const line = coverageDigestLine({
    title: 'Some Show',
    showId: 'some-show',
    censusVerdict: { verdict: 'no-census-yet', liveCount: 0, candidateCount: 0 },
    missing: [],
  });
  assert.strictEqual(line, null);
});

test('fully live show renders nothing — no news is no line', () => {
  const line = coverageDigestLine({
    title: 'Complete Show',
    showId: 'complete-show',
    censusVerdict: { verdict: 'complete', liveCount: 5, candidateCount: 5 },
    missing: [],
  });
  assert.strictEqual(line, null);
});

test('missing censusVerdict entirely (COVERAGE_GATE_DISABLED / audit gap) renders nothing', () => {
  assert.strictEqual(coverageDigestLine({ title: 'X', showId: 'x' }), null);
  assert.strictEqual(coverageDigestLine(null), null);
});

test('all-pending show (no exclusions) omits the excluded clause', () => {
  const line = coverageDigestLine({
    title: 'Pending Show',
    showId: 'pending-show',
    censusVerdict: { verdict: 'incomplete', liveCount: 3, candidateCount: 5 },
    missing: [{ url: 'a' }, { url: 'b' }],
  });
  assert.strictEqual(line, 'Pending Show: 3 of 5 known reviews live — 2 being fetched');
});

test('coverageDigestItems produces the renderNamedDigestBlock {title, detail} shape', () => {
  const items = coverageDigestItems([{
    title: 'The Car Man',
    showId: 'the-car-man-west-end-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14 },
    missing: [{ url: 'a' }, { url: 'b' }, { url: 'c', priorRun: true }],
  }]);
  assert.deepStrictEqual(items, [{
    title: 'The Car Man',
    detail: '11 of 14 known reviews live — 2 being fetched, 1 excluded (older production)',
  }]);
});

// ── Line coherence when `excluded` (drawn from the broader all-history
// missing-citation list) exceeds `candidateCount` (this run's roundup
// census) — task #907, othello-off-broadway-2026: 38 census candidates but
// 54 correctly-flagged priorRun citations from the unrelated 2025 Broadway
// production. The line must never read "N excluded" where N > "of M known".

test('excluded count exceeding candidateCount never renders excluded > known (Othello-shaped fixture)', () => {
  const missing = Array.from({ length: 54 }, (_, i) => ({ url: `https://outlet${i}.com/othello-2025-review`, priorRun: true }));
  const line = coverageDigestLine({
    title: 'Othello',
    showId: 'othello-off-broadway-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 0, candidateCount: 38 },
    missing,
  });
  assert.strictEqual(line, 'Othello: 0 of 54 known reviews live — 54 excluded (older production)');
  const knownMatch = line.match(/of (\d+) known/);
  const excludedMatch = line.match(/(\d+) excluded/);
  assert.ok(Number(excludedMatch[1]) <= Number(knownMatch[1]), 'excluded must never exceed known');
});

test('excluded within candidateCount is unaffected by the known-total fix (regression guard)', () => {
  const line = coverageDigestLine({
    title: 'The Car Man',
    showId: 'the-car-man-west-end-2026',
    censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14 },
    missing: [
      { url: 'a' }, { url: 'b' }, { url: 'c', priorRun: true },
    ],
  });
  assert.strictEqual(line, 'The Car Man: 11 of 14 known reviews live — 2 being fetched, 1 excluded (older production)');
});

test('coverageDigestLines sorts least-complete first and respects the limit', () => {
  const results = [
    { title: 'Mostly Done', showId: 'a', censusVerdict: { verdict: 'incomplete', liveCount: 4, candidateCount: 5 }, missing: [{ url: 'x' }] },
    { title: 'Barely Started', showId: 'b', censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 5 }, missing: [{ url: 'x' }, { url: 'y' }, { url: 'z' }, { url: 'w' }] },
    { title: 'Complete', showId: 'c', censusVerdict: { verdict: 'complete', liveCount: 5, candidateCount: 5 }, missing: [] },
  ];
  const lines = coverageDigestLines(results, { limit: 1 });
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^Barely Started/);
});
