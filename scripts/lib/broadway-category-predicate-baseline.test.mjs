import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hitKey, baselineKeySet, computeNewViolators } = require('./broadway-category-predicate-baseline.js');

test('hitKey combines file and snippet', () => {
  assert.equal(hitKey('scripts/foo.js', "if (category === 'broadway')"), "scripts/foo.js::if (category === 'broadway')");
});

test('baselineKeySet builds a Map of occurrence counts from the baseline hits array', () => {
  const counts = baselineKeySet([
    { file: 'scripts/a.js', snippet: 'x' },
    { file: 'scripts/b.js', snippet: 'y' },
  ]);
  assert.equal(counts.get('scripts/a.js::x'), 1);
  assert.equal(counts.get('scripts/b.js::y'), 1);
  assert.equal(counts.size, 2);
});

test('baselineKeySet counts duplicate (file, snippet) pairs instead of collapsing them', () => {
  const counts = baselineKeySet([
    { file: 'scripts/fetch-aggregator-pages.ts', snippet: 'dup' },
    { file: 'scripts/fetch-aggregator-pages.ts', snippet: 'dup' },
  ]);
  assert.equal(counts.get('scripts/fetch-aggregator-pages.ts::dup'), 2);
});

test('baselineKeySet tolerates a missing/empty hits array', () => {
  assert.equal(baselineKeySet(undefined).size, 0);
  assert.equal(baselineKeySet([]).size, 0);
});

test('computeNewViolators: stays silent when hits match the baseline exactly', () => {
  const violators = [{ file: 'scripts/a.js', hits: [{ line: 5, snippet: 'x' }] }];
  const baselineCounts = baselineKeySet([{ file: 'scripts/a.js', snippet: 'x' }]);
  assert.deepEqual(computeNewViolators(violators, baselineCounts), []);
});

test('computeNewViolators: fires on a same-day swap (one baselined hit fixed, a different one added — count stays flat)', () => {
  // The exact failure mode a count-based baseline would miss: file still has
  // exactly 1 hit, but it's a DIFFERENT line than the baselined one.
  const violators = [{ file: 'scripts/a.js', hits: [{ line: 9, snippet: 'new-violation' }] }];
  const baselineCounts = baselineKeySet([{ file: 'scripts/a.js', snippet: 'old-violation' }]);
  const result = computeNewViolators(violators, baselineCounts);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { file: 'scripts/a.js', hits: [{ line: 9, snippet: 'new-violation' }] });
});

test('computeNewViolators: flags a brand-new file with all its hits', () => {
  const violators = [{ file: 'scripts/new.js', hits: [{ line: 1, snippet: 'z' }] }];
  const result = computeNewViolators(violators, baselineKeySet([]));
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'scripts/new.js');
});

test('computeNewViolators: partial match keeps only the new hit(s), drops the baselined one', () => {
  const violators = [{
    file: 'scripts/a.js',
    hits: [{ line: 1, snippet: 'old' }, { line: 2, snippet: 'new' }],
  }];
  const baselineCounts = baselineKeySet([{ file: 'scripts/a.js', snippet: 'old' }]);
  const result = computeNewViolators(violators, baselineCounts);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].hits, [{ line: 2, snippet: 'new' }]);
});

// Regression test for a real bug caught by ship-check's adversarial Codex
// pass: a plain Set collapsed duplicate (file, snippet) pairs to one
// membership bit, so ONE baselined occurrence of a repeated text could excuse
// an UNLIMITED number of current hits sharing that same text — fetch-
// aggregator-pages.ts:186/385 are real, distinct occurrences of the identical
// literal `show.category === 'broadway' || show.category === 'off-broadway'`.

test('computeNewViolators: two identical baselined occurrences excuse exactly two current occurrences, not more', () => {
  const violators = [{
    file: 'scripts/fetch-aggregator-pages.ts',
    hits: [{ line: 186, snippet: 'dup' }, { line: 385, snippet: 'dup' }],
  }];
  const baselineCounts = baselineKeySet([
    { file: 'scripts/fetch-aggregator-pages.ts', snippet: 'dup' },
    { file: 'scripts/fetch-aggregator-pages.ts', snippet: 'dup' },
  ]);
  assert.deepEqual(computeNewViolators(violators, baselineCounts), []);
});

test('computeNewViolators: a THIRD identical occurrence beyond the baselined count of 2 is flagged new', () => {
  // Line 186 was fixed (no longer present); a brand-new, unrelated occurrence
  // with the identical text was added elsewhere in the same file. A Set-based
  // membership test would silently excuse this — the count-based budget must not.
  const violators = [{
    file: 'scripts/fetch-aggregator-pages.ts',
    hits: [
      { line: 385, snippet: 'dup' },
      { line: 512, snippet: 'dup' },
      { line: 640, snippet: 'dup' },
    ],
  }];
  const baselineCounts = baselineKeySet([
    { file: 'scripts/fetch-aggregator-pages.ts', snippet: 'dup' },
    { file: 'scripts/fetch-aggregator-pages.ts', snippet: 'dup' },
  ]);
  const result = computeNewViolators(violators, baselineCounts);
  assert.equal(result.length, 1);
  assert.equal(result[0].hits.length, 1);
  assert.equal(result[0].hits[0].line, 640);
});
