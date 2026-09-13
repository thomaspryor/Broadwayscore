import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  filterToplevelTestEntries, siblingSourcePath, findGaps,
  filterTestsDirEntries, toplevelScriptDeps,
} = require('./audit-toplevel-script-test-yml-coverage.js');
const { relativeSpecifiers } = require('./audit-test-yml-lib-deps.js');

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

// --- BRO-3202: the second gap shape — a manifest-registered test under tests/
// whose required top-level scripts/ SOURCE has no push-path entry. The test
// file is always covered by the 'tests/**' glob, so only the source can be
// missing, and the source is the half that changes behaviour.

const UNIT_DIR = new URL('../tests/unit/', import.meta.url).pathname;

test('filterTestsDirEntries: keeps only tests/**/*.test.(mjs|ts)', () => {
  const lines = [
    'tests/unit/audit-dependencies.test.mjs',
    'tests/unit/nested/deep.test.ts',
    'scripts/fix-platform-ticket-links.test.mjs',
    'scripts/lib/some-helper.test.mjs',
    'tests/unit/not-a-test.mjs',
    '',
    '# a comment',
  ];
  assert.deepEqual(filterTestsDirEntries(lines), [
    'tests/unit/audit-dependencies.test.mjs',
    'tests/unit/nested/deep.test.ts',
  ]);
});

test('toplevelScriptDeps: finds a top-level scripts/ require, ignores scripts/lib and packages', () => {
  const src = [
    "import { test } from 'node:test';",
    "const a = require('../../scripts/audit-dependencies.js');",
    "const b = require('../../scripts/lib/test-yml-push-paths.js');",
    "const c = require('node:fs');",
  ].join('\n');
  assert.deepEqual(
    toplevelScriptDeps(src, UNIT_DIR),
    ['scripts/audit-dependencies.js'],
    'scripts/lib/** is already globbed; bare package specifiers are not files'
  );
});

test('toplevelScriptDeps: resolves a specifier written without its extension', () => {
  const src = "const x = require('../../scripts/audit-dependencies');";
  assert.deepEqual(toplevelScriptDeps(src, UNIT_DIR), ['scripts/audit-dependencies.js']);
});

// The shared regex used to be /require\(['"]\.…/ — no whitespace allowed after
// `require(` — so the multi-line shape a long destructure gets formatted into
// silently dropped the dependency from BOTH audits.
// tests/unit/assert-broadcast-step-order.test.mjs:25 is written exactly that
// way and was invisible to this audit until the regex was made
// whitespace-tolerant.
test('relativeSpecifiers: catches a require() split across lines', () => {
  const src = [
    'const { findNodeInstallLine, findChecklistGateLine } = require(',
    "  '../../scripts/assert-broadcast-step-order.js',",
    ');',
  ].join('\n');
  assert.deepEqual([...relativeSpecifiers(src)], ['../../scripts/assert-broadcast-step-order.js']);
});

test('relativeSpecifiers: is not left stateful by a previous call (/g lastIndex)', () => {
  const src = "const a = require('./one.js');\nimport b from './two.js';";
  const first = [...relativeSpecifiers(src)];
  const second = [...relativeSpecifiers(src)];
  assert.deepEqual(second, first, 'a second call must see the same specifiers');
  assert.deepEqual(first, ['./one.js', './two.js']);
});

test('findGaps: the real repo reports both shapes and currently has none of either', () => {
  const gaps = findGaps();
  assert.deepEqual(gaps, [], `push-path entries missing for: ${gaps.map((g) => g.source).join(', ')}`);
});
