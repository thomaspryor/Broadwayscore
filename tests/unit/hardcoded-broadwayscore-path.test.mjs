// BRO-2682/2681/3545/4295: the owner Mac's checkout path may appear in code in
// exactly one place, scripts/lib/repo-root.js. Everything else asks it for
// MAIN_REPO_ROOT. A bare literal does not exist on CI runners or cloud
// containers, and scripts that mkdir -p'd under it left a stray partial tree
// that fooled the old existsSync() check (15 red dispatcher tests in cloud).
// Shell scripts are out of scope on purpose: the ones carrying the literal are
// Mac launchd jobs (local-triggers, autonomous-nightly) that only run there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const repoRoot = require('../../scripts/lib/repo-root.js');
const { MAC_REPO, isCheckout, mainCheckoutOf, resolveRepoRoot } = repoRoot;
const OWNER = 'scripts/lib/repo-root.js';
// RECHECK-AFTER acceptance tests that read the Mac-only, gitignored dispatch
// ledger on purpose; they fail anywhere else whichever path they use, so they
// keep the literal and stay out of land.yml's colocated-test set.
const MAC_ONLY_TESTS = new Set([
  'scripts/verify-dispatch-dead-rate-recovery.test.mjs',
  'scripts/tests/verify-watchdog-claim-loop-gone.test.mjs',
]);
const IS_TEST = /(\.test\.(js|mjs|cjs|ts)$)|[\\/](tests|__tests__)[\\/]/;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|ts|tsx)$/.test(e.name)) out.push(p);
  }
}
const files = [];
for (const r of ['scripts', 'src', 'tests']) walk(path.join(ROOT, r), files);

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

test('the Mac checkout literal appears in code only in scripts/lib/repo-root.js', () => {
  assert.ok(files.length > 500, `scan looks truncated (${files.length} files)`);
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (rel === OWNER || IS_TEST.test(rel)) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes(MAC_REPO) && !isCommentLine(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [],
    `hardcoded ${MAC_REPO} in code: use require('scripts/lib/repo-root.js').MAIN_REPO_ROOT instead`);
});

test('tests never load or read files through the Mac checkout literal (fixture strings are fine)', () => {
  const load = new RegExp(String.raw`(require\(|from\s+|path\.join\(|readFileSync\()\s*['"\`]` + MAC_REPO.replace(/\//g, '\\/'));
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (!IS_TEST.test(rel) || MAC_ONLY_TESTS.has(rel) || rel === 'tests/unit/hardcoded-broadwayscore-path.test.mjs') continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (load.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('isCheckout: needs package.json and .git, so a stray partial dir does not count', () => {
  const stray = tmp('rr-stray-');
  const real = tmp('rr-real-');
  try {
    fs.mkdirSync(path.join(stray, 'data', 'audit'), { recursive: true });
    fs.writeFileSync(path.join(real, 'package.json'), '{}');
    fs.mkdirSync(path.join(real, '.git'));
    assert.equal(isCheckout(stray), false);
    assert.equal(isCheckout(real), true);
    assert.equal(isCheckout(path.join(stray, 'missing')), false);
  } finally {
    fs.rmSync(stray, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('mainCheckoutOf: a linked worktree resolves to its main checkout; the main checkout to itself', () => {
  const main = tmp('rr-main-');
  try {
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    const wt = path.join(main, '.claude', 'worktrees', 'wt');
    fs.mkdirSync(path.join(wt, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    assert.equal(mainCheckoutOf(path.join(wt, 'scripts', 'lib')), main);
    assert.equal(mainCheckoutOf(main), main);
  } finally {
    fs.rmSync(main, { recursive: true, force: true });
  }
});

test('resolveRepoRoot: env override, then a real Mac checkout, then the main checkout of this tree', () => {
  const mac = tmp('rr-mac-');
  try {
    assert.equal(resolveRepoRoot({ env: { BSC_REPO_ROOT: '/x/y' }, macRepo: mac }), '/x/y');
    // stray dir at the Mac path: falls through to this repo's main checkout
    assert.equal(resolveRepoRoot({ env: {}, macRepo: mac, fromDir: ROOT }), mainCheckoutOf(ROOT));
    fs.writeFileSync(path.join(mac, 'package.json'), '{}');
    fs.mkdirSync(path.join(mac, '.git'));
    assert.equal(resolveRepoRoot({ env: {}, macRepo: mac, fromDir: ROOT }), mac);
  } finally {
    fs.rmSync(mac, { recursive: true, force: true });
  }
});

test('MAIN_REPO_ROOT resolves to a real checkout', () => {
  assert.equal(isCheckout(repoRoot.MAIN_REPO_ROOT), true);
});
