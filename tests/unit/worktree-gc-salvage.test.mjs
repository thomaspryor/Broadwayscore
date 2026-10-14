/**
 * BRO-4815 — landed worktrees whose only dirt is untracked session notes must
 * be salvaged (notes copied out) and removed by gc-merged-worktrees.sh, while
 * tracked edits, locks, fresh writes and symlinks keep the worktree.
 *
 * Drives the REAL script against a scratch repo (same seams as
 * scripts/tests/gc-dry-run-parity.test.mjs) and the REAL lib via require().
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseStatusZ, evaluateEligibility, resolveSalvageRoot } = require('../../scripts/lib/worktree-gc-salvage.js');
const SCRIPT = fileURLToPath(new URL('../../scripts/gc-merged-worktrees.sh', import.meta.url));
const REPOS_HELPER = fileURLToPath(new URL('../../scripts/lib/worktree-gc-repos.js', import.meta.url));

const ROOTS = [];
after(() => { for (const r of ROOTS) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const OLD = new Date(Date.now() - 3 * 3600 * 1000);
const note = (wt, rel, body = 'session note\n', when = OLD) => {
  const f = path.join(wt, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  fs.utimesSync(f, when, when);
};

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-salvage-'));
  ROOTS.push(tmp);
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  git(tmp, 'init', '-q', '--bare', origin);
  git(tmp, 'init', '-q', repo);
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/real.ts'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const wtRoot = path.join(repo, '.claude/worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  const names = ['wt-notes', 'wt-tracked', 'wt-locked', 'wt-fresh', 'wt-link', 'wt-clean'];
  for (const n of names) git(repo, 'worktree', 'add', '-q', '-b', `worktree-${n}`, path.join(wtRoot, n), 'main');
  const wt = (n) => path.join(wtRoot, n);
  note(wt('wt-notes'), '.wrapup-block.txt');
  note(wt('wt-notes'), 'HANDOFF-x/deep.md', 'deep note\n');
  note(wt('wt-tracked'), 'STATE.md');
  fs.appendFileSync(path.join(wt('wt-tracked'), 'src/real.ts'), 'export const b = 2;\n');
  note(wt('wt-locked'), 'STATE.md');
  git(repo, 'worktree', 'lock', wt('wt-locked'), '--reason', 'BRO-4815 fixture');
  note(wt('wt-fresh'), 'STATE.md', 'just written\n', new Date());
  fs.symlinkSync('/etc/hosts', path.join(wt('wt-link'), 'link.txt'));
  return { tmp, repo, wt, salvage: path.join(tmp, 'salvage') };
}

function runGc(fx, dryRun) {
  const env = {
    ...process.env,
    WORKTREE_GC_LOG: path.join(fx.tmp, 'gc.log'),
    WORKTREE_GC_LOCK_DIR: path.join(fx.tmp, 'gc.lock'),
    WORKTREE_GC_SALVAGE_DIR: fx.salvage,
    WORKTREE_GC_REPOS_JSON: JSON.stringify([{ name: 'fx', path: fx.repo, worktreeDir: '.claude/worktrees', buildArtifactDirs: [] }]),
    WORKTREE_GC_DISK_FLOOR_GB: '0',
    WORKTREE_GC_STALE_DAYS: '9999',
    WORKTREE_GC_SCRATCHPAD_STALE_DAYS: '9999',
  };
  // Isolation guard: never run the destructive GC unless the repo set is the fixture.
  const names = execFileSync('node', [REPOS_HELPER, '--list'], { encoding: 'utf8', env }).trim().split('\n').map((l) => l.split('\t')[0]);
  assert.deepEqual(names, ['fx']);
  const out = execFileSync('bash', [SCRIPT, ...(dryRun ? ['--dry-run'] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 90000 });
  assert.ok(!out.includes('WORKTREE_GC_LOCK_DIR rejected') && !out.includes('falling back to web repo only'), out);
  return out;
}
const decision = (out, n) => {
  const m = out.split('\n').filter((l) => new RegExp(`\\] (WOULD-\\S+|SALVAGE-REMOVE|REMOVE|FORCE-REMOVE|SKIP|KEEP)\\s+\\[fx\\] ${n}\\b`).test(l));
  assert.equal(m.length, 1, `decision line for ${n}:\n${out}`);
  return m[0];
};

test('dry-run lists notes-only landed worktree as WOULD-SALVAGE-REMOVE and touches nothing', () => {
  const fx = fixture();
  const out = runGc(fx, true);
  assert.match(decision(out, 'wt-notes'), /WOULD-SALVAGE-REMOVE/);
  for (const n of ['wt-tracked', 'wt-locked', 'wt-fresh', 'wt-link']) assert.doesNotMatch(decision(out, n), /SALVAGE/, n);
  assert.ok(fs.existsSync(fx.wt('wt-notes')), 'dry-run must not remove');
  assert.ok(!fs.existsSync(fx.salvage), 'dry-run must not copy');
});

test('real run salvages then removes notes-only worktree; keeps tracked/locked/fresh/symlink ones', () => {
  const fx = fixture();
  const out = runGc(fx, false);
  assert.match(decision(out, 'wt-notes'), /SALVAGE-REMOVE/);
  assert.ok(!fs.existsSync(fx.wt('wt-notes')), 'worktree removed');
  assert.match(git(fx.repo, 'branch', '--list', 'worktree-wt-notes'), /worktree-wt-notes/, 'branch kept');
  const files = fs.readdirSync(path.join(fx.salvage, fs.readdirSync(fx.salvage)[0]));
  assert.deepEqual(files.sort(), ['wt-notes--.wrapup-block.txt', 'wt-notes--HANDOFF-x__deep.md']);
  assert.equal(fs.readFileSync(path.join(fx.salvage, fs.readdirSync(fx.salvage)[0], 'wt-notes--HANDOFF-x__deep.md'), 'utf8'), 'deep note\n');
  for (const n of ['wt-tracked', 'wt-locked', 'wt-fresh', 'wt-link']) {
    assert.ok(fs.existsSync(fx.wt(n)), `${n} must be kept`);
    assert.doesNotMatch(decision(out, n), /REMOVE\b(?<!WOULD-SKIP)/, n);
  }
  assert.ok(fs.existsSync(path.join(fx.wt('wt-tracked'), 'STATE.md')));
  assert.ok(!fs.existsSync(fx.wt('wt-clean')), 'plain clean removal still works');
});

test('evaluateEligibility: pure predicates', () => {
  const f = (o = {}) => ({ rel: 'STATE.md', size: 10, isSymlink: false, mtimeMs: 0, ...o });
  const base = { entries: [{ xy: '??', path: 'STATE.md' }], files: [f()], nowMs: 3600e3, minAgeMin: 30 };
  assert.equal(evaluateEligibility(base).eligible, true);
  assert.equal(evaluateEligibility({ ...base, entries: [{ xy: ' M', path: 'a' }, ...base.entries] }).eligible, false);
  assert.equal(evaluateEligibility({ ...base, entries: [{ xy: 'UU', path: 'a' }] }).eligible, false);
  assert.equal(evaluateEligibility({ ...base, files: [f({ isSymlink: true })] }).eligible, false);
  assert.equal(evaluateEligibility({ ...base, files: [f({ size: 21 * 1024 * 1024 })] }).eligible, false);
  assert.equal(evaluateEligibility({ ...base, files: [f({ mtimeMs: 3590e3 })] }).eligible, false);
  assert.equal(evaluateEligibility({ ...base, files: [f({ rel: '../x' })] }).eligible, false);
  assert.equal(evaluateEligibility({ ...base, entries: [], files: [] }).eligible, false);
});

test('parseStatusZ skips rename origin field; resolveSalvageRoot rejects non-temp override', () => {
  assert.deepEqual(parseStatusZ('R  new\0old\0?? n.md\0'), [{ xy: 'R ', path: 'new' }, { xy: '??', path: 'n.md' }]);
  assert.match(resolveSalvageRoot({ WORKTREE_GC_SALVAGE_DIR: '/Users/x/evil' }, '/h'), /^\/h\/Documents\/claude-outputs\/worktree-salvage$/);
  assert.equal(resolveSalvageRoot({ WORKTREE_GC_SALVAGE_DIR: '/tmp/s' }, '/h'), '/tmp/s');
});
