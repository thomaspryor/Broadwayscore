// BRO-7130: a failed clone in setup-local-data.sh must report the real cause.
// A full disk ("No space left on device") used to be swallowed by 2>/dev/null
// and reported as "Check your access permissions".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LIB = path.resolve('scripts/lib/clone-failure.sh');

// A fake `git` on PATH that prints $STUB_ERR to stderr and exits $STUB_RC.
function stubBin() {
  const d = mkdtempSync(path.join(tmpdir(), 'clone-stub-'));
  const git = path.join(d, 'git');
  writeFileSync(git, '#!/bin/sh\n[ -n "$STUB_ERR" ] && printf "%s\\n" "$STUB_ERR" >&2\necho "prompt=$GIT_TERMINAL_PROMPT" >&2\nexit "${STUB_RC:-0}"\n');
  chmodSync(git, 0o755);
  return d;
}

function runClone(err, rc, url = 'https://github.com/x/y.git', prefix = '') {
  const bin = stubBin();
  return spawnSync('bash', ['-c', `. "${LIB}"; ${prefix} run_clone "Failed to clone broadway-review-texts" "Check your access permissions." git clone "$1" /tmp/x`, '_', url], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_ERR: err, STUB_RC: String(rc) },
  });
}

test('ENOSPC is reported as a full disk with the cleanup, never as an access problem', () => {
  const r = runClone('fatal: write error: No space left on device', 128);
  assert.equal(r.status, 128);
  assert.match(r.stdout, /disk is full \(No space left on device\)/);
  assert.match(r.stdout, /worktree remove/);
  assert.doesNotMatch(r.stdout, /access permissions/);
  assert.match(r.stdout, /ERROR:   git: fatal: write error: No space left on device/);
  for (const line of r.stdout.trim().split('\n')) assert.match(line, /^ERROR:/, 'every line survives the bootstrap ERROR filter');
});

test('other failures keep the hint and show git\'s real error, with credentials redacted', () => {
  const r = runClone("fatal: repository 'https://x-access-token:ghs_SECRET123@github.com/x/y.git/' not found", 128);
  assert.equal(r.status, 128);
  assert.match(r.stdout, /Failed to clone broadway-review-texts\. Check your access permissions\./);
  assert.match(r.stdout, /not found/);
  assert.doesNotMatch(r.stdout, /SECRET123/);
});

test('success prints nothing and returns 0', () => {
  const r = runClone('', 0);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('an env prefix (GIT_TERMINAL_PROMPT=0) still reaches git', () => {
  const r = runClone('boom', 1, 'u', 'GIT_TERMINAL_PROMPT=0');
  assert.match(r.stdout, /prompt=0/);
});

test('setup-local-data.sh and its clone helper route every clone through run_clone and silence none', () => {
  const src = ['scripts/setup-local-data.sh', 'scripts/lib/clone-review-texts-source.sh'].map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(src, /clone[^\n]*2>\/dev\/null/, 'a clone with stderr discarded hides its cause');
  const clones = src.split('\n').filter((l) => /\b(git clone|gh repo clone)\b/.test(l) && !/^\s*#/.test(l));
  assert.ok(clones.length >= 7, `found ${clones.length} clone lines`);
  for (const l of clones) assert.match(l, /run_clone/, l.trim());
});

test('clone_review_texts_source names a full disk on stderr and keeps stdout for the sha only', () => {
  const bin = stubBin();
  const src = mkdtempSync(path.join(tmpdir(), 'rt-src-'));
  const r = spawnSync('bash', ['-c', `. "${path.resolve('scripts/lib/clone-review-texts-source.sh')}"; clone_review_texts_source "$1" "$1/out"`, '_', src], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_ERR: 'fatal: write error: No space left on device', STUB_RC: '128' },
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /disk is full/);
});
