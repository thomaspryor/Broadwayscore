import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { scanWorkflows, MIN_EXPECTED_WORKFLOWS } = require('./scan-alert-ledger-gaps.js');

// The 0/1/2 exit contract is load-bearing — 2 must never collapse into 1,
// because an uncaught throw exits 1 and a BROKEN guard must not be mistaken for
// a guard that found real violations. Before these tests the whole scanner was
// top-level code with no require.main guard, so none of this was reachable from
// a test and a regression would have shipped silently (review finding).

const NO_VIOLATIONS = () => [];

function makeTree(fileCount, { contents = 'name: x\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-gaps-'));
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `wf-${String(i).padStart(3, '0')}.yml`), contents);
  }
  return dir;
}

test('code 0 when a real tree has no violations', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 0);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS);
    assert.deepEqual(r.violations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 1, with each violation prefixed by its file, when the checker reports', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => ['job X missing the staging line']);
    assert.equal(r.code, 1);
    assert.equal(r.violations.length, MIN_EXPECTED_WORKFLOWS);
    assert.match(r.violations[0], /^wf-000\.yml: job X missing the staging line$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 — NOT 0 — when the tree is too small to be real', () => {
  // The regression this guards: a scanner printing "clean" having scanned
  // nothing. Must not be 0, and must not be 1 either (nothing was found).
  const dir = makeTree(3);
  try {
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 2);
    assert.match(r.error, /refusing to report a verdict/);
    assert.deepEqual(r.violations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 when the directory does not exist', () => {
  const r = scanWorkflows(path.join(os.tmpdir(), 'scan-gaps-does-not-exist-xyz'), NO_VIOLATIONS);
  assert.equal(r.code, 2);
  assert.match(r.error, /could not read/);
});

test('code 2 — NOT 1 — when the checker itself throws', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => { throw new Error('checker exploded'); });
    assert.equal(r.code, 2);
    assert.match(r.error, /checker threw on .*checker exploded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink POINTING AT A DIRECTORY cannot wedge the scan (EISDIR regression)', () => {
  // Accepting every symlink let a dir-shaped one reach readFileSync -> EISDIR,
  // and with fail-fast over a sorted list an early-sorting name aborted the
  // WHOLE scan at code 2. statSync follows the link, so it is excluded instead.
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const realDir = path.join(dir, 'a-real-directory');
    fs.mkdirSync(realDir);
    // "aaa-" sorts before every wf-NNN.yml, so a regression aborts everything.
    fs.symlinkSync(realDir, path.join(dir, 'aaa-points-at-a-dir.yml'));
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 0, `expected a clean scan, got code ${r.code}: ${r.error}`);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink to a real workflow IS scanned (silent-skip regression)', () => {
  // The opposite error: filtering on dirent.isFile() alone excluded every
  // symlinked workflow, silently under-reporting.
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    fs.symlinkSync(path.join(dir, 'wf-000.yml'), path.join(dir, 'zz-linked.yml'));
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 0);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS + 1, 'the symlinked workflow must be scanned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a BROKEN symlink is skipped rather than wedging the scan', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    fs.symlinkSync(path.join(dir, 'nothing-here.yml'), path.join(dir, 'aaa-broken.yml'));
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 0, `expected a clean scan, got code ${r.code}: ${r.error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.yaml workflows are scanned too, not silently ignored', () => {
  // GitHub Actions honours both extensions; matching only .yml would let a
  // future alerting.yaml go unscanned while still printing a clean verdict.
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    fs.writeFileSync(path.join(dir, 'zz-modern.yaml'), 'name: y\n');
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS + 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real repo scans clean', () => {
  const { findMissingLedgerCommits } = require('./alert-ledger-commit-check.js');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.github', 'workflows');
  const r = scanWorkflows(dir, findMissingLedgerCommits);
  assert.equal(r.code, 0, `expected the repo to be clean, got: ${r.violations.join('; ')} ${r.error || ''}`);
  assert.ok(r.scanned > MIN_EXPECTED_WORKFLOWS, 'sanity: the repo should have many workflows');
});
