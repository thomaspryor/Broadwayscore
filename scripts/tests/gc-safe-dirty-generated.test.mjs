/**
 * BRO-5301 — gc-merged-worktrees.sh must discard generated churn that is not
 * under data/audit/, and still refuse real local edits.
 *
 * On 2026-10-13 disk sat at 2.7GB free while the GC logged `freed=0KB`: ~12
 * merged job worktrees were held only by a tracked .pyc, data/auto-fix-results.json,
 * or a pre-BRO-5261 setup-local-data.sh copy of core data
 * (data/audience-reviews-lbo.json) whose content was a committed core-data blob.
 *
 * Drives the REAL script against a throwaway fixture (same seams and pre-flight
 * isolation guard as gc-dry-run-parity.test.mjs).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gc-merged-worktrees.sh', import.meta.url));
const REPOS_HELPER = fileURLToPath(new URL('../lib/worktree-gc-repos.js', import.meta.url));

const FIXTURE_ROOTS = [];
after(() => {
  for (const root of FIXTURE_ROOTS) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const LBO_V1 = '{"v":1}\n';
const LBO_CORE = '{"v":2,"from":"core-data"}\n';

/**
 * Worktrees, all on a branch whose tip IS origin/main:
 *   wt-pyc         — tracked .pyc modified                         -> remove
 *   wt-delbytecode — tracked .pyc deleted                          -> remove
 *   wt-autofix     — data/auto-fix-results.json modified           -> remove
 *   wt-lbo-copy    — lbo json == a version committed in core-data  -> remove
 *   wt-lbo-old     — lbo json == an older version committed here   -> remove
 *   wt-lbo-edit    — lbo json holds content no repo committed      -> skip
 *   wt-awards      — data/awards.json real edit                    -> skip
 *   wt-unstaged    — awards edit `git add`ed then unstaged: its blob
 *                    is in the object DB but was never committed   -> skip
 *   wt-mixed       — lbo copy + src edit                           -> skip
 */
const REMOVABLE = ['wt-pyc', 'wt-delbytecode', 'wt-autofix', 'wt-lbo-copy', 'wt-lbo-old'];
const KEPT = ['wt-lbo-edit', 'wt-awards', 'wt-unstaged', 'wt-mixed'];
const LBO_V0 = '{"v":0}\n';

function buildFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gen-'));
  FIXTURE_ROOTS.push(tmp);
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  const core = path.join(tmp, 'core-data');

  git(tmp, 'init', '-q', '--bare', origin);
  fs.mkdirSync(repo, { recursive: true });
  git(tmp, 'init', '-q', repo);
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'data/audit'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts/__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/real.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'data/audit/churn.json'), '{}\n');
  // An older lbo version committed first, so wt-lbo-old can match repo history.
  fs.writeFileSync(path.join(repo, 'data/audience-reviews-lbo.json'), LBO_V0);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'lbo v0');
  fs.writeFileSync(path.join(repo, 'data/audience-reviews-lbo.json'), LBO_V1);
  fs.writeFileSync(path.join(repo, 'data/awards.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(repo, 'data/auto-fix-results.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'scripts/__pycache__/x.cpython-314.pyc'), 'bytecode-1');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  // The core-data clone holds a newer lbo version the web repo never committed.
  fs.mkdirSync(core, { recursive: true });
  git(tmp, 'init', '-q', core);
  git(core, 'config', 'user.email', 't@t.t');
  git(core, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(core, 'audience-reviews-lbo.json'), LBO_CORE);
  git(core, 'add', '-A');
  git(core, 'commit', '-q', '-m', 'core');

  const wtRoot = path.join(repo, '.claude/worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  for (const name of [...REMOVABLE, ...KEPT]) {
    git(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, path.join(wtRoot, name), 'main');
  }
  const w = (name, rel) => path.join(wtRoot, name, rel);
  fs.writeFileSync(w('wt-pyc', 'scripts/__pycache__/x.cpython-314.pyc'), 'bytecode-2');
  fs.appendFileSync(w('wt-pyc', 'data/audit/churn.json'), '{"n":1}\n');
  fs.rmSync(w('wt-delbytecode', 'scripts/__pycache__/x.cpython-314.pyc'));
  fs.writeFileSync(w('wt-autofix', 'data/auto-fix-results.json'), '{"fixed":3}\n');
  fs.writeFileSync(w('wt-lbo-copy', 'data/audience-reviews-lbo.json'), LBO_CORE);
  fs.writeFileSync(w('wt-lbo-edit', 'data/audience-reviews-lbo.json'), '{"hand":"edit"}\n');
  fs.writeFileSync(w('wt-awards', 'data/awards.json'), '{"a":2}\n');
  fs.writeFileSync(w('wt-mixed', 'data/audience-reviews-lbo.json'), LBO_CORE);
  fs.appendFileSync(w('wt-mixed', 'src/real.ts'), 'export const b = 2;\n');
  fs.writeFileSync(w('wt-lbo-old', 'data/audience-reviews-lbo.json'), LBO_V0);
  fs.writeFileSync(w('wt-unstaged', 'data/awards.json'), '{"a":"staged-then-unstaged"}\n');
  git(path.join(wtRoot, 'wt-unstaged'), 'add', 'data/awards.json');
  git(path.join(wtRoot, 'wt-unstaged'), 'reset', '-q', '--', 'data/awards.json');

  return { tmp, repo, core, wtRoot };
}

function runGc(fx, { dryRun }) {
  const env = {
    ...process.env,
    WORKTREE_GC_LOG: path.join(fx.tmp, dryRun ? 'dry.log' : 'real.log'),
    WORKTREE_GC_LOCK_DIR: path.join(fx.tmp, `${dryRun ? 'dry' : 'real'}.lock`),
    WORKTREE_GC_REPOS_JSON: JSON.stringify([
      { name: 'fx', path: fx.repo, worktreeDir: '.claude/worktrees', buildArtifactDirs: [] },
    ]),
    WORKTREE_GC_CORE_DATA_DIR: fx.core,
    WORKTREE_GC_DISK_FLOOR_GB: '0',
    WORKTREE_GC_STALE_DAYS: '9999',
    WORKTREE_GC_SCRATCHPAD_STALE_DAYS: '9999',
  };
  // Pre-flight isolation guard: refuse unless the GC resolves to the fixture only.
  const names = execFileSync('node', [REPOS_HELPER, '--list'], { encoding: 'utf8', env })
    .trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
  assert.deepEqual(names, ['fx'], `GC would run against [${names.join(', ')}]; refusing`);
  const out = execFileSync('bash', [SCRIPT, ...(dryRun ? ['--dry-run'] : [])], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 60000,
  });
  assert.ok(!out.includes('WORKTREE_GC_LOCK_DIR rejected'), `fixture lock rejected:\n${out}`);
  return out;
}

function decisionFor(out, name) {
  const re = new RegExp(`^\\[[^\\]]+\\] (WOULD-\\S+|REMOVE|FORCE-REMOVE|SKIP|KEEP)\\s+\\[fx\\] ${name}\\b`);
  const m = out.split('\n').filter((l) => re.test(l));
  assert.equal(m.length, 1, `expected one decision line for ${name}:\n${out}`);
  return m[0];
}

test('dry-run predicts force-removal of generated churn and skips real edits', () => {
  const out = runGc(buildFixture(), { dryRun: true });
  for (const n of REMOVABLE) assert.match(decisionFor(out, n), /WOULD-FORCE-REMOVE/, n);
  for (const n of KEPT) assert.match(decisionFor(out, n), /WOULD-SKIP/, n);
});

test('real run removes generated-churn worktrees and keeps real edits on disk', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: false });
  for (const n of REMOVABLE) {
    assert.match(decisionFor(out, n), /FORCE-REMOVE/, n);
    assert.ok(!fs.existsSync(path.join(fx.wtRoot, n)), `${n} should be gone`);
  }
  for (const n of KEPT) {
    assert.match(decisionFor(out, n), /SKIP/, n);
    assert.ok(fs.existsSync(path.join(fx.wtRoot, n)), `${n} must survive`);
  }
  assert.equal(fs.readFileSync(path.join(fx.wtRoot, 'wt-lbo-edit/data/audience-reviews-lbo.json'), 'utf8'), '{"hand":"edit"}\n');
  assert.equal(fs.readFileSync(path.join(fx.wtRoot, 'wt-awards/data/awards.json'), 'utf8'), '{"a":2}\n');
  assert.equal(fs.readFileSync(path.join(fx.wtRoot, 'wt-unstaged/data/awards.json'), 'utf8'), '{"a":"staged-then-unstaged"}\n');
});
