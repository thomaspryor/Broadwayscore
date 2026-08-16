// Regression test for task #1643: audit-orphan-tests.js's collectReferencedTests()
// used to count a bare filename mention ANYWHERE in a workflow YAML's raw text as
// "registered" — including inside a `#` comment, a `paths:` trigger-list entry, or
// a `name:`/`env:`/`with:` scalar — none of which mean the test actually runs. That
// hid 5 real orphan tests that never executed in CI. extractRunBlocks() fixes this
// by extracting ONLY the text inside a step's `run:` value (single-line or block
// scalar) before matching, rather than guessing from comment/list punctuation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractRunBlocks } = require('./audit-orphan-tests.js');

test('a comment-only mention of a test filename is excluded', () => {
  const yaml = [
    '      # its unit test is in tests/unit-test-manifest.txt (tests/unit/foo.test.mjs',
    '      # covered by the no-data batch).',
    '      - "scripts/foo.js"',
  ].join('\n');
  assert.equal(extractRunBlocks(yaml).includes('foo.test.mjs'), false);
});

test('a paths: trigger-list entry is excluded', () => {
  const yaml = [
    'on:',
    '  push:',
    '    paths:',
    "      - 'tests/unit/bar.test.mjs'",
  ].join('\n');
  assert.equal(extractRunBlocks(yaml).includes('bar.test.mjs'), false);
});

test('a name:/env:/with: scalar merely naming a test file is excluded', () => {
  const yaml = [
    '      - name: Regression check for tests/unit/quux.test.mjs',
    '        env:',
    '          FIXTURE_NOTE: "see tests/unit/quux.test.mjs for context"',
    '        with:',
    '          path: tests/unit/quux.test.mjs',
    '        run: echo done',
  ].join('\n');
  assert.equal(extractRunBlocks(yaml).includes('quux.test.mjs'), false);
});

test('a real single-line `run:` invocation still counts', () => {
  const yaml = '        run: node --test tests/unit/baz.test.mjs';
  assert.equal(extractRunBlocks(yaml).includes('baz.test.mjs'), true);
});

test('a real `run:` block-scalar invocation still counts', () => {
  const yaml = [
    '        run: |',
    '          node --test --test-timeout 120000 tests/unit/quux2.test.mjs',
  ].join('\n');
  assert.equal(extractRunBlocks(yaml).includes('quux2.test.mjs'), true);
});

test('a run: block ends at the next step, not swallowing its content', () => {
  const yaml = [
    '      - name: Step A',
    '        run: |',
    '          echo "no mention here"',
    '      - name: Step B mentions tests/unit/notrun.test.mjs only in its name',
    '        run: echo b',
  ].join('\n');
  assert.equal(extractRunBlocks(yaml).includes('notrun.test.mjs'), false);
});

test('a run: block correctly includes a blank line inside the block without ending early', () => {
  const yaml = [
    '        run: |',
    '          node --test tests/unit/before.test.mjs',
    '',
    '          node --test tests/unit/after.test.mjs',
  ].join('\n');
  const extracted = extractRunBlocks(yaml);
  assert.equal(extracted.includes('before.test.mjs'), true);
  assert.equal(extracted.includes('after.test.mjs'), true);
});
