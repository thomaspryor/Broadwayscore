// BRO-7128: every cloud session start printed "Could not check out <sha> from
// /home/user/broadway-review-texts" and kept a stale data/review-texts. The
// attached clone is shallow and sits on its session branch, behind its
// origin/main; cloning a shallow repo copies only what its local branches reach,
// so origin/main's commit was missing. The shallow test is the one that fails
// without the fix (a full local clone hardlinks every object).
// These tests run the real sourced helper against fixture repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, 'clone-review-texts-source.sh');
const SETUP = path.join(HERE, '..', 'setup-local-data.sh');
const { sourceSha } = require('./review-texts-refresh.js');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

// An upstream with two commits on main; returns [upstream path, c1, c2].
function upstream(dir) {
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'a.json'), '1');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'c1');
  const c1 = git(work, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(work, 'a.json'), '2');
  git(work, 'commit', '-qam', 'c2');
  const c2 = git(work, 'rev-parse', 'HEAD');
  const bare = path.join(dir, 'up.git');
  git(dir, 'clone', '-q', '--bare', work, bare);
  return [bare, c1, c2];
}

// A session-style clone: on a session branch at c1, no local main, origin/main at c2.
function sessionClone(dir, bare, c1, { depth } = {}) {
  const src = path.join(dir, 'src');
  git(dir, 'clone', '-q', ...(depth ? ['--depth', String(depth)] : []), `file://${bare}`, src);
  git(src, 'checkout', '-q', '-b', 'claude/session', c1);
  git(src, 'branch', '-q', '-D', 'main');
  return src;
}

function run(src, dest) {
  return spawnSync('bash', ['-c', `. "${HELPER}" && clone_review_texts_source "$1" "$2"`, '_', src, dest], { encoding: 'utf8', env: GIT_ENV });
}

test('copies origin/main when the source sits on an older session branch', (t) => {
  const dir = tmp(t);
  const [bare, c1, c2] = upstream(dir);
  const src = sessionClone(dir, bare, c1);
  const dest = path.join(dir, 'dest');
  const r = run(src, dest);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), c2);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), c2);
  assert.equal(fs.readFileSync(path.join(dest, 'a.json'), 'utf8'), '2');
  assert.equal(r.stdout.trim(), sourceSha(src), 'must match review-texts-refresh sourceSha, or every start re-copies');
});

test('works from a shallow session clone (cloud clones are shallow)', (t) => {
  const dir = tmp(t);
  const [bare, c1, c2] = upstream(dir);
  const src = sessionClone(dir, bare, c1, { depth: 2 });
  assert.equal(git(src, 'rev-parse', '--is-shallow-repository'), 'true');
  const dest = path.join(dir, 'dest');
  const r = run(src, dest);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), c2);
});

test('falls back to HEAD when the source has no origin/main', (t) => {
  const dir = tmp(t);
  const [bare, , c2] = upstream(dir);
  const src = path.join(dir, 'plain');
  git(dir, 'clone', '-q', bare, src);
  git(src, 'remote', 'remove', 'origin');
  const dest = path.join(dir, 'dest');
  const r = run(src, dest);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), c2);
  assert.equal(r.stdout.trim(), sourceSha(src));
});

test('fails with a clear error when the source is not a repo', (t) => {
  const dir = tmp(t);
  const r = run(path.join(dir, 'missing'), path.join(dir, 'dest'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ERROR: Local clone of .*missing failed/);
});

test('setup-local-data.sh uses the helper instead of an inline clone + checkout', () => {
  const sh = fs.readFileSync(SETUP, 'utf8');
  assert.match(sh, /\. "\$SCRIPT_DIR\/lib\/clone-review-texts-source\.sh"/);
  assert.match(sh, /clone_review_texts_source "\$REVIEW_TEXTS_SOURCE" "\$TEMP_DIR\/review-texts"/);
  assert.doesNotMatch(sh, /git clone -q "\$REVIEW_TEXTS_SOURCE"/);
});
