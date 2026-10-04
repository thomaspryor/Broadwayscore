// BRO-2904: the landing script's legacy direct path must (a) exit non-zero when it
// cannot check out main and (b) never abandon its own "wt-integ-<pid>" stash, on a
// failed checkout, a die() from a path with no explicit restore, or a kill signal.
//
// Runs the REAL script (LAND_LEGACY_DIRECT=1, no origin/main re-exec) against a
// throwaway repo + bare origin. Run: node --test scripts/merge-worktree-to-main.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'merge-worktree-to-main.sh');
const ENV = {
  ...process.env,
  LAND_LEGACY_DIRECT: '1',
  MERGE_SCRIPT_NO_REEXEC: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// Bare origin + clone on main with a pushed feature branch. `auditStub` is the
// body of scripts/lib/run-push-audits.sh committed on main (the script runs it
// from the shared checkout before pushing).
function fixture(auditStub) {
  const root = mkdtempSync(join(tmpdir(), 'bro2904-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  spawnSync('git', ['init', '-q', '--bare', origin]);
  spawnSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'branch', '-M', 'main');
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  if (auditStub) {
    mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
    writeFileSync(join(repo, 'scripts/lib/run-push-audits.sh'), auditStub);
  }
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feature-branch');
  writeFileSync(join(repo, 'feature.txt'), 'feature\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'feature');
  git(repo, 'push', '-q', 'origin', 'feature-branch');
  git(repo, 'checkout', '-q', 'main');
  return { root, repo };
}

test('checkout of main fails after a successful stash: exits non-zero, stash restored', () => {
  const { root, repo } = fixture();
  try {
    // `other` untracks tracked.txt, so checking out main would overwrite the
    // untracked file left in the tree: checkout refuses.
    git(repo, 'checkout', '-q', '-b', 'other', 'main');
    writeFileSync(join(repo, 'dirty.txt'), 'x\n');
    git(repo, 'add', 'dirty.txt');
    git(repo, 'rm', '-q', '--cached', 'tracked.txt');
    git(repo, 'commit', '-q', '-m', 'untrack tracked.txt on other');
    writeFileSync(join(repo, 'tracked.txt'), 'untracked-clash\n');
    appendFileSync(join(repo, 'dirty.txt'), 'dirtied\n'); // tracked + dirty: stash has work to do
    const before = git(repo, 'status', '--porcelain');

    const r = spawnSync('bash', [SCRIPT, 'feature-branch'], { cwd: repo, encoding: 'utf8', env: ENV });
    assert.notEqual(r.status, 0, `exit code lied (0) after a checkout failure:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /could not checkout main/);
    assert.equal(git(repo, 'stash', 'list').trim(), '', 'stash abandoned after checkout failure');
    assert.equal(git(repo, 'status', '--porcelain'), before, 'working tree not restored');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const sig of ['TERM', 'HUP', 'INT']) {
  test(`killed by SIG${sig} while holding its stash: stash is restored, exit non-zero`, async () => {
    const marker = join(tmpdir(), `bro2904-marker-${process.pid}-${sig}`);
    rmSync(marker, { force: true });
    // The audit step runs after the stash + merges and before the push: park there.
    const { root, repo } = fixture(`#!/usr/bin/env bash\ntouch ${marker}\nsleep 60\n`);
    let child;
    try {
      chmodSync(join(repo, 'scripts/lib/run-push-audits.sh'), 0o755);
      appendFileSync(join(repo, 'tracked.txt'), 'daemon churn\n');
      const before = git(repo, 'status', '--porcelain');
      child = spawn('bash', [SCRIPT, 'feature-branch'], { cwd: repo, env: ENV, detached: true, stdio: 'ignore' });
      const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
      for (let i = 0; i < 300 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(existsSync(marker), 'script never reached the audit step (fixture broken)');
      assert.match(git(repo, 'stash', 'list'), /wt-integ-/, 'precondition: the script is holding a stash');
      process.kill(-child.pid, `SIG${sig}`); // whole group: the sleeping audit dies too
      const { code, signal } = await exited;
      assert.ok(code !== 0 || signal, `exited 0 after SIG${sig}`);
      assert.equal(git(repo, 'stash', 'list').trim(), '', `stash abandoned after SIG${sig}`);
      assert.match(git(repo, 'status', '--porcelain'), /tracked\.txt/, 'stashed change not restored');
      assert.equal(before.includes('tracked.txt'), true);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(root, { recursive: true, force: true }); rmSync(marker, { force: true }); }
  });
}
