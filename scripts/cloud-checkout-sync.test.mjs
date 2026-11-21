import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trySyncCodeCheckout, getBehindAheadCounts, formatCodeCheckoutSyncMessage, backgroundCatchUp } = require('./lib/code-checkout-staleness.js');

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4230-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (p, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  };
  const commit = (message) => { git('add', '-A'); git('commit', '-qm', message); };
  const sync = (opts = {}) => trySyncCodeCheckout({ repoDir: dir, ...getBehindAheadCounts(dir), env: {}, ...opts });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'core.filemode', 'true');
    write('existing.txt', 'base\n');
    write('common.txt', 'base unrelated file\n');
    commit('base');
    git('branch', 'session');
    // Two commits become one on main, so git cherry cannot recognize them.
    git('checkout', '-q', 'session');
    write('existing.txt', 'first\n'); commit('first');
    write('existing.txt', 'landed\n'); commit('second');
    git('checkout', '-q', 'main');
    git('merge', '--squash', 'session'); commit('squashed');
    write('upstream-only.txt', 'new upstream work\n'); commit('upstream');
    write('common.txt', 'upstream unrelated file\n'); commit('update unrelated file');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', 'session');
    return fn({ dir, git, write, commit, sync });
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test('BRO-4230: squash-landed commits reset with --keep even when git cherry says missing', () => fixture(({ dir, git, write, sync }) => {
  assert.match(git('cherry', 'origin/main', 'HEAD'), /^\+ /);
  const before = git('rev-parse', 'HEAD');
  write('untracked.txt', 'keep me');
  const result = sync();
  assert.equal(result.synced, true, result.reason);
  assert.equal(result.alreadyLanded, true);
  assert.equal(result.from, before);
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main'));
  assert.equal(git('branch', '--show-current'), 'session');
  assert.equal(fs.readFileSync(path.join(dir, 'untracked.txt'), 'utf8'), 'keep me');
  const message = formatCodeCheckoutSyncMessage(result, dir);
  assert.match(message, /already landed/i);
  assert.match(message, /reset --keep/);
  assert.match(message, /force-with-lease/);
}));

test('BRO-4230: genuinely unlanded changes are refused without moving HEAD', () => fixture(({ git, write, commit, sync }) => {
  write('existing.txt', 'unlanded\n'); commit('new work');
  const before = git('rev-parse', 'HEAD');
  assert.equal(sync().synced, false);
  assert.equal(git('rev-parse', 'HEAD'), before);
}));

test('BRO-4230: rebased commits are recognized under different hashes', () => fixture(({ git, write, commit, sync }) => {
  const local = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('reset', '--hard', `${local}~2`);
  write('upstream.txt', 'different parent\n'); commit('upstream parent');
  git('cherry-pick', `${local}~1`, local);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', 'session');
  assert.match(git('cherry', 'origin/main', 'HEAD'), /^- /);
  assert.equal(sync().alreadyLanded, true);
}));

for (const kind of ['deleted', 'renamed', 'mode', 'binary', 'whitespace path']) {
  test(`BRO-4230: unlanded ${kind} changes are refused`, () => fixture(({ dir, git, write, commit, sync }) => {
    if (kind === 'deleted') git('rm', 'existing.txt');
    if (kind === 'renamed') git('mv', 'existing.txt', 'renamed.txt');
    if (kind === 'mode') fs.chmodSync(path.join(dir, 'existing.txt'), 0o755);
    if (kind === 'binary') write('binary.dat', Buffer.from([0, 255, 1, 0]));
    if (kind === 'whitespace path') write(' \n[slug].txt', 'unlanded\n');
    commit(kind);
    const before = git('rev-parse', 'HEAD');
    assert.equal(sync().synced, false);
    assert.equal(git('rev-parse', 'HEAD'), before);
  }));
}

test('BRO-4230: uses reset --keep with a pinned target', () => fixture(({ git, sync }) => {
  const calls = [];
  const target = git('rev-parse', 'origin/main');
  assert.equal(sync({ execFn(cmd, args, opts) {
    calls.push(args);
    return execFileSync(cmd, args, opts);
  } }).synced, true);
  assert.ok(calls.some((args) => args.includes('reset') && args.includes('--keep') && args.includes(target)));
}));

test('BRO-4230: refuses if the session commits while landed paths are compared', () => fixture(({ git, write, commit, sync }) => {
  let comparisons = 0;
  let newHead;
  const result = sync({ execFn(cmd, args, opts) {
    const output = execFileSync(cmd, args, opts);
    if (args.includes('--no-renames') && ++comparisons === 2) {
      write('new-session-work.txt', 'must survive\n'); commit('session continued');
      newHead = git('rev-parse', 'HEAD');
    }
    return output;
  } });
  assert.equal(result.synced, false);
  assert.match(result.reason, /HEAD moved/);
  assert.equal(git('rev-parse', 'HEAD'), newHead);
}));

test('BRO-4230: interrupted reset restores a clean checkout and can retry', () => fixture(({ git, write, sync }) => {
  const before = git('rev-parse', 'HEAD');
  const result = sync({ startBackground: () => 12345, execFn(cmd, args, opts) {
    if (args.includes('reset')) {
      write('common.txt', 'upstream unrelated file\n');
      throw Object.assign(new Error('reset timed out'), { killed: true, signal: 'SIGTERM' });
    }
    return execFileSync(cmd, args, opts);
  } });
  assert.equal(result.synced, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.rolledBack, true);
  assert.equal(result.bgPid, 12345);
  assert.match(result.reason, /reset timed out/);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(sync().synced, true);
}));

test('BRO-4230: a comparison timeout never clears edits or starts reset recovery', () => fixture(({ dir, git, write, sync }) => {
  const before = git('rev-parse', 'HEAD');
  const result = sync({ startBackground: () => { throw new Error('must not start recovery'); }, execFn(cmd, args, opts) {
    if (args.includes('--no-renames')) {
      write('common.txt', 'upstream unrelated file\n');
      throw Object.assign(new Error('comparison timed out'), { killed: true, signal: 'SIGTERM' });
    }
    return execFileSync(cmd, args, opts);
  } });
  assert.equal(result.synced, false);
  assert.match(result.reason, /check refused/);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(dir, 'common.txt'), 'utf8'), 'upstream unrelated file\n');
  assert.ok(git('status', '--porcelain'));
}));

test('BRO-4230: an untracked upstream collision is preserved on refusal', () => fixture(({ dir, git, write, sync }) => {
  write('upstream-only.txt', 'session file\n');
  const before = git('rev-parse', 'HEAD');
  assert.equal(sync().synced, false);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(dir, 'upstream-only.txt'), 'utf8'), 'session file\n');
}));

for (const guard of ['disabled', 'detached', 'merge in progress', 'missing merge base']) {
  test(`BRO-4230: already-landed detection respects ${guard}`, () => fixture(({ dir, git, write, commit, sync }) => {
    if (guard === 'detached') git('checkout', '-q', '--detach');
    if (guard === 'merge in progress') fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), git('rev-parse', 'origin/main'));
    if (guard === 'missing merge base') {
      git('checkout', '-q', '--orphan', 'unrelated');
      git('rm', '-qrf', '.'); write('unrelated.txt', 'unrelated'); commit('no shared history');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-q', 'session');
    }
    const before = git('rev-parse', 'HEAD');
    const result = sync(guard === 'disabled' ? { env: { CODE_SYNC_DISABLED: '1' } } : {});
    assert.equal(result.synced, false);
    assert.equal(git('rev-parse', 'HEAD'), before);
  }));
}

test('BRO-4230: local edits matching main are still preserved without a reset', () => fixture(({ dir, git, write, sync }) => {
  const before = git('rev-parse', 'HEAD');
  // Matches upstream bytes but is an uncommitted change relative to HEAD.
  git('checkout', '-q', 'main');
  write('existing.txt', 'upstream revision\n'); git('add', '-A'); git('commit', '-qm', 'revision');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', 'session');
  write('existing.txt', 'upstream revision\n');
  assert.equal(sync().synced, false);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8'), 'upstream revision\n');
}));

test('BRO-4230: background catch-up uses the same already-landed detection', () => fixture(({ dir, git }) => {
  const result = backgroundCatchUp({ repoDir: dir, attempts: 1, env: {}, execFn(cmd, args, opts) {
    if (args.includes('fetch')) return '';
    return execFileSync(cmd, args, opts);
  } });
  assert.equal(result.synced, true, result.reason);
  assert.equal(result.alreadyLanded, true);
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main'));
}));

for (const kind of ['deleted', 'renamed', 'mode', 'binary', 'unusual path', 'empty']) {
  test(`BRO-4230: exact tree comparison handles ${kind} changes`, () => fixture(({ dir, git, write, commit, sync }) => {
    if (kind === 'deleted') git('rm', 'existing.txt');
    if (kind === 'renamed') git('mv', 'existing.txt', 'renamed.txt');
    if (kind === 'mode') fs.chmodSync(path.join(dir, 'existing.txt'), 0o755);
    if (kind === 'binary') write('binary.dat', Buffer.from([0, 255, 1, 0]));
    if (kind === 'unusual path') write('dir/[slug]\nfile.txt', 'literal path\n');
    if (kind === 'empty') git('commit', '-qm', 'empty', '--allow-empty');
    else commit(kind);
    const local = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    // Land the exact changed paths, retaining unrelated main changes.
    git('restore', '--source', local, '--staged', '--worktree', '--', '.');
    write('upstream-only.txt', 'new upstream work\n');
    git('add', '-A');
    if (git('diff', '--cached', '--name-only')) git('commit', '-qm', `land ${kind}`);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', 'session');
    assert.equal(sync().synced, true);
  }));
}
