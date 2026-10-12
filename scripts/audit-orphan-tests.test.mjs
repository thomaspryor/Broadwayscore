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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { extractRunBlocks, REFERENCE_REGEX, checkManifests, findRawOrphans, exemptionFor } = require('./audit-orphan-tests.js');
const { ciCoverageOf } = require('./lib/ci-test-coverage.js');

// BRO-111: REFERENCE_REGEX used to exclude dots from its match class, so a
// dotted test filename (review-normalization.maybeUpgradeUrl.test.mjs) only
// ever matched its tail (maybeUpgradeUrl.test.mjs) — never equal to the full
// basename listTestFiles() reports, so a correctly-manifest-registered test
// still read as an orphan and blocked pushes.
test('REFERENCE_REGEX matches the full basename of a dotted test filename', () => {
  const line = 'tests/unit/review-normalization.maybeUpgradeUrl.test.mjs';
  const matches = [...line.matchAll(new RegExp(REFERENCE_REGEX))].map((m) => m[0]);
  assert.deepEqual(matches, ['review-normalization.maybeUpgradeUrl.test.mjs']);
});

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

// BRO-4525: a manifest entry inserted out of alphabetical order passed this
// audit ("All N registered") and only failed in the land run's
// test-manifest-integrity test. checkManifests() runs the same validator, and
// with --scope-stdin a problem blocks only when its manifest is in the push.
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-manifest-'));
  fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
  for (const f of ['a.test.mjs', 'b.test.mjs']) fs.writeFileSync(path.join(root, 'tests/unit', f), '');
  return root;
}
const NODE_MANIFEST = 'tests/unit-test-manifest.txt';
const forManifest = (list) => list.filter((p) => p.manifest === NODE_MANIFEST);

test('an unsorted manifest blocks when unscoped or when the push touches it', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, NODE_MANIFEST), 'tests/unit/b.test.mjs\ntests/unit/a.test.mjs\n');
  for (const scope of [undefined, [NODE_MANIFEST]]) {
    const { blocking, informational } = checkManifests(root, scope);
    assert.match(forManifest(blocking).map((p) => p.error).join('\n'), /not sorted/);
    assert.deepEqual(forManifest(informational), []);
  }
});

test('an unsorted manifest outside the push is informational only', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, NODE_MANIFEST), 'tests/unit/b.test.mjs\ntests/unit/a.test.mjs\n');
  const { blocking, informational } = checkManifests(root, ['src/unrelated.ts']);
  assert.deepEqual(blocking, []);
  assert.match(forManifest(informational).map((p) => p.error).join('\n'), /not sorted/);
});

test('a sorted manifest of existing files reports nothing', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, NODE_MANIFEST), 'tests/unit/a.test.mjs\ntests/unit/b.test.mjs\n');
  const { blocking, informational } = checkManifests(root);
  assert.deepEqual(forManifest(blocking), []);
  assert.deepEqual(forManifest(informational), []);
});

// BRO-2778: coverage used to be a Set of BARE FILENAMES, so a test was "covered"
// whenever ANY file with the same basename was in a manifest or a run: step.
// scripts/cast-backfill-year-validation.test.mjs and
// scripts/ingest-manual-review.test.mjs ran in zero CI jobs behind same-named
// tests/unit/ files. findRawOrphans() is the real audit path, driven here
// against a fixture repo.
function coverageRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-coverage-'));
  const write = (rel, body = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('.github/workflows/test.yml', [
    'on:',
    '  push:',
    '    paths:',
    "      - 'tests/unit/paths-only.test.mjs'",
    "      - 'scripts/collide.test.mjs'",
    'jobs:',
    '  t:',
    '    steps:',
    '      - name: Runs tests/unit/name-only.test.mjs (name only)',
    '        run: |',
    '          node --test tests/unit/run-step.test.mjs',
    '          # node --test tests/unit/commented.test.mjs',
    '          node --test tests/smoke/smoky.test.mjs',
  ].join('\n'));
  write(NODE_MANIFEST, 'tests/unit/collide.test.mjs\n');
  for (const f of [
    'tests/unit/paths-only.test.mjs', 'tests/unit/name-only.test.mjs', 'tests/unit/run-step.test.mjs',
    'tests/unit/commented.test.mjs', 'tests/unit/collide.test.mjs', 'scripts/collide.test.mjs',
    'tests/smoke/smoky.test.mjs', 'tests/smoke/lonely.test.mjs',
  ]) write(f);
  return root;
}

test('a test path mentioned only in on.push.paths is NOT covered; one named in a run: step is', () => {
  const orphans = findRawOrphans(coverageRepo()).rawOrphans.map((f) => f.rel);
  assert.ok(orphans.includes('tests/unit/paths-only.test.mjs'), 'on.push.paths entry must not count as coverage');
  assert.ok(!orphans.includes('tests/unit/run-step.test.mjs'), 'a path a run: step executes is covered');
});

test('a same-named file in another directory does not lend its coverage', () => {
  const orphans = findRawOrphans(coverageRepo()).rawOrphans.map((f) => f.rel);
  assert.ok(!orphans.includes('tests/unit/collide.test.mjs'), 'the manifest-registered file is covered');
  assert.ok(orphans.includes('scripts/collide.test.mjs'), 'its scripts/ namesake is not');
});

test('step names and shell comments inside run: do not count; tests/smoke is scanned', () => {
  const orphans = findRawOrphans(coverageRepo()).rawOrphans.map((f) => f.rel);
  assert.ok(orphans.includes('tests/unit/name-only.test.mjs'));
  assert.ok(orphans.includes('tests/unit/commented.test.mjs'));
  assert.ok(!orphans.includes('tests/smoke/smoky.test.mjs'));
  assert.ok(orphans.includes('tests/smoke/lonely.test.mjs'));
});

test('ciCoverageOf: run: glob covers its directory only; whole-path boundaries hold', () => {
  const ci = { manifestEntries: new Set(), runText: 'tests=(scripts/lib/*.test.mjs)\nnode --test scripts/tests/x.test.mjs' };
  assert.equal(ciCoverageOf('scripts/lib/a.test.mjs', ci), 'glob');
  assert.equal(ciCoverageOf('scripts/lib/deep/a.test.mjs', ci), false);
  assert.equal(ciCoverageOf('scripts/a.test.mjs', ci), false);
  assert.equal(ciCoverageOf('scripts/tests/x.test.mjs', ci), 'run-step');
  assert.equal(ciCoverageOf('tests/x.test.mjs', ci), false, 'scripts/tests/x must not cover tests/x');
});

test('exemptionFor: a path key exempts only that file; a bare-name key exempts nothing', () => {
  const map = { 'scripts/shim.test.mjs': 'BRO-1', 'legacy.test.mjs': 'BRO-2' };
  assert.equal(exemptionFor(map, { name: 'shim.test.mjs', rel: 'scripts/shim.test.mjs' }), 'BRO-1');
  assert.equal(exemptionFor(map, { name: 'shim.test.mjs', rel: 'tests/unit/shim.test.mjs' }), undefined);
  assert.equal(exemptionFor(map, { name: 'legacy.test.mjs', rel: 'scripts/legacy.test.mjs' }), undefined);
});

// BRO-2778: a bare-filename exemption key exempts every same-named file in
// every scanned dir. All keys must be repo-relative paths to a real file.
test('exemption keys are repo-relative paths to files that exist', () => {
  const { EXEMPT_KNOWN_BROKEN, EXEMPT_NEVER_CI } = require('./audit-orphan-tests.js');
  const root = new URL('..', import.meta.url);
  for (const key of [...Object.keys(EXEMPT_KNOWN_BROKEN), ...Object.keys(EXEMPT_NEVER_CI)]) {
    assert.ok(key.includes('/'), `exemption key "${key}" must be a path, not a bare filename`);
    assert.ok(fs.existsSync(new URL(key, root)), `exemption key "${key}" names no file`);
  }
});
