// BRO-5567: when sync-memory-to-repo.sh --commit cannot push, it must not
// leave its auto-commit on local main. Nothing else pushes that commit and
// checkout-sync refuses to fast-forward past it, which stranded the shared
// checkout 146 commits behind origin on 2026-10-17. Drives the real script
// against throwaway repos whose origin rejects every push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync-memory-to-repo.sh');
const AUTO_MSG = 'chore: sync cloud-memory (session-stop auto-commit)';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function setup({ foreignCommit }) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'memsync-rollback-'));
  git(t, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(t, 'clone', '-q', 'origin.git', 'repo');
  const repo = path.join(t, 'repo');
  fs.mkdirSync(path.join(repo, 'cloud-memory'));
  fs.writeFileSync(path.join(repo, 'cloud-memory', 'a.md'), 'base\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  // Another writer moves origin on, so the clone is behind.
  git(t, 'clone', '-q', 'origin.git', 'other');
  const other = path.join(t, 'other');
  fs.appendFileSync(path.join(other, 'other.txt'), 'y\n');
  git(other, 'commit', '-q', '-am', 'other');
  git(other, 'push', '-q', 'origin', 'main');
  if (foreignCommit) {
    fs.writeFileSync(path.join(repo, 'foreign.txt'), 'z\n');
    git(repo, 'add', 'foreign.txt');
    git(repo, 'commit', '-q', '-m', "someone else's work");
  }
  const hook = path.join(t, 'origin.git', 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const mem = path.join(t, 'mem');
  fs.mkdirSync(mem);
  fs.writeFileSync(path.join(mem, 'a.md'), 'base\n');
  fs.writeFileSync(path.join(mem, 'b.md'), 'new note\n');
  return { repo, mem };
}

function runSync({ repo, mem }) {
  execFileSync('bash', [SCRIPT, '--commit'], {
    env: { ...process.env, MEMORY_SYNC_SRC: mem, MEMORY_SYNC_REPO: repo },
    stdio: 'ignore',
  });
  git(repo, 'fetch', '-q', 'origin');
}

test('a failed push rolls the auto-commit back and keeps the note on disk', () => {
  const env = setup({ foreignCommit: false });
  runSync(env);
  assert.equal(git(env.repo, 'rev-list', '--count', 'origin/main..HEAD'), '0');
  assert.ok(fs.existsSync(path.join(env.repo, 'cloud-memory', 'b.md')));
  assert.ok(!git(env.repo, 'log', '--format=%s', '-5').includes(AUTO_MSG));
});

test("a failed push leaves the commits in place when someone else's commit is also ahead", () => {
  const env = setup({ foreignCommit: true });
  runSync(env);
  const subjects = git(env.repo, 'log', '--format=%s', 'origin/main..HEAD');
  assert.match(subjects, /someone else's work/);
  assert.ok(subjects.includes(AUTO_MSG));
});
