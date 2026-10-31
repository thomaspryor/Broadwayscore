/**
 * BRO-3942 — scripts/lib/safe-sync-review-texts.sh must not drop a local merge
 * commit from HEAD's ancestry when it syncs a diverged checkout.
 *
 * A plain `git rebase -X theirs origin/main` (no --rebase-merges) linearises
 * the outgoing range and silently drops merge commits (BRO-3899). When the
 * range holds a merge commit the script now runs `git merge -X ours` instead
 * (same "local wins" meaning); otherwise it keeps rebasing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.SAFE_SYNC_SCRIPT || path.join(HERE, 'safe-sync-review-texts.sh');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function write(dir, rel, obj) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj, null, 2) + '\n');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-sync-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  // Fixtures null global git config, so turn auto-gc/maintenance off in the
  // bare repo itself (receive-pack reads its own config).
  for (const [k, v] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) {
    git(origin, 'config', k, v);
  }
  const local = path.join(root, 'local');
  git(root, 'clone', '-q', origin, local);
  git(local, 'checkout', '-q', '-b', 'main');
  write(local, 'a/x.json', { fullText: 'base' });
  write(local, 'b/y.json', { fullText: 'base' });
  git(local, 'add', '-A');
  git(local, 'commit', '-qm', 'seed');
  git(local, 'push', '-q', 'origin', 'HEAD:main');
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', '-b', 'main', origin, other);
  return { root, origin, local, other };
}

/** Give `local` a genuine two-parent merge commit that is not on origin. */
function addLocalMerge(local) {
  git(local, 'checkout', '-q', '-b', 'side');
  write(local, 'a/side.json', { fullText: 'side' });
  git(local, 'add', '-A');
  git(local, 'commit', '-qm', 'side');
  git(local, 'checkout', '-q', 'main');
  write(local, 'a/main.json', { fullText: 'main' });
  git(local, 'add', '-A');
  git(local, 'commit', '-qm', 'main-local');
  git(local, 'merge', '-q', '--no-ff', '--no-edit', 'side');
  return git(local, 'rev-parse', 'HEAD');
}

function pushFromOther(other, rel, obj, msg) {
  write(other, rel, obj);
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', msg);
  git(other, 'push', '-q', 'origin', 'HEAD:main');
}

const run = (repo) => spawnSync('bash', [SCRIPT, repo, 'main'], { env: ENV, encoding: 'utf8', timeout: 120_000 });
const isAncestor = (repo, a, b) =>
  spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo, env: ENV }).status === 0;

test('local merge commit stays an ancestor of the pushed tip', () => {
  const f = fixture();
  try {
    const mergeSha = addLocalMerge(f.local);
    pushFromOther(f.other, 'b/y.json', { fullText: 'ci' }, 'ci');

    const r = run(f.local);
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /merging origin\/main instead of rebasing/);
    const tip = git(f.origin, 'rev-parse', 'main');
    assert.ok(isAncestor(f.local, mergeSha, tip), 'merge commit must survive in origin/main ancestry');
    assert.equal(JSON.parse(git(f.origin, 'show', 'main:b/y.json')).fullText, 'ci');
    assert.equal(JSON.parse(git(f.origin, 'show', 'main:a/side.json')).fullText, 'side');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('merge path: conflicting line resolves to the local side, like rebase -X theirs', () => {
  const f = fixture();
  try {
    addLocalMerge(f.local);
    write(f.local, 'a/x.json', { fullText: 'local wins' });
    git(f.local, 'commit', '-qam', 'local edit');
    pushFromOther(f.other, 'a/x.json', { fullText: 'remote' }, 'ci');

    const r = run(f.local);
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.equal(JSON.parse(git(f.origin, 'show', 'main:a/x.json')).fullText, 'local wins');
    assert.equal(fs.existsSync(path.join(f.local, '.git', 'MERGE_HEAD')), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('no merge commit in range: keeps the linear rebase path', () => {
  const f = fixture();
  try {
    write(f.local, 'a/x.json', { fullText: 'local' });
    git(f.local, 'commit', '-qam', 'local');
    pushFromOther(f.other, 'b/y.json', { fullText: 'ci' }, 'ci');

    const r = run(f.local);
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /instead of rebasing/);
    assert.equal(git(f.origin, 'rev-list', '--merges', '--count', 'main'), '0', 'history stays linear');
    assert.equal(JSON.parse(git(f.origin, 'show', 'main:a/x.json')).fullText, 'local');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
