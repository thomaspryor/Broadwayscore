/**
 * BRO-2607 — gc-merged-worktrees.sh --dry-run must predict the real run.
 *
 * The real removal path calls `git worktree remove` with NO --force, which git
 * refuses on any dirty tree. Before this test the dry-run branch only split on
 * is_safe_dirty(), so a worktree holding uncommitted SOURCE fell into the else
 * arm and was reported as "fully merged / WOULD-REMOVE" AND counted in
 * removed=. Measured on one machine two minutes apart on 2026-08-31:
 *
 *   dry-run:  DONE removed=15 kept=47 skipped=2
 *   real run: DONE removed=2  kept=47 skipped=16
 *
 * 13 of the 15 were iOS worktrees carrying real edits. The GC refusing them was
 * correct; the dry-run's label and count were the defect.
 *
 * This drives the REAL script (never a reimplementation of its logic) against a
 * throwaway fixture repo, via the WORKTREE_GC_REPOS_JSON seam the script
 * already documents, and asserts dry-run/real parity on all three outcomes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gc-merged-worktrees.sh', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Fixture: a bare origin plus a clone whose .claude/worktrees holds three
 * worktrees, each on a branch whose tip IS origin/main (so `git cherry`
 * reports zero unmerged commits and all three reach the removal decision):
 *
 *   wt-clean       — no uncommitted changes
 *   wt-safe-dirty  — dirty ONLY under data/audit/ (is_safe_dirty)
 *   wt-src-dirty   — dirty in real source (git refuses a plain remove)
 */
function buildFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-parity-'));
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');

  fs.mkdirSync(origin, { recursive: true });
  git(tmp, 'init', '-q', '--bare', origin);

  fs.mkdirSync(repo, { recursive: true });
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
  for (const name of ['wt-clean', 'wt-safe-dirty', 'wt-src-dirty']) {
    git(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, path.join(wtRoot, name), 'main');
  }

  // Dirty exactly one file in each of the two dirty worktrees.
  fs.appendFileSync(path.join(wtRoot, 'wt-safe-dirty/data/audit/churn.json'), '{"n":1}\n');
  fs.appendFileSync(path.join(wtRoot, 'wt-src-dirty/src/real.ts'), 'export const b = 2;\n');

  return { tmp, repo, wtRoot };
}

function runGc(fixture, { dryRun }) {
  const logFile = path.join(fixture.tmp, dryRun ? 'dry.log' : 'real.log');
  const args = dryRun ? ['--dry-run'] : [];
  const out = execFileSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKTREE_GC_LOG: logFile,
      WORKTREE_GC_LOCK_DIR: path.join(fixture.tmp, `lock-${dryRun ? 'dry' : 'real'}`),
      WORKTREE_GC_REPOS_JSON: JSON.stringify([
        { name: 'fx', path: fixture.repo, worktreeDir: '.claude/worktrees', buildArtifactDirs: [] },
      ]),
      // 0 disables the emergency disk-floor cleanup; a high stale-days keeps
      // the build-artifact stripper away from these fresh fixtures. Neither
      // path is under test here.
      WORKTREE_GC_DISK_FLOOR_GB: '0',
      WORKTREE_GC_STALE_DAYS: '9999',
      WORKTREE_GC_SCRATCHPAD_STALE_DAYS: '9999',
    },
  });
  return out;
}

function decisionFor(out, name) {
  const line = out.split('\n').find((l) => l.includes(` ${name} `) || l.endsWith(` ${name}`));
  assert.ok(line, `no decision line for ${name} in:\n${out}`);
  return line;
}

function summary(out) {
  const line = out.split('\n').find((l) => l.includes('DONE  removed='));
  assert.ok(line, `no DONE summary in:\n${out}`);
  const m = /removed=(\d+) kept=(\d+) skipped=(\d+)/.exec(line);
  assert.ok(m, `unparseable DONE line: ${line}`);
  return { removed: +m[1], kept: +m[2], skipped: +m[3], line };
}

test('dry-run does not call a source-dirty merged worktree "fully merged"', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: true });

  const srcDirty = decisionFor(out, 'wt-src-dirty');
  assert.ok(
    !/WOULD-REMOVE/.test(srcDirty),
    `wt-src-dirty holds an uncommitted src/real.ts edit; the real run cannot remove it, ` +
      `so the dry-run must not say WOULD-REMOVE. Got: ${srcDirty}`
  );
  assert.match(srcDirty, /WOULD-SKIP/);
  assert.ok(!/fully merged/.test(srcDirty), `must not be labelled "fully merged": ${srcDirty}`);
});

test('dry-run classifies clean and safe-dirty worktrees as before', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: true });

  assert.match(decisionFor(out, 'wt-clean'), /WOULD-REMOVE {2}\[fx\].*fully merged/);
  assert.match(decisionFor(out, 'wt-safe-dirty'), /WOULD-FORCE-REMOVE {2}\[fx\]/);
});

test('dry-run counts match the real run exactly (the parity property)', () => {
  const dryFx = buildFixture();
  const realFx = buildFixture();

  const dry = summary(runGc(dryFx, { dryRun: true }));
  const real = summary(runGc(realFx, { dryRun: false }));

  assert.deepEqual(
    { removed: dry.removed, skipped: dry.skipped },
    { removed: real.removed, skipped: real.skipped },
    `dry-run must predict the real run.\n  dry:  ${dry.line}\n  real: ${real.line}`
  );
  assert.equal(real.removed, 2, 'clean + safe-dirty are removable');
  // 2 skips, not 1: the enumeration also reaches the fixture repo's own main
  // checkout, which the liveness guard always skips ("a live process has this
  // worktree as its cwd" — that process is this test). The source-dirty
  // worktree is the second, asserted by name rather than by count so a future
  // change to the enumeration cannot quietly satisfy this.
  assert.equal(real.skipped, 2);
  assert.match(decisionFor(runGc(buildFixture(), { dryRun: false }), 'wt-src-dirty'), /SKIP/);
});

test('the real run leaves the source-dirty worktree and its edit on disk', () => {
  const fx = buildFixture();
  runGc(fx, { dryRun: false });

  const kept = path.join(fx.wtRoot, 'wt-src-dirty/src/real.ts');
  assert.ok(fs.existsSync(kept), 'the refused worktree must survive');
  assert.match(fs.readFileSync(kept, 'utf8'), /export const b = 2;/, 'its uncommitted edit must survive');
  assert.ok(!fs.existsSync(path.join(fx.wtRoot, 'wt-clean')), 'the clean worktree is removed');
});
