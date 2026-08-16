import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hitKey, baselineKeySet, computeNewViolators } = require('./broadway-category-predicate-baseline.js');

test('hitKey combines file and snippet', () => {
  assert.equal(hitKey('scripts/foo.js', "if (category === 'broadway')"), "scripts/foo.js::if (category === 'broadway')");
});

test('baselineKeySet builds a Set from the baseline hits array', () => {
  const keys = baselineKeySet([
    { file: 'scripts/a.js', snippet: 'x' },
    { file: 'scripts/b.js', snippet: 'y' },
  ]);
  assert.ok(keys.has('scripts/a.js::x'));
  assert.ok(keys.has('scripts/b.js::y'));
  assert.equal(keys.size, 2);
});

test('baselineKeySet tolerates a missing/empty hits array', () => {
  assert.equal(baselineKeySet(undefined).size, 0);
  assert.equal(baselineKeySet([]).size, 0);
});

test('computeNewViolators: stays silent when hits match the baseline exactly', () => {
  const violators = [{ file: 'scripts/a.js', hits: [{ line: 5, snippet: 'x' }] }];
  const baselineKeys = baselineKeySet([{ file: 'scripts/a.js', snippet: 'x' }]);
  assert.deepEqual(computeNewViolators(violators, baselineKeys), []);
});

test('computeNewViolators: fires on a same-day swap (one baselined hit fixed, a different one added — count stays flat)', () => {
  // The exact failure mode a count-based baseline would miss: file still has
  // exactly 1 hit, but it's a DIFFERENT line than the baselined one.
  const violators = [{ file: 'scripts/a.js', hits: [{ line: 9, snippet: 'new-violation' }] }];
  const baselineKeys = baselineKeySet([{ file: 'scripts/a.js', snippet: 'old-violation' }]);
  const result = computeNewViolators(violators, baselineKeys);
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
  const baselineKeys = baselineKeySet([{ file: 'scripts/a.js', snippet: 'old' }]);
  const result = computeNewViolators(violators, baselineKeys);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].hits, [{ line: 2, snippet: 'new' }]);
});
