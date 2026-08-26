import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { filterToplevelTestEntries, siblingSourcePath, findGaps } = require('./audit-toplevel-script-test-yml-coverage.js');

test('filterToplevelTestEntries: keeps only top-level scripts/*.test.(mjs|ts)', () => {
  const lines = [
    'scripts/fix-platform-ticket-links.test.mjs',
    'scripts/lib/some-helper.test.mjs',
    'scripts/tests/tm-gap-links.test.mjs',
    'tests/unit/some-test.test.mjs',
    'scripts/some-typed-thing.test.ts',
    '',
    '# a comment',
  ];
  assert.deepEqual(filterToplevelTestEntries(lines), [
    'scripts/fix-platform-ticket-links.test.mjs',
    'scripts/some-typed-thing.test.ts',
  ]);
});

test('siblingSourcePath: resolves a real .test.mjs to its real .js sibling', () => {
  assert.equal(
    siblingSourcePath('scripts/fix-platform-ticket-links.test.mjs'),
    'scripts/fix-platform-ticket-links.js'
  );
});

test('siblingSourcePath: returns null when the sibling source does not exist on disk', () => {
  assert.equal(siblingSourcePath('scripts/definitely-not-a-real-script-9999.test.mjs'), null);
});

test('siblingSourcePath: returns null for a non-matching path shape', () => {
  assert.equal(siblingSourcePath('scripts/lib/some-helper.test.mjs'), null);
});

test('findGaps: the real repo has zero gaps against the current test.yml + manifests (regression floor)', () => {
  const gaps = findGaps();
  assert.deepEqual(gaps, []);
});
