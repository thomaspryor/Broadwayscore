// BRO-4688: commit-or-amend.sh must never rewrite the remote's own tip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/lib/commit-or-amend.sh');
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

function repo() {
  const d = mkdtempSync(path.join(tmpdir(), 'coa-'));
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'commit', '-q', '--allow-empty', '-m', 'base');
  return d;
}
const run = (cwd, ...args) => execFileSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

test('HEAD == upstream tip (our commit was dropped): creates a NEW commit, tip survives', () => {
  const d = repo();
  git(d, 'commit', '-q', '--allow-empty', '-m', 'remote tip');
  const tip = git(d, 'rev-parse', 'HEAD');
  git(d, 'tag', 'up');
  run(d, 'up', 'reconciled');
  assert.equal(git(d, 'rev-parse', 'HEAD~1'), tip, 'remote tip must remain HEAD~1, not be rewritten');
  assert.equal(git(d, 'log', '-1', '--format=%s'), 'reconciled');
});

test('HEAD ahead of upstream: amends our commit (count unchanged)', () => {
  const d = repo();
  git(d, 'tag', 'up');
  git(d, 'commit', '-q', '--allow-empty', '-m', 'ours');
  const before = git(d, 'rev-list', '--count', 'HEAD');
  run(d, 'up', 'ignored');
  assert.equal(git(d, 'rev-list', '--count', 'HEAD'), before);
  assert.equal(git(d, 'log', '-1', '--format=%s'), 'ours');
});

test('unresolvable/empty upstream ref: legacy amend', () => {
  const d = repo();
  git(d, 'commit', '-q', '--allow-empty', '-m', 'ours');
  const before = git(d, 'rev-list', '--count', 'HEAD');
  run(d, '');
  run(d, 'no-such-ref');
  assert.equal(git(d, 'rev-list', '--count', 'HEAD'), before);
});

test('every post-rebase amend site in the push paths goes through the helper', () => {
  for (const f of ['.github/actions/push-core-data/action.yml', '.github/actions/push-review-texts/action.yml', 'scripts/lib/push-with-retry.sh', 'scripts/lib/safe-sync-review-texts.sh']) {
    const src = readFileSync(path.resolve(path.dirname(SCRIPT), '../..', f), 'utf8');
    const bare = src.split('\n').filter((l) => /git commit --amend/.test(l) && !/^\s*#/.test(l));
    assert.deepEqual(bare, [], `${f} has a bare git commit --amend (rewrites upstream tip when rebase dropped our commit)`);
  }
});
