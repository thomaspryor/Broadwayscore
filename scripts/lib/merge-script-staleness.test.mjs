// scripts/lib/merge-script-staleness.test.mjs
//
// BRO-3873 step 4 (reviewer P0): scripts/merge-worktree-to-main.sh re-execs
// origin/main's copy of itself when origin's MERGE_SCRIPT_VERSION is newer,
// so a worktree branched before a landing-path change still gets the new
// behaviour — and NEVER re-execs an older origin copy (the 2026-09-20 dry
// run that did exactly that is the regression pinned here). The decision is
// merge_script_staleness_decision() in scripts/lib/merge-script-staleness.sh
// — invoked here through bash, never restated (CLAUDE.md rule 15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LIB = path.resolve(new URL('.', import.meta.url).pathname, 'merge-script-staleness.sh');
const SCRIPT = path.resolve(new URL('.', import.meta.url).pathname, '..', 'merge-worktree-to-main.sh');

function decide(localCopy, originCopy, libDir, env = {}) {
  const r = spawnSync('bash', ['-c', `source "$1"; merge_script_staleness_decision "$2" "$3" "$4"`, '_', LIB, localCopy, originCopy, libDir || ''], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
    timeout: 10_000,
  });
  assert.equal(r.status, 0, `bash exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

function version(file) {
  const r = spawnSync('bash', ['-c', `source "$1"; merge_script_version "$2"`, '_', LIB, file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return r.stdout.trim();
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mss-')); }
function copy(dir, name, v, extra = '') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/bash\n${v === null ? '' : `MERGE_SCRIPT_VERSION=${v}\n`}echo hi${extra}\n`);
  return p;
}

test('same version with a lib dir present → current (byte differences alone never re-exec)', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'lib'));
  assert.equal(decide(copy(d, 'local.sh', 2, ' # local tweak'), copy(d, 'origin.sh', 2), path.join(d, 'lib')), 'current');
});

test('origin/main carries a NEWER version → reexec (a pre-change worktree gets the new behaviour)', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'lib'));
  assert.equal(decide(copy(d, 'local.sh', 2), copy(d, 'origin.sh', 3), path.join(d, 'lib')), 'reexec');
  // a copy predating the version line is version 0
  assert.equal(decide(copy(d, 'old.sh', null), copy(d, 'origin.sh', 3), path.join(d, 'lib')), 'reexec');
});

test('REGRESSION 2026-09-20: origin/main OLDER than ours → current, never reexec the pre-change copy', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'lib'));
  assert.equal(decide(copy(d, 'local.sh', 2), copy(d, 'origin-old.sh', null), path.join(d, 'lib')), 'current');
  assert.equal(decide(copy(d, 'local.sh', 3), copy(d, 'origin.sh', 2), path.join(d, 'lib')), 'current');
});

test('origin/main copy unavailable (offline, fixture repo) → skip:no-origin-copy', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'lib'));
  assert.equal(decide(copy(d, 'local.sh', 2), path.join(d, 'missing.sh'), path.join(d, 'lib')), 'skip:no-origin-copy');
  fs.writeFileSync(path.join(d, 'empty.sh'), '');
  assert.equal(decide(copy(d, 'local.sh', 2), path.join(d, 'empty.sh'), path.join(d, 'lib')), 'skip:no-origin-copy');
});

test('loop guard and operator opt-out win over a newer origin', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'lib'));
  const l = copy(d, 'local.sh', 1), o = copy(d, 'origin.sh', 9);
  assert.equal(decide(l, o, path.join(d, 'lib'), { MERGE_SCRIPT_REEXECED: '1' }), 'skip:already-reexeced');
  assert.equal(decide(l, o, path.join(d, 'lib'), { MERGE_SCRIPT_NO_REEXEC: '1' }), 'skip:disabled');
});

test('a detached copy (no scripts/lib beside it) re-execs origin when origin is the same or newer, and is refused when origin is older', () => {
  const d = tmp();
  assert.equal(decide(copy(d, 'local.sh', 2), copy(d, 'origin.sh', 2), path.join(d, 'no-such-lib')), 'reexec');
  assert.equal(decide(copy(d, 'local.sh', 2), copy(d, 'origin-old.sh', 1), path.join(d, 'no-such-lib')), 'skip:origin-older');
});

test('the shipped script declares a MERGE_SCRIPT_VERSION (the guard is wired, not just present)', () => {
  assert.ok(Number(version(SCRIPT)) >= 2, `scripts/merge-worktree-to-main.sh must carry MERGE_SCRIPT_VERSION=N (got ${version(SCRIPT)})`);
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /MERGE_SCRIPT_STALENESS_GUARD/);
});
