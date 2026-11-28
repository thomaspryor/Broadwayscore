/**
 * BRO-3620: git-using unit tests flaked under CI load. Two shapes:
 *  1. teardown racing git's own background writers (ENOTEMPTY on .git/objects),
 *  2. tests driving a real `git fetch` against the live origin.
 *
 * Shape 2's instance (dispatch-guard-vacuous-check.test.mjs) now injects its
 * git oracle. Shape 1 was guarded in tests/unit and scripts/tests only, while
 * CI also runs scripts/*.test.mjs and scripts/lib/*.test.mjs, where 147
 * unretried teardowns sat. This file proves removeTreeSync survives a live
 * concurrent writer, real git included, and that the scanner covers every
 * directory CI runs tests from. The scan itself is owned by
 * tests/unit/tmp-git-repo-teardown-retries.test.mjs.
 *
 * Run: node --test tests/unit/git-race-fix.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { removeTreeSync, GIT_TEST_DIRS, gitUsingTestFiles, isUnretriedTeardown } = require('../../scripts/lib/git-test-teardown-scan.js');

// A detached child that keeps creating files inside `dir` for `ms`, the way
// `git gc --auto` keeps writing into .git/objects after the command returns.
// It never recreates `dir` (git doesn't either), and it signals once it is
// live so the teardown under test really overlaps it.
function startWriter(dir, ms) {
  const code = `
    const fs = require('fs'), path = require('path');
    const end = Date.now() + ${ms}; let i = 0, told = false;
    while (Date.now() < end) {
      try { fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'obj' + (i++ % 50)), 'x'); }
      catch (e) { if (e.code === 'ENOENT') break; }
      if (!told) { told = true; process.stdout.write('live\\n'); }
    }`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.live = new Promise((resolve) => child.stdout.once('data', resolve));
  return child;
}

const waitExit = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.once('exit', resolve);
});

test('removeTreeSync wins against a writer that is still running when teardown starts', async () => {
  for (let round = 0; round < 3; round++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3620-live-'));
    const hot = path.join(root, '.git', 'objects', 'cd');
    fs.mkdirSync(hot, { recursive: true });
    const writer = startWriter(hot, 120);
    await writer.live;
    let err = null;
    // Blocks this thread while the writer keeps going. fs.rmSync's own
    // maxRetries fails here (it never re-deletes children); the whole-tree
    // retry outlasts the writer.
    try { removeTreeSync(root); } catch (e) { err = e; }
    await waitExit(writer);
    try {
      assert.equal(err, null, `round ${round}: removeTreeSync threw under a live writer: ${err && err.code}`);
      assert.equal(fs.existsSync(root), false, `round ${round}: directory survived teardown`);
    } finally {
      removeTreeSync(root);
    }
  }
});

test('removeTreeSync cleans a real git repo while a background gc runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3620-gc-'));
  const git = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(root, `f${i}.txt`), `content ${i}\n`);
    git('add', '-A');
    git('commit', '-qm', `c${i}`);
  }
  const gc = spawn('git', ['gc', '--quiet'], { cwd: root, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 10));
    // fs.rmSync's own maxRetries lost this race ~1 run in 6 locally
    // (ENOTEMPTY on .git while gc wrote a pack); the whole-tree retry wins.
    assert.doesNotThrow(() => removeTreeSync(root));
  } finally {
    await waitExit(gc);
    removeTreeSync(root);
  }
  assert.equal(fs.existsSync(root), false);
});

test('every directory CI runs tests from is scanned, including scripts/ and scripts/lib/', () => {
  const { NODE_TEST_DIRS } = require('../../scripts/lib/unit-test-collection.js');
  for (const d of [...NODE_TEST_DIRS, 'scripts/lib']) {
    assert.ok(GIT_TEST_DIRS.includes(d), `${d} missing from GIT_TEST_DIRS`);
  }
  const libGitTests = gitUsingTestFiles(repoRoot, 'scripts/lib');
  assert.ok(libGitTests.length >= 20, `expected scripts/lib to hold git-using tests, saw ${libGitTests.length}`);
});

test('scanner positive control: flags the unretried shape, clears the retried one', () => {
  // Built from parts so this fixture doesn't trip the guard it tests.
  const RM = 'fs.' + 'rmSync';
  assert.equal(isUnretriedTeardown(`${RM}(d, { recursive: true, force: true });`), true);
  assert.equal(isUnretriedTeardown("fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });"), false);
  assert.equal(isUnretriedTeardown("fs.rmSync(file);"), false);
  assert.equal(isUnretriedTeardown(`${RM}(d, { recursive: true, force: true, maxRetries: 0 });`), true, 'maxRetries: 0 retries nothing');
});
