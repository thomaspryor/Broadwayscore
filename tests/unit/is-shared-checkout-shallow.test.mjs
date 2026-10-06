// BRO-2049: the daily health digest surfaces a shallow shared checkout.
// Real functions only (CLAUDE.md section 15): the pure row builder, and the real health-check check run against
// real temporary git repositories (one full, one shallow clone).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessSharedCheckoutShallow } = require('../../scripts/lib/shared-checkout-shallow.js');
const { checkSharedCheckoutShallow } = require('../../scripts/health-check.js');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });

function makeRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2049-'));
  const origin = path.join(base, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(origin, 'f.txt'), `v${n}`);
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', `c${n}`);
  }
  const full = path.join(base, 'full');
  const shallow = path.join(base, 'shallow');
  execFileSync('git', ['clone', '-q', origin, full], { stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, shallow], { stdio: 'pipe' });
  return { base, full, shallow };
}

test('row builder: shallow warns with the unshallow command, full history passes, unreadable warns', () => {
  const shallow = assessSharedCheckoutShallow({ ci: false, shallow: true, root: '/Users/x/Broadwayscore' });
  assert.equal(shallow.status, 'warn');
  assert.match(shallow.message, /SHALLOW/);
  assert.equal(shallow.hint, 'Run: git -C /Users/x/Broadwayscore fetch --unshallow origin');
  const full = assessSharedCheckoutShallow({ ci: false, shallow: false });
  assert.equal(full.status, 'pass');
  const unknown = assessSharedCheckoutShallow({ ci: false, shallow: null, root: '/Users/x/Broadwayscore' });
  assert.equal(unknown.status, 'warn');
  assert.match(unknown.message, /Could not read/);
  assert.equal(assessSharedCheckoutShallow({ ci: false, shallow: undefined }).status, 'warn', 'undefined is unknown too, never a silent pass');
});

test('row builder: CI and cloud are a pass even when shallow (shallow by design), with the same row name', () => {
  const ci = assessSharedCheckoutShallow({ ci: true, shallow: true });
  assert.equal(ci.status, 'pass');
  assert.match(ci.message, /shallow by design/);
  assert.equal(ci.name, assessSharedCheckoutShallow({ ci: false, shallow: false }).name);
});

test('health-check: a real shallow clone goes warn, a real full clone passes', () => {
  const { base, full, shallow } = makeRepos();
  try {
    const [shallowRow] = checkSharedCheckoutShallow({ ci: false, root: shallow });
    assert.equal(shallowRow.status, 'warn');
    assert.match(shallowRow.hint, new RegExp(`git -C ${shallow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} fetch --unshallow origin`));
    const [fullRow] = checkSharedCheckoutShallow({ ci: false, root: full });
    assert.equal(fullRow.status, 'pass');
    assert.match(fullRow.message, /full history/);
    // Fixing it turns the row green: the signal tracks the real repository state.
    execFileSync('git', ['fetch', '-q', '--unshallow', 'origin'], { cwd: shallow, stdio: 'pipe' });
    assert.equal(checkSharedCheckoutShallow({ ci: false, root: shallow })[0].status, 'pass');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('health-check: CI or cloud never inspects the checkout, so a shallow one still passes', () => {
  const { base, shallow } = makeRepos();
  try {
    assert.equal(checkSharedCheckoutShallow({ ci: true, root: shallow })[0].status, 'pass');
    let called = false;
    checkSharedCheckoutShallow({ ci: true, root: shallow, isShallow: () => { called = true; return true; } });
    assert.equal(called, false, 'no git call in CI');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('health-check: a path that is not a git checkout warns instead of passing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2049-nogit-'));
  try {
    const [row] = checkSharedCheckoutShallow({ ci: false, root: dir });
    assert.equal(row.status, 'warn');
    assert.match(row.message, /Could not read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the check is in the daily check list, so the digest actually carries the row', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/health-check.js'), 'utf8');
  assert.match(src, /^\s*\.\.\.checkSharedCheckoutShallow\(\),$/m);
});
