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
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gc-merged-worktrees.sh', import.meta.url));
// The same helper gc-merged-worktrees.sh consults for its repo set, so the
// pre-flight in runGc() resolves exactly what the script will.
const REPOS_HELPER = fileURLToPath(new URL('../lib/worktree-gc-repos.js', import.meta.url));

/** Every fixture root built by this suite, torn down in `after` (BRO-2607 is a
 *  disk-pressure card; a test that leaks ~2MB of git fixtures per run is the
 *  wrong shape for it). Mirrors scripts/tests/gc-merged-worktrees-liveness.test.mjs. */
const FIXTURE_ROOTS = [];
after(() => {
  for (const root of FIXTURE_ROOTS) fs.rmSync(root, { recursive: true, force: true });
});

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
 *
 * The three names are deliberately chosen so none is a substring of another;
 * `decisionFor` anchors on the decision keyword anyway and asserts uniqueness,
 * so that property is a convenience, not a correctness dependency.
 */
function buildFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-parity-'));
  FIXTURE_ROOTS.push(tmp);
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

function gcEnv(fixture, dryRun) {
  return {
    ...process.env,
    WORKTREE_GC_LOG: path.join(fixture.tmp, dryRun ? 'dry.log' : 'real.log'),
    // MUST end in lock / *.lock / *-lock. gc-merged-worktrees.sh validates this
    // override (it is an `rm -rf` target) and silently falls back to the
    // PRODUCTION lock otherwise — which would either make this suite flaky
    // against the live hourly GC, or make that GC skip a real run during
    // exactly the disk pressure this card is about.
    WORKTREE_GC_LOCK_DIR: path.join(fixture.tmp, `${dryRun ? 'dry' : 'real'}.lock`),
    WORKTREE_GC_REPOS_JSON: JSON.stringify([
      { name: 'fx', path: fixture.repo, worktreeDir: '.claude/worktrees', buildArtifactDirs: [] },
    ]),
    // 0 disables the emergency disk-floor cleanup; a high stale-days keeps
    // the build-artifact stripper away from these fresh fixtures. Neither
    // path is under test here.
    WORKTREE_GC_DISK_FLOOR_GB: '0',
    WORKTREE_GC_STALE_DAYS: '9999',
    WORKTREE_GC_SCRATCHPAD_STALE_DAYS: '9999',
  };
}

function runGc(fixture, { dryRun }) {
  const env = gcEnv(fixture, dryRun);

  // PRE-FLIGHT ISOLATION GUARD — this must happen BEFORE anything destructive.
  // These tests run the GC for real (dryRun:false genuinely removes worktrees)
  // and the ONLY thing confining it to the fixture is WORKTREE_GC_REPOS_JSON.
  // getGcRepos() in scripts/lib/worktree-gc-repos.js falls back to
  // DEFAULT_REPOS — the real ~/Broadwayscore and ~/BroadwayScorecard-app —
  // whenever the override is malformed or fails isValidRepoEntry (a tab,
  // newline or comma anywhere in the path is enough, and TMPDIR can supply
  // one), and it logs NOTHING when it does. Checking the script's output
  // afterwards would be too late: the removals already happened. So resolve
  // the repo set first and refuse to run unless it is exactly the fixture.
  const repoList = execFileSync('node', [REPOS_HELPER, '--list'], {
    encoding: 'utf8',
    env,
  }).trim();
  const names = repoList.split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
  assert.deepEqual(
    names,
    ['fx'],
    `WORKTREE_GC_REPOS_JSON was not honoured — the GC would run against [${names.join(', ')}], ` +
      `which includes the REAL repos. Refusing to run it.\n${repoList}`
  );

  const out = execFileSync('bash', [SCRIPT, ...(dryRun ? ['--dry-run'] : [])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  // Belt and braces: the LOGGED fallback (node or the helper missing entirely),
  // which the pre-flight above cannot see because it needs node itself.
  assert.ok(
    !out.includes('falling back to web repo only'),
    `GC did not honour WORKTREE_GC_REPOS_JSON and fell back to the REAL repo. Refusing to ` +
      `assert on this run.\n${out}`
  );
  // And prove the lock seam was actually accepted, or this run silently took
  // the production lock (the finding that motivated the *.lock naming above).
  assert.ok(
    !out.includes('WORKTREE_GC_LOCK_DIR rejected'),
    `the fixture's lock path was rejected and this run took the PRODUCTION lock:\n${out}`
  );
  for (const line of out.split('\n')) {
    if (/^\[[^\]]+\] (WOULD-\S+|REMOVE|FORCE-REMOVE|SKIP|KEEP)\b/.test(line)) {
      assert.match(line, /\[fx\]/, `decision line escaped the fixture repo: ${line}`);
    }
  }
  return out;
}

/**
 * The single decision line for one fixture worktree. Anchored on the decision
 * keyword and the [fx] repo tag, and asserted unique, so a WARN/DIGEST line
 * that merely mentions the same worktree can never be what gets asserted.
 */
function decisionFor(out, name) {
  const re = new RegExp(`^\\[[^\\]]+\\] (WOULD-\\S+|REMOVE|FORCE-REMOVE|SKIP|KEEP)\\s+\\[fx\\] ${name}\\b`);
  const matches = out.split('\n').filter((l) => re.test(l));
  assert.equal(matches.length, 1, `expected exactly one decision line for ${name}, got ${matches.length}:\n${out}`);
  return matches[0];
}

function summary(out) {
  const line = out.split('\n').find((l) => l.includes('DONE  removed='));
  assert.ok(line, `no DONE summary in:\n${out}`);
  const m = /removed=(\d+) kept=(\d+) skipped=(\d+)/.exec(line);
  assert.ok(m, `unparseable DONE line: ${line}`);
  return { removed: +m[1], kept: +m[2], skipped: +m[3], line };
}

test('dry-run does not call a source-dirty merged worktree "fully merged"', () => {
  const out = runGc(buildFixture(), { dryRun: true });

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
  const out = runGc(buildFixture(), { dryRun: true });

  assert.match(decisionFor(out, 'wt-clean'), /WOULD-REMOVE {2}\[fx\].*fully merged/);
  assert.match(decisionFor(out, 'wt-safe-dirty'), /WOULD-FORCE-REMOVE {2}\[fx\]/);
});

test('dry-run counts match the real run exactly (the parity property)', () => {
  const dry = summary(runGc(buildFixture(), { dryRun: true }));
  const realOut = runGc(buildFixture(), { dryRun: false });
  const real = summary(realOut);

  assert.deepEqual(
    { removed: dry.removed, skipped: dry.skipped },
    { removed: real.removed, skipped: real.skipped },
    `dry-run must predict the real run.\n  dry:  ${dry.line}\n  real: ${real.line}`
  );
  assert.equal(real.removed, 2, 'clean + safe-dirty are removable');
  // Deliberately NOT asserting a literal skipped count. The fixture repo's own
  // main checkout is filtered by the `[ "$path" = "$REPO" ]` guard in
  // gc-merged-worktrees.sh — but ONLY when git reports the same string the
  // script holds. On macOS, os.tmpdir() is a symlink (/var/... vs /private/var/...)
  // so that guard misses, the main checkout falls through to the liveness guard
  // and is counted, giving skipped=2; on a Linux CI runner os.tmpdir() is a real
  // /tmp, the guard fires, and skipped=1. Verified both ways on 2026-08-31.
  // The parity assertion above is the property under test; the source-dirty
  // worktree is pinned by name below.
  assert.match(decisionFor(realOut, 'wt-src-dirty'), /SKIP/);
});

test('the real run leaves the source-dirty worktree and its edit on disk', () => {
  const fx = buildFixture();
  runGc(fx, { dryRun: false });

  const kept = path.join(fx.wtRoot, 'wt-src-dirty/src/real.ts');
  assert.ok(fs.existsSync(kept), 'the refused worktree must survive');
  assert.match(fs.readFileSync(kept, 'utf8'), /export const b = 2;/, 'its uncommitted edit must survive');
  assert.ok(!fs.existsSync(path.join(fx.wtRoot, 'wt-clean')), 'the clean worktree is removed');
});
