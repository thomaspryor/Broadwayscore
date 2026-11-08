// BRO-7110: check-prod-deploy fetches main when the deployed commit is newer
// than the clone's last fetch, so a shallow clone (cloud) reads "live" instead
// of "could not tell". Real git repos in a temp dir; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensureLocalCommit, deployIsBehind } = require('../check-prod-deploy.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, name) => {
  writeFileSync(path.join(cwd, name), name);
  git(cwd, 'add', name);
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', name);
  return git(cwd, 'rev-parse', 'HEAD');
};

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cpd-local-'));
  const origin = path.join(dir, 'origin');
  const clone = path.join(dir, 'clone');
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  commit(origin, 'a');
  commit(origin, 'b');
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${origin}`, clone]);
  return { dir, origin, clone };
}

test('a deployed commit pushed after the shallow clone is fetched, then found', (t) => {
  const { dir, origin, clone } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  const deployed = commit(origin, 'c');
  assert.throws(() => git(clone, 'cat-file', '-e', `${deployed}^{commit}`), 'precondition: not local yet');
  assert.equal(ensureLocalCommit(deployed, { cwd: clone }), true);
  git(clone, 'cat-file', '-e', `${deployed}^{commit}`);
});

test('a commit already local does not fetch', () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push(args[0]); };
  assert.equal(ensureLocalCommit('abc1234', { exec }), true);
  assert.deepEqual(calls, ['cat-file']);
});

test('a failed fetch returns false instead of throwing', () => {
  const exec = (cmd, args) => { if (args[0] === 'fetch' || args[0] === 'cat-file') throw Object.assign(new Error('boom'), { stderr: 'fatal: no network' }); return ''; };
  assert.equal(ensureLocalCommit('abc1234567', { exec, cwd: process.cwd() }), false);
});

test('a deploy behind the target reads as behind in a shallow clone; equal, ahead or unknown does not', (t) => {
  const { dir, origin, clone } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deployed = git(clone, 'rev-parse', 'HEAD');
  commit(origin, 'c');
  git(clone, 'fetch', '-q', '--depth=2', 'origin', 'main');
  const target = git(clone, 'rev-parse', 'origin/main');
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  assert.equal(deployIsBehind(target, deployed, clone), true, 'prod older than the target: not live yet');
  assert.equal(deployIsBehind(deployed, deployed, clone), false, 'same commit is live, not behind');
  assert.equal(deployIsBehind(deployed, target, clone), false, 'prod newer than the target is not behind');
  assert.equal(deployIsBehind(target, 'f'.repeat(40), clone), false, 'a missing deploy object is not behind');
});
