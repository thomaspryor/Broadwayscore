// BRO-8213: land preflight blocks a CLAUDE.md over the claude-md-anchors.json byteLimit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkClaudeMdByteCap, blockMessage } from './land-preflight.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmps = [];
test.after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const sh = (cwd, cmd) => { const r = spawnSync('bash', ['-c', cmd], { cwd, env: ENV, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function repo(limit = 100) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  tmps.push(d);
  fs.mkdirSync(path.join(d, 'scripts/lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts/lib/claude-md-anchors.json'), JSON.stringify({ byteLimit: limit }));
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'a'.repeat(50));
  sh(d, 'git init -q -b main && git add -A && git commit -qm base && git branch base');
  return d;
}
const commit = (d, file, text) => { fs.writeFileSync(path.join(d, file), text); sh(d, `git add -A && git commit -qm x`); };

test('over-cap CLAUDE.md blocks with byte count and cap', () => {
  const d = repo();
  commit(d, 'CLAUDE.md', 'a'.repeat(150));
  const r = checkClaudeMdByteCap({ base: 'base', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'fail');
  assert.equal(r.bytes, 150);
  assert.equal(r.limit, 100);
  assert.match(blockMessage({ target: 'land/x', base: 'base', claudeMd: r }), /150B, over the 100B cap/);
});

test('under-cap CLAUDE.md passes', () => {
  const d = repo();
  commit(d, 'CLAUDE.md', 'a'.repeat(90));
  assert.equal(checkClaudeMdByteCap({ base: 'base', tip: 'HEAD', cwd: d }).status, 'clean');
});

test('multibyte content counts bytes, not characters', () => {
  const d = repo();
  commit(d, 'CLAUDE.md', 'é'.repeat(60));
  assert.equal(checkClaudeMdByteCap({ base: 'base', tip: 'HEAD', cwd: d }).status, 'fail');
});

test('branch that does not touch CLAUDE.md is not judged', () => {
  const d = repo();
  commit(d, 'other.txt', 'x');
  const r = checkClaudeMdByteCap({ base: 'base', tip: 'HEAD', cwd: d });
  assert.equal(r.status, 'clean');
  assert.match(r.reason, /not changed/);
});

test('git trouble is a skip, never a block', () => {
  const d = repo();
  assert.equal(checkClaudeMdByteCap({ base: 'nope', tip: 'HEAD', cwd: d }).status, 'skip');
});

test('no byteLimit configured is clean', () => {
  const d = repo(0);
  commit(d, 'CLAUDE.md', 'a'.repeat(5000));
  assert.equal(checkClaudeMdByteCap({ base: 'base', tip: 'HEAD', cwd: d }).status, 'clean');
});
