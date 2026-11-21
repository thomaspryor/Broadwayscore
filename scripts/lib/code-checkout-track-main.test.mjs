// trackMainWhenNothingLocal: a fast-forwarded session branch must not read as "N unpushed commits" (BRO-7628 session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { trackMainWhenNothingLocal } = createRequire(import.meta.url)('./code-checkout-staleness.js');

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trackmain-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a'), '1'); git(dir, 'add', 'a'); git(dir, 'commit', '-qm', 'one');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'remote', 'add', 'origin', dir);
  return dir;
}

test('a branch holding only origin/main commits tracks origin/main (unpushed count 0)', () => {
  const dir = fixture();
  try {
    git(dir, 'checkout', '-q', '-b', 'claude/x');
    assert.throws(() => git(dir, 'rev-list', '--count', '@{upstream}..HEAD'), /no upstream/);
    assert.equal(trackMainWhenNothingLocal(dir), true);
    assert.equal(git(dir, 'rev-list', '--count', '@{upstream}..HEAD'), '0');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('a branch with a real local commit is left alone, so its unpushed work still shows', () => {
  const dir = fixture();
  try {
    git(dir, 'checkout', '-q', '-b', 'claude/y');
    fs.writeFileSync(path.join(dir, 'b'), '2'); git(dir, 'add', 'b'); git(dir, 'commit', '-qm', 'local');
    assert.equal(trackMainWhenNothingLocal(dir), false);
    assert.throws(() => git(dir, 'rev-parse', '@{upstream}'));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('main itself and an existing upstream are untouched', () => {
  const dir = fixture();
  try {
    assert.equal(trackMainWhenNothingLocal(dir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('a resumed branch fast-forwarded past its stale remote branch re-tracks origin/main (parent finding, BRO-7629)', () => {
  const dir = fixture();
  try {
    const old = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/claude/z', old);
    git(dir, 'checkout', '-q', '-b', 'claude/z');
    git(dir, 'branch', '--set-upstream-to=origin/claude/z');
    fs.writeFileSync(path.join(dir, 'a'), '2'); git(dir, 'commit', '-qam', 'two'); // lands on main in real life
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(git(dir, 'rev-list', '--count', '@{upstream}..HEAD'), '1', 'before: reads as 1 unpushed');
    assert.equal(trackMainWhenNothingLocal(dir), true);
    assert.equal(git(dir, 'rev-list', '--count', '@{upstream}..HEAD'), '0');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
