// BRO-7887: scripts/lib/sync-stale-commands.sh syncs a global ~/.claude/commands skill only when it is strictly
// behind the repo. Runs the real script against a scratch HOME and a scratch Broadwayscore-shaped repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sync-stale-commands.sh');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

function fixture(origin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cmds-'));
  const repo = path.join(tmp, 'repo'); const home = path.join(tmp, 'home');
  fs.mkdirSync(repo); git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'remote', 'add', 'origin', origin);
  for (const n of ['a', 'b', 'c']) write(path.join(repo, '.claude/commands', `${n}.md`), `${n} v1\n`);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'v1');
  for (const n of ['a', 'b', 'c']) write(path.join(repo, '.claude/commands', `${n}.md`), `${n} v2\n`);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'v2'); git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const cmds = path.join(home, '.claude/commands');
  fs.mkdirSync(cmds, { recursive: true }); git(path.join(home, '.claude'), 'init', '-q');
  git(path.join(home, '.claude'), 'config', 'user.email', 't@t'); git(path.join(home, '.claude'), 'config', 'user.name', 't');
  write(path.join(cmds, 'a.md'), 'a v1\n'); // strictly behind: an older repo version
  write(path.join(cmds, 'b.md'), 'b v1\nhome-only line\n'); // home-only content
  write(path.join(cmds, 'c.md'), 'c v1\n'); // older version, but edited below (uncommitted)
  git(path.join(home, '.claude'), 'add', '-A'); git(path.join(home, '.claude'), 'commit', '-qm', 'base');
  write(path.join(cmds, 'c.md'), 'c v1\nuncommitted\n');
  return { repo, home, cmds };
}
const run = (repo, home) => execFileSync('bash', [SCRIPT, repo], { encoding: 'utf8', env: { ...process.env, HOME: home } }).trim();

test('syncs only a strictly-behind global copy, commits it, never touches home-only or uncommitted edits', () => {
  const { repo, home, cmds } = fixture('https://github.com/thomaspryor/Broadwayscore.git');
  assert.equal(run(repo, home), 'a.md');
  assert.equal(fs.readFileSync(path.join(cmds, 'a.md'), 'utf8'), 'a v2\n');
  assert.match(fs.readFileSync(path.join(cmds, 'b.md'), 'utf8'), /home-only/, 'home-only content is kept');
  assert.match(fs.readFileSync(path.join(cmds, 'c.md'), 'utf8'), /uncommitted/, 'an uncommitted home edit is kept');
  assert.match(git(path.join(home, '.claude'), 'log', '-1', '--format=%s'), /auto-sync a\.md/);
  assert.equal(git(path.join(home, '.claude'), 'status', '--short', '--', 'commands/a.md'), '', 'the sync is committed');
});

test('another repo never replaces a global skill', () => {
  const { repo, home, cmds } = fixture('https://github.com/someone/other.git');
  assert.equal(run(repo, home), '');
  assert.equal(fs.readFileSync(path.join(cmds, 'a.md'), 'utf8'), 'a v1\n');
});

test('a worktree whose copy differs from origin/main does not sync', () => {
  const { repo, home, cmds } = fixture('https://github.com/thomaspryor/Broadwayscore.git');
  write(path.join(repo, '.claude/commands/a.md'), 'a local wip\n');
  assert.equal(run(repo, home), '');
  assert.equal(fs.readFileSync(path.join(cmds, 'a.md'), 'utf8'), 'a v1\n');
});

test('a failed ~/.claude commit restores the old copy and reports nothing (next session retries)', () => {
  const { repo, home, cmds } = fixture('https://github.com/thomaspryor/Broadwayscore.git');
  fs.writeFileSync(path.join(home, '.claude/.git/index.lock'), ''); // a parallel git holds the index
  assert.equal(run(repo, home), '');
  fs.rmSync(path.join(home, '.claude/.git/index.lock'));
  assert.equal(fs.readFileSync(path.join(cmds, 'a.md'), 'utf8'), 'a v1\n', 'copy reverted, ~/.claude not left dirty');
  assert.equal(run(repo, home), 'a.md', 'retried on the next run');
});

test('an untracked global file is left alone', () => {
  const { repo, home, cmds } = fixture('https://github.com/thomaspryor/Broadwayscore.git');
  git(path.join(home, '.claude'), 'rm', '-q', '--cached', 'commands/a.md'); git(path.join(home, '.claude'), 'commit', '-qm', 'untrack');
  assert.equal(run(repo, home), '');
  assert.equal(fs.readFileSync(path.join(cmds, 'a.md'), 'utf8'), 'a v1\n');
});
