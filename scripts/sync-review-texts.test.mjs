/**
 * BRO-2254 — scripts/sync-review-texts.sh must never commit or push on top of
 * a `git pull --rebase` that stopped on a conflict.
 *
 * The old line was `git pull --rebase origin main -q 2>/dev/null || true`.
 * When local commits conflicted with the remote, the pull left the checkout
 * mid-rebase, `|| true` swallowed it, and the following `git add -A` staged
 * the conflict markers. The script now goes through guarded_pull_rebase()
 * (scripts/lib/rebase-guards.sh), which aborts the rebase and fails loud.
 *
 * The script resolves its checkout as $(dirname $0)/../data/review-texts, so
 * each test copies it into a temp tree whose scripts/lib is a symlink to the
 * real one and whose data/review-texts is a clone of a local bare "origin".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.SYNC_REVIEW_TEXTS_SCRIPT || path.join(HERE, 'sync-review-texts.sh');
const LIB = path.join(HERE, 'lib');
const GUARDS = path.join(LIB, 'rebase-guards.sh');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, rel, obj) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj, null, 2) + '\n');
}

/** origin (bare) + data/review-texts clone + another clone that races it. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-rt-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  // Fixtures null global git config, so turn auto-gc/maintenance off in the
  // bare repo itself (receive-pack reads its own config).
  for (const [k, v] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) {
    git(origin, 'config', k, v);
  }
  const seed = path.join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  write(seed, 'show-a/outlet--critic.json', { fullText: 'base', contentTier: 'excerpt' });
  write(seed, 'show-b/outlet--critic.json', { fullText: 'b', contentTier: 'complete' });
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');

  const tree = path.join(root, 'tree');
  fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'data'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(tree, 'scripts', 'sync-review-texts.sh'));
  fs.symlinkSync(LIB, path.join(tree, 'scripts', 'lib'));
  const local = path.join(tree, 'data', 'review-texts');
  git(root, 'clone', '-q', '-b', 'main', origin, local);

  const other = path.join(root, 'other');
  git(root, 'clone', '-q', '-b', 'main', origin, other);
  return { root, origin, local, other, script: path.join(tree, 'scripts', 'sync-review-texts.sh') };
}

function run(script) {
  return spawnSync('bash', [script, 'test: sync'], { env: ENV, encoding: 'utf8', timeout: 120_000 });
}

function midRebase(repo) {
  return ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(git(repo, 'rev-parse', '--git-path', d).replace(/^(?!\/)/, repo + '/')));
}

test('conflicting local commit: aborts the rebase and exits 1 without pushing conflict markers', () => {
  const f = fixture();
  try {
    // A previous run committed locally but never pushed.
    write(f.local, 'show-a/outlet--critic.json', { fullText: 'local edit', contentTier: 'complete' });
    git(f.local, 'commit', '-qam', 'local');
    // Meanwhile CI changed the same lines.
    write(f.other, 'show-a/outlet--critic.json', { fullText: 'ci edit', contentTier: 'truncated' });
    git(f.other, 'commit', '-qam', 'ci');
    git(f.other, 'push', '-q', 'origin', 'HEAD:main');
    const originBefore = git(f.origin, 'rev-parse', 'main');

    const r = run(f.script);
    assert.notEqual(r.status, 0, `must fail loud; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /stopped on a conflict/);
    assert.equal(midRebase(f.local), false, 'the half-finished rebase must be aborted');
    assert.equal(git(f.origin, 'rev-parse', 'main'), originBefore, 'nothing may be pushed');
    const originFile = git(f.origin, 'show', 'main:show-a/outlet--critic.json');
    assert.doesNotMatch(originFile, /^(<<<<<<<|>>>>>>>|=======)/m);
    // The local commit is still there for a human to resolve.
    assert.equal(git(f.local, 'log', '-1', '--format=%s'), 'local');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('uncommitted local change + unrelated remote commit still syncs (exit 0)', () => {
  const f = fixture();
  try {
    write(f.other, 'show-b/outlet--critic.json', { fullText: 'b2', contentTier: 'complete' });
    git(f.other, 'commit', '-qam', 'ci');
    git(f.other, 'push', '-q', 'origin', 'HEAD:main');
    write(f.local, 'show-a/outlet--critic.json', { fullText: 'local edit', contentTier: 'complete' });

    const r = run(f.script);
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(JSON.parse(git(f.origin, 'show', 'main:show-a/outlet--critic.json')).fullText, /local edit/);
    assert.equal(JSON.parse(git(f.origin, 'show', 'main:show-b/outlet--critic.json')).fullText, 'b2');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('guarded_pull_rebase: conflict returns 1 and leaves no rebase; refusal to start returns 0', () => {
  const f = fixture();
  try {
    const guarded = (repo) => spawnSync('bash', ['-c', `source "${GUARDS}" && guarded_pull_rebase origin main -q`], {
      cwd: repo, env: ENV, encoding: 'utf8',
    });
    // Dirty tracked file: git refuses before starting; old `|| true` semantics.
    write(f.local, 'show-b/outlet--critic.json', { fullText: 'dirty' });
    write(f.other, 'show-a/outlet--critic.json', { fullText: 'ci edit' });
    git(f.other, 'commit', '-qam', 'ci');
    git(f.other, 'push', '-q', 'origin', 'HEAD:main');
    const dirty = guarded(f.local);
    assert.equal(dirty.status, 0, dirty.stderr);
    assert.match(dirty.stdout, /local changes not yet committed/);
    assert.doesNotMatch(dirty.stdout, /::warning::/, 'the routine dirty-tree refusal is not a warning');

    git(f.local, 'checkout', '-q', '--', 'show-b/outlet--critic.json');
    write(f.local, 'show-a/outlet--critic.json', { fullText: 'local edit' });
    git(f.local, 'commit', '-qam', 'local');
    const conflict = guarded(f.local);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stdout, /::error::/);
    assert.equal(midRebase(f.local), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('guarded_pull_rebase: an unfinished rebase/merge it did not start is left untouched and returns 1', () => {
  const f = fixture();
  try {
    const guarded = (repo) => spawnSync('bash', ['-c', `source "${GUARDS}" && guarded_pull_rebase origin main -q`], {
      cwd: repo, env: ENV, encoding: 'utf8',
    });
    // Someone (a person resolving, or a crashed run) is mid-merge with a conflict.
    git(f.local, 'checkout', '-q', '-b', 'side');
    write(f.local, 'show-a/outlet--critic.json', { fullText: 'side' });
    git(f.local, 'commit', '-qam', 'side');
    git(f.local, 'checkout', '-q', 'main');
    write(f.local, 'show-a/outlet--critic.json', { fullText: 'main' });
    git(f.local, 'commit', '-qam', 'main-local');
    spawnSync('git', ['merge', 'side'], { cwd: f.local, env: ENV });
    const mergeHead = path.join(f.local, '.git', 'MERGE_HEAD');
    assert.ok(fs.existsSync(mergeHead), 'fixture: merge must be stopped');
    const merging = guarded(f.local);
    assert.equal(merging.status, 1, merging.stdout + merging.stderr);
    assert.match(merging.stdout, /unfinished rebase\/merge/);
    assert.ok(fs.existsSync(mergeHead), 'the merge in progress must be left as found');
    git(f.local, 'merge', '--abort');

    // Mid-rebase started by someone else: not aborted.
    spawnSync('git', ['rebase', 'side'], { cwd: f.local, env: ENV });
    assert.equal(midRebase(f.local), true, 'fixture: rebase must be stopped');
    const rebasing = guarded(f.local);
    assert.equal(rebasing.status, 1);
    assert.equal(midRebase(f.local), true, 'a rebase this call did not start must not be aborted');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('guarded_pull_rebase: a non-local-changes failure (bad remote) warns and returns 0', () => {
  const f = fixture();
  try {
    const r = spawnSync('bash', ['-c', `source "${GUARDS}" && guarded_pull_rebase no-such-remote main -q`], {
      cwd: f.local, env: ENV, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::warning::.*not a local-changes refusal/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
