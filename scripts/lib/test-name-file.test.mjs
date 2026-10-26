import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findTestFileByName, pickTestFile } = require('./test-name-file.js');

test('one declaring test file is returned', () => {
  assert.equal(findTestFileByName('no two unrelated shows serve byte-identical hero images', { grep: () => ['tests/unit/show-hero-integrity.test.mjs'] }), 'tests/unit/show-hero-integrity.test.mjs');
});

test('ambiguous or empty matches return null so the caller keeps its fallback', () => {
  assert.equal(findTestFileByName('some long failing test name', { grep: () => ['a.test.mjs', 'b.test.mjs'] }), null);
  assert.equal(findTestFileByName('some long failing test name', { grep: () => [] }), null);
  assert.equal(findTestFileByName('short', { grep: () => ['a.test.mjs'] }), null);
  assert.equal(findTestFileByName('some long failing test name', { grep: () => { throw new Error('boom'); } }), null);
});

test('non-test files and unsafe paths are never named', () => {
  assert.equal(pickTestFile(['scripts/foo.js']), null);
  assert.equal(pickTestFile(['tests/unit/a b.test.mjs']), null);
  assert.equal(pickTestFile(['tests/unit/a.test.mjs', 'tests/unit/a.test.mjs']), 'tests/unit/a.test.mjs');
});

test('real repo: the hero-integrity test name resolves to its file', () => {
  assert.equal(findTestFileByName('no two unrelated shows serve byte-identical hero images', { cwd: process.cwd() }), 'tests/unit/show-hero-integrity.test.mjs');
});
