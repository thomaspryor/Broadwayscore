// browser-recovery-helpers.js checkpoint() against a real temp review-texts
// repo (BRO-7171). Before the fix it ran `git add -A` (sweeping another
// writer's half-written file into our commit) and swallowed a failed push
// with a WARNING while the run kept counting "recovered" reviews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brh-checkpoint-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.com',
  PUSH_SKIP_LEDGER: '1', PUSH_SKIP_FAILURE_LEDGER: '1', PUSH_SKIP_UNSHALLOW: '1',
  PUSH_API_FALLBACK_DISABLE: '1', PUSH_RESCUE_DISABLE: '1', PUSH_SKIP_STALL_DIAGNOSTICS: '1',
  PUSH_FAILURE_LOG: path.join(ROOT, 'push-failures.jsonl'),
  PUSH_DEADLINE_SEC: '30',
  REVIEW_TEXTS_LOCK_PATH: path.join(ROOT, 'review-texts.lock'),
  REVIEW_TEXTS_PENDING_PATH: path.join(ROOT, 'pending.json'),
});

const origin = path.join(ROOT, 'broadway-review-texts.git');
git(ROOT, 'init', '-q', '--bare', '-b', 'main', origin);
const local = path.join(ROOT, 'local');
git(ROOT, 'clone', '-q', origin, local);
fs.mkdirSync(path.join(local, 'show-2026'));
const ours = path.join(local, 'show-2026', 'nytimes--a.json');
const theirs = path.join(local, 'show-2026', 'variety--b.json');
fs.writeFileSync(ours, JSON.stringify({ fullText: 'stub' }) + '\n');
fs.writeFileSync(theirs, JSON.stringify({ fullText: 'other' }) + '\n');
git(local, 'add', '-A');
git(local, 'commit', '-q', '-m', 'init');
git(local, 'push', '-q', 'origin', 'HEAD:main');

// REVIEW_TEXTS_DIR is read at module load.
process.env.REVIEW_TEXTS_DIR = local;
const helpers = require('./browser-recovery-helpers.js');

const track = (p) => { if (helpers.RUN_WRITES) helpers.RUN_WRITES.add(p); };
const originText = (rel) => JSON.parse(git(origin, 'show', `main:${rel}`)).fullText;

test('checkpoint commits only the files this run wrote', () => {
  fs.writeFileSync(ours, JSON.stringify({ fullText: 'recovered' }) + '\n');
  track(ours);
  fs.writeFileSync(theirs, JSON.stringify({ fullText: 'half-written by another writer' }) + '\n');
  helpers.checkpoint({ recovered: 1, dryRun: false }, 'Test browser recovery');
  assert.equal(originText('show-2026/nytimes--a.json'), 'recovered');
  assert.equal(originText('show-2026/variety--b.json'), 'other', "another writer's uncommitted edit must not ride along");
  git(local, 'checkout', '--', 'show-2026/variety--b.json');
});

test('checkpoint throws when the push fails instead of warning and carrying on', () => {
  const hook = path.join(origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/bash\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  try {
    fs.writeFileSync(ours, JSON.stringify({ fullText: 'recovered again, longer' }) + '\n');
    track(ours);
    assert.throws(() => helpers.checkpoint({ recovered: 2, dryRun: false }, 'Test browser recovery', { retries: 1 }), /push failed/);
    assert.equal(originText('show-2026/nytimes--a.json'), 'recovered');
  } finally {
    fs.unlinkSync(hook);
  }
});
