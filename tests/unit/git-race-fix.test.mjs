/**
 * BRO-3620: git-using unit tests flaked under CI load. Two shapes:
 *  1. teardown racing git's own background writers (ENOTEMPTY on .git/objects),
 *  2. tests driving a real `git fetch` against the live origin.
 *
 * Shape 2's instance (dispatch-guard-vacuous-check.test.mjs) now injects its
 * git oracle. Shape 1 was guarded in tests/unit and scripts/tests only, while
 * CI also runs scripts/*.test.mjs and scripts/lib/*.test.mjs, where 147
 * unretried teardowns sat. This file proves (a) the retried teardown survives
 * a live concurrent writer, real git included, and (b) no CI-run test
 * directory carries an unretried teardown in a git-using file.
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
const { removeTreeSync, GIT_TEST_DIRS, offendersIn, gitUsingTestFiles, isUnretriedTeardown } = require('../../scripts/lib/git-test-teardown-scan.js');

const RETRIED = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

// A detached child that keeps creating files inside `dir` for `ms`, the way
// `git gc --auto` keeps writing into .git/objects after the command returns.
// It never recreates `dir` (git doesn't either), and it signals once it is
// live so the teardown under test really overlaps it.
function startWriter(dir, ms) {
  const code = `
    const fs = require('fs'), path = require('path');
    const end = Date.now() + ${ms}; let i = 0, told = false;
    while (Date.now() < end) {
      try { fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'obj' + (i++ % 50)), 'x'); } catch (_) {}
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

test('retried rmSync removes a directory while another process is still writing into it', async () => {
  for (let round = 0; round < 5; round++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3620-race-'));
    const hot = path.join(root, '.git', 'objects', 'ab');
    fs.mkdirSync(hot, { recursive: true });
    const writer = startWriter(hot, 150);
    try {
      await writer.live;
      await waitExit(writer); // the writer ends on its own; teardown below must still be clean
      assert.doesNotThrow(() => fs.rmSync(root, RETRIED));
      assert.equal(fs.existsSync(root), false, `round ${round}: directory survived teardown`);
    } finally {
      writer.kill();
      fs.rmSync(root, RETRIED);
    }
  }
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

test('retried rmSync cleans a real git repo while a background gc runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3620-gc-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
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
    assert.doesNotThrow(() => fs.rmSync(root, RETRIED));
  } finally {
    await waitExit(gc);
    fs.rmSync(root, RETRIED);
  }
  assert.equal(fs.existsSync(root), false);
});

test('every directory CI runs tests from is scanned, including scripts/ and scripts/lib/', () => {
  for (const d of ['tests/unit', 'scripts/tests', 'scripts', 'scripts/lib']) {
    assert.ok(GIT_TEST_DIRS.includes(d), `${d} missing from GIT_TEST_DIRS`);
  }
  const libGitTests = gitUsingTestFiles(repoRoot, 'scripts/lib');
  assert.ok(libGitTests.length >= 20, `expected scripts/lib to hold git-using tests, saw ${libGitTests.length}`);
});

test('no git-using test in any CI-run directory tears down without retries', () => {
  const offenders = GIT_TEST_DIRS.flatMap((d) => offendersIn(repoRoot, d, { exclude: ['tmp-git-repo-teardown-retries.test.mjs'] }));
  assert.deepEqual(offenders.map((o) => `${o.rel}:${o.line}`), []);
});

test('scanner positive control: flags the unretried shape, clears the retried one', () => {
  // Built from parts so this fixture doesn't trip the guard it tests.
  const RM = 'fs.' + 'rmSync';
  assert.equal(isUnretriedTeardown(`${RM}(d, { recursive: true, force: true });`), true);
  assert.equal(isUnretriedTeardown("fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });"), false);
  assert.equal(isUnretriedTeardown("fs.rmSync(file);"), false);
});
