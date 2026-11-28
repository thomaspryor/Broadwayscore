/**
 * BRO-5378 — gc-merged-worktrees.sh retires stale, idle job-* worktrees whose
 * branch never landed, keeping the branch ref (so no commit is lost).
 *
 * Before this, an unmerged worktree was KEPT forever. Headless job-* worktrees
 * that ended without landing (or whose work landed through different commits)
 * piled up at ~1GB each: on 2026-10-14 there were 76, 48 of them idle >48h with
 * only data/audit/ churn dirty, ~50GB, and / hit 4.7GB free.
 *
 * Drives the REAL script against a throwaway fixture (same seams and pre-flight
 * isolation guard as gc-safe-dirty-generated.test.mjs).
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

function backdate(dir) {
  execFileSync('find', [dir, '-exec', 'touch', '-h', '-t', '202601010000', '{}', '+']);
}

/**
 * Worktrees, each on its own branch carrying one commit NOT on origin/main:
 *   job-stale-clean   — idle, clean                     -> retire (plain remove)
 *   job-stale-audit   — idle, only data/audit/ dirty    -> retire (--force)
 *   job-stale-edit    — idle, real src edit dirty       -> keep
 *   job-fresh         — recently touched, clean         -> keep
 *   wt-stale-nonjob   — idle, clean, not a job worktree -> keep
 */
const RETIRED = ['job-stale-clean', 'job-stale-audit'];
const KEPT = ['job-stale-edit', 'job-fresh', 'wt-stale-nonjob'];

function buildFixture() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-retire-')));
  FIXTURE_ROOTS.push(tmp);
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  git(tmp, 'init', '-q', '--bare', origin);
  git(tmp, 'init', '-q', repo);
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'data/audit'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/real.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'data/audit/churn.json'), '{}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const wtRoot = path.join(repo, '.claude/worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  for (const name of [...RETIRED, ...KEPT]) {
    const wt = path.join(wtRoot, name);
    git(repo, 'worktree', 'add', '-q', '-b', `branch-${name}`, wt, 'main');
    fs.writeFileSync(path.join(wt, `${name}.txt`), 'unlanded work\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', `unlanded ${name}`);
  }
  fs.appendFileSync(path.join(wtRoot, 'job-stale-audit/data/audit/churn.json'), '{"n":1}\n');
  fs.appendFileSync(path.join(wtRoot, 'job-stale-edit/src/real.ts'), 'export const b = 2;\n');
  for (const name of ['job-stale-clean', 'job-stale-audit', 'job-stale-edit', 'wt-stale-nonjob']) {
    backdate(path.join(wtRoot, name));
  }
  return { tmp, repo, wtRoot };
}

function runGc(fx, { dryRun, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    WORKTREE_GC_LOG: path.join(fx.tmp, dryRun ? 'dry.log' : 'real.log'),
    WORKTREE_GC_LOCK_DIR: path.join(fx.tmp, `${dryRun ? 'dry' : 'real'}.lock`),
    WORKTREE_GC_REPOS_JSON: JSON.stringify([
      { name: 'fx', path: fx.repo, worktreeDir: '.claude/worktrees', buildArtifactDirs: [] },
    ]),
    WORKTREE_GC_DISK_FLOOR_GB: '0',
    WORKTREE_GC_STALE_DAYS: '3',
    WORKTREE_GC_SCRATCHPAD_STALE_DAYS: '9999',
    ...extraEnv,
  };
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
  const re = new RegExp(`^\\[[^\\]]+\\] (WOULD-\\S+|RETIRE|REMOVE|FORCE-REMOVE|SKIP|KEEP)\\s+\\[fx\\] ${name}\\b`);
  const m = out.split('\n').filter((l) => re.test(l));
  assert.equal(m.length, 1, `expected one decision line for ${name}:\n${out}`);
  return m[0];
}

test('dry-run predicts retiring only stale, idle, clean-or-churn job worktrees', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: true });
  for (const n of RETIRED) assert.match(decisionFor(out, n), /WOULD-RETIRE/, n);
  for (const n of KEPT) assert.match(decisionFor(out, n), /KEEP/, n);
  for (const n of RETIRED) assert.ok(fs.existsSync(path.join(fx.wtRoot, n)), `dry-run must not delete ${n}`);
});

test('real run retires the stale job worktrees and keeps their branches', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: false });
  for (const n of RETIRED) {
    assert.match(decisionFor(out, n), /^\[[^\]]+\] REMOVE .*retired: branch-/, n);
    assert.ok(!fs.existsSync(path.join(fx.wtRoot, n)), `${n} should be gone`);
    assert.match(git(fx.repo, 'log', '-1', '--format=%s', `branch-${n}`), new RegExp(`unlanded ${n}`), `${n} branch must keep its commit`);
  }
  for (const n of KEPT) {
    assert.match(decisionFor(out, n), /KEEP/, n);
    assert.ok(fs.existsSync(path.join(fx.wtRoot, n)), `${n} must survive`);
  }
  assert.equal(fs.readFileSync(path.join(fx.wtRoot, 'job-stale-edit/src/real.ts'), 'utf8'), 'export const a = 1;\nexport const b = 2;\n');
  // Counted once as removed, never also as kept, and still named in the digest.
  assert.match(out, new RegExp(`removed=${RETIRED.length}\\b`), out);
  assert.match(out, new RegExp(`kept=${KEPT.length}\\b`), out);
  for (const n of RETIRED) assert.match(out, new RegExp(`${n}\\(retired,branch:branch-${n}\\)`), `${n} missing from digest`);
});

test('a job worktree idle past the digest window but inside WORKTREE_GC_RETIRE_STALE_DAYS is kept', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: true, extraEnv: { WORKTREE_GC_RETIRE_STALE_DAYS: '99999' } });
  for (const n of [...RETIRED, ...KEPT]) assert.match(decisionFor(out, n), /KEEP/, n);
});

test('WORKTREE_GC_RETIRE_STALE_JOBS=0 turns retiring off', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: false, extraEnv: { WORKTREE_GC_RETIRE_STALE_JOBS: '0' } });
  for (const n of [...RETIRED, ...KEPT]) {
    assert.match(decisionFor(out, n), /KEEP/, n);
    assert.ok(fs.existsSync(path.join(fx.wtRoot, n)), `${n} must survive with the kill switch`);
  }
});
