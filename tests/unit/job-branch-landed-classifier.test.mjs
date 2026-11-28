import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { classifyJobBranch, listWorkBranchStatuses, unlandedCommitsFor } =
  require('../../scripts/lib/worktree-branch-guard.js');
const { findWorkBranchCollisions } = require('../../scripts/lib/dispatch-guards.js');

function repository(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bro-2814-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const commit = (file, text) => {
    writeFileSync(path.join(dir, file), text);
    git('add', '--', file);
    git('commit', '-m', text);
    return git('rev-parse', 'HEAD');
  };
  commit('base.txt', 'base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  return { dir, git, commit, base };
}

test('empty git log ranges distinguish an integrated branch from a branch at main', t => {
  const { dir, git, commit } = repository(t);
  git('checkout', '-b', 'job/landed');
  const landed = commit('fix.txt', 'worker fix');
  git('checkout', 'main');
  git('merge', '--ff-only', 'job/landed');
  commit('later.txt', 'later main change');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('branch', 'job/empty', 'main');

  for (const branch of ['job/landed', 'job/empty']) {
    assert.equal(git('log', '--oneline', `origin/main..${branch}`), '');
    assert.equal(git('merge-base', '--is-ancestor', branch, 'origin/main'), '');
  }
  assert.equal(git('rev-parse', 'job/landed'), landed);
  assert.equal(classifyJobBranch('job/landed', dir).status, 'landed');
  const empty = classifyJobBranch('job/empty', dir);
  assert.equal(empty.status, 'genuinely-empty');
  assert.match(empty.reason, /worker output cannot be inferred/);
  // Equality also holds immediately after landing. Never report "produced nothing".
  assert.equal(classifyJobBranch('main', dir).reason, empty.reason);
});

test('unlanded commits remain visible to the existing collision caller', t => {
  const { dir, git, commit } = repository(t);
  git('checkout', '-b', 'job/linear-BRO-2814-pending');
  const sha = commit('fix.txt', 'pending fix');
  const result = classifyJobBranch('HEAD', dir);
  assert.equal(result.status, 'unlanded-with-commits');
  assert.deepEqual(result.unlandedCommits, [`${sha} pending fix`]);
  assert.deepEqual(unlandedCommitsFor('HEAD', dir, 'main'), result.unlandedCommits);
});

test('patch-equivalent rebased work is landed even without commit ancestry', t => {
  const { dir, git, commit } = repository(t);
  git('checkout', '-b', 'job/rebased');
  const original = commit('fix.txt', 'worker fix');
  git('checkout', 'main');
  commit('later.txt', 'independent main change');
  git('cherry-pick', original);
  git('update-ref', 'refs/remotes/origin/main', 'main');
  assert.throws(() => git('merge-base', '--is-ancestor', 'job/rebased', 'origin/main'));
  assert.equal(classifyJobBranch('job/rebased', dir).status, 'landed');
  assert.match(classifyJobBranch('job/rebased', dir).reason, /patch-equivalent/);
  assert.deepEqual(unlandedCommitsFor('job/rebased', dir, 'main'), []);
});

test('missing refs and non-repositories are unknown, never genuinely empty', t => {
  const { dir, git } = repository(t);
  assert.equal(classifyJobBranch('job/missing', dir).status, 'unknown');
  assert.equal(classifyJobBranch('--all', dir).status, 'unknown');
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal(classifyJobBranch('HEAD', dir).status, 'unknown');
  rmSync(path.join(dir, '.git'), { recursive: true, maxRetries: 10, retryDelay: 50 });
  assert.equal(classifyJobBranch('HEAD', dir).status, 'unknown');
});

test('uses the supplied default branch', t => {
  const { dir, git } = repository(t);
  git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  assert.equal(classifyJobBranch('HEAD', dir, 'trunk').status, 'genuinely-empty');
});

test('empty cherry output for an unlanded merge is inconclusive', t => {
  const { dir, git, commit, base } = repository(t);
  commit('main.txt', 'main advance');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(path.join(dir, 'resolution.txt'), 'merge-only work');
  git('add', 'resolution.txt');
  const tree = git('write-tree');
  const merge = git('commit-tree', tree, '-p', 'HEAD', '-p', base, '-m', 'merge resolution');
  git('update-ref', 'refs/heads/job/merge-only', merge);
  assert.equal(git('cherry', 'origin/main', 'job/merge-only'), '');
  assert.equal(classifyJobBranch('job/merge-only', dir).status, 'unknown');
});

test('equivalent patches do not hide unique merge-resolution work', t => {
  const { dir, git, commit, base } = repository(t);
  git('checkout', '-b', 'job/merged');
  const original = commit('fix.txt', 'worker fix');
  git('checkout', '-b', 'side', base);
  const side = commit('side.txt', 'side fix');
  git('checkout', 'main');
  commit('later.txt', 'main advance');
  git('cherry-pick', original, side);
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('checkout', 'job/merged');
  git('merge', '--no-commit', '--no-ff', 'side');
  commit('resolution.txt', 'unique merge resolution');
  assert.match(git('cherry', 'origin/main', 'HEAD'), /^- /);
  assert.doesNotMatch(git('cherry', 'origin/main', 'HEAD'), /^\+/m);
  assert.equal(git('diff', '--name-only', 'origin/main', 'HEAD', '--', 'resolution.txt'), 'resolution.txt');
  assert.equal(classifyJobBranch('job/merged', dir).status, 'unknown');
});

test('shallow ancestry is unknown when it cannot prove landing', t => {
  const { dir, git, commit, base } = repository(t);
  const tip = commit('fix.txt', 'worker fix');
  git('branch', 'job/landed', base);
  git('update-ref', 'refs/remotes/origin/main', tip);
  writeFileSync(path.join(dir, '.git', 'shallow'), `${tip}\n`);
  assert.equal(classifyJobBranch('job/landed', dir).status, 'unknown');
});

test('existing dispatch branch listing reports statuses and preserves collisions', t => {
  const { dir, git, commit } = repository(t);
  commit('fix.txt', 'landed fix');
  git('branch', 'job/linear-BRO-2814-landed');
  commit('later.txt', 'main advance');
  git('branch', 'job/linear-BRO-2814-empty');
  git('remote', 'add', 'origin', dir);
  git('checkout', '-b', 'job/linear-BRO-2814-pending');
  commit('pending.txt', 'unlanded fix');
  const messages = [];
  t.mock.method(console, 'error', message => messages.push(message));
  const statuses = listWorkBranchStatuses('linear:BRO-2814', { repoDir: dir });
  assert.deepEqual(statuses.map(s => [s.name, s.status]), [
    ['job/linear-BRO-2814-empty', 'genuinely-empty'],
    ['job/linear-BRO-2814-landed', 'landed'],
    ['job/linear-BRO-2814-pending', 'unlanded-with-commits'],
  ]);
  assert.deepEqual(findWorkBranchCollisions('linear:BRO-2814', statuses).map(s => s.name),
    ['job/linear-BRO-2814-pending']);
  assert.equal(messages.length, 3);
  assert.match(messages[0], /genuinely-empty .*worker output cannot be inferred/);
  assert.match(messages[1], /landed .*ancestor of upstream/);
  assert.match(messages[2], /unlanded-with-commits/);
});
