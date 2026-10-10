import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPushPaths, isCovered, resolveDepPath, findGaps } = require('./audit-test-yml-lib-deps.js');

const SAMPLE_YML = `
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'tests/**'
      # some comment mentioning vercel.json should NOT count as coverage
      - 'scripts/lib/**'
      - 'scripts/check-orphan-commits.js'
      - 'vercel.json'
  pull_request:
    branches: [main]
`;

test('readPushPaths: extracts only literal quoted entries under paths:, ignores comments', () => {
  const entries = readPushPaths(SAMPLE_YML);
  assert.deepEqual(entries, [
    'src/**',
    'tests/**',
    'scripts/lib/**',
    'scripts/check-orphan-commits.js',
    'vercel.json',
  ]);
});

test('isCovered: exact match', () => {
  assert.equal(isCovered('vercel.json', ['vercel.json']), true);
});

test('isCovered: glob prefix match', () => {
  assert.equal(isCovered('scripts/lib/foo.js', ['scripts/lib/**']), true);
  assert.equal(isCovered('scripts/foo.js', ['scripts/lib/**']), false);
});

test('isCovered: comment mentioning the filename does not count (regression — the raw substring-search bug this audit replaced)', () => {
  // A comment in the real file once said "...requires ../../vercel.json..." which
  // made a plain yml.includes('vercel.json') check pass even after the real
  // 'vercel.json' path entry was removed. isCovered only sees parsed entries.
  const entries = readPushPaths(SAMPLE_YML.replace("      - 'vercel.json'\n", ''));
  assert.equal(isCovered('vercel.json', entries), false);
});

test('resolveDepPath: appends .js when the require has no extension', () => {
  assert.equal(resolveDepPath('scripts/lib', '../check-orphan-commits.js'), 'scripts/check-orphan-commits.js');
});

test('resolveDepPath: leaves .json extension alone', () => {
  assert.equal(resolveDepPath('scripts/lib', '../../vercel.json'), 'vercel.json');
});

test('resolveDepPath: returns null for a dependency that does not exist on disk', () => {
  assert.equal(resolveDepPath('scripts/lib', '../does-not-exist-9999.js'), null);
});

test('isCovered: single-segment wildcard glob (e.g. next.config.*) matches, does not cross directories (adversarial review finding)', () => {
  assert.equal(isCovered('next.config.js', ['next.config.*']), true);
  assert.equal(isCovered('src/next.config.js', ['next.config.*']), false);
});

test('findGaps: the real repo has zero gaps against the current test.yml (regression floor)', () => {
  const gaps = findGaps();
  assert.deepEqual(gaps, []);
});
