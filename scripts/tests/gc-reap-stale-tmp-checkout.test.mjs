/**
 * BRO-5364 — gc-merged-worktrees.sh must reap detached temp checkouts that a
 * killed caller leaked, and leave every other detached worktree alone.
 *
 * makeFreshCheckout (acceptance-check-core.js) creates
 * <tmpdir>/<prefix>XXXXXX/main with `git worktree add --detach` and removes it
 * in a finally block. A killed caller leaks it, and the GC's detached-HEAD SKIP
 * kept it forever: on 2026-10-14 a 1.2GB merge-test-gate-baseline checkout from
 * the day before helped take / to 2.1GB free.
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

// Backdate a tree (and the mkdtemp parent) past the idle window.
function backdate(...dirs) {
  for (const d of dirs) execFileSync('find', [d, '-exec', 'touch', '-h', '-t', '202601010000', '{}', '+']);
}

/**
 * Detached worktrees:
 *   leaked      — <tmp>/merge-test-gate-baseline-XXXXXX/main, idle, HEAD on main -> reap
 *   fresh       — same shape, recently touched                                    -> skip
 *   unique      — same shape, idle, HEAD carries a commit not on origin/main      -> skip
 *   wrongshape  — <tmp>/scratch/checkout (not the mkdtemp shape), idle            -> skip
 *   foreign     — <tmp>/my-scratch-XXXXXX/main (not a makeFreshCheckout prefix)   -> skip
 */
function buildFixture() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-tmpco-')));
  FIXTURE_ROOTS.push(tmp);
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  git(tmp, 'init', '-q', '--bare', origin);
  git(tmp, 'init', '-q', repo);
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  fs.mkdirSync(path.join(repo, '.claude/worktrees'), { recursive: true });

  const mk = (prefix) => {
    const parent = fs.mkdtempSync(path.join(tmp, prefix));
    const wt = path.join(parent, 'main');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
    return { parent, wt };
  };
  const leaked = mk('merge-test-gate-baseline-');
  const fresh = mk('acceptance-check-');
  const unique = mk('done-evidence-');
  fs.writeFileSync(path.join(unique.wt, 'b.txt'), 'b\n');
  git(unique.wt, 'add', '-A');
  git(unique.wt, 'commit', '-q', '-m', 'unique work');
  const wrongParent = path.join(tmp, 'scratch');
  fs.mkdirSync(wrongParent);
  const wrong = { parent: wrongParent, wt: path.join(wrongParent, 'checkout') };
  git(repo, 'worktree', 'add', '-q', '--detach', wrong.wt, 'main');

  const foreign = mk('my-scratch-');

  backdate(leaked.parent, unique.parent, wrong.parent, foreign.parent);
  return { tmp, repo, leaked, fresh, unique, wrong, foreign };
}

function runGc(fx, { dryRun }) {
  const env = {
    ...process.env,
    WORKTREE_GC_LOG: path.join(fx.tmp, dryRun ? 'dry.log' : 'real.log'),
    WORKTREE_GC_LOCK_DIR: path.join(fx.tmp, `${dryRun ? 'dry' : 'real'}.lock`),
    WORKTREE_GC_REPOS_JSON: JSON.stringify([
      { name: 'fx', path: fx.repo, worktreeDir: '.claude/worktrees', buildArtifactDirs: [] },
    ]),
    WORKTREE_GC_DISK_FLOOR_GB: '0',
    WORKTREE_GC_STALE_DAYS: '9999',
    WORKTREE_GC_SCRATCHPAD_STALE_DAYS: '9999',
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

const lineFor = (out, wt) => out.split('\n').filter((l) => l.includes(wt) || l.includes(path.basename(path.dirname(wt))));

test('dry-run predicts reaping only the idle mkdtemp-shaped checkout on main', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: true });
  assert.match(out, new RegExp(`WOULD-REMOVE-TMP\\s+\\[fx\\] ${fx.leaked.wt}`));
  assert.equal((out.match(/WOULD-REMOVE-TMP/g) || []).length, 1, out);
  assert.ok(fs.existsSync(fx.leaked.wt), 'dry-run must not delete');
});

test('real run reaps the leaked checkout and keeps fresh, unique-commit and odd-shaped ones', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: false });
  assert.match(out, new RegExp(`REMOVE-TMP\\s+\\[fx\\] ${fx.leaked.wt}`));
  assert.ok(!fs.existsSync(fx.leaked.parent), 'leaked checkout and its mkdtemp parent should be gone');
  assert.ok(!git(fx.repo, 'worktree', 'list').includes(fx.leaked.wt), 'worktree must be deregistered');
  for (const k of ['fresh', 'unique', 'wrong', 'foreign']) {
    assert.ok(fs.existsSync(fx[k].wt), `${k} must survive:\n${lineFor(out, fx[k].wt).join('\n')}`);
  }
  assert.equal((out.match(/REMOVE-TMP/g) || []).length, 1, out);
});

test('every makeFreshCheckout prefix in scripts/ is on the GC reap allowlist', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const src = execFileSync('git', ['grep', '-hoE', "(makeFreshCheckout|freshCheckout)\\(\\{[^}]*prefix: '[a-z-]+'", '--', 'scripts/'],
    { cwd: root, encoding: 'utf8' });
  const prefixes = [...new Set([...src.matchAll(/prefix: '([a-z-]+)'/g)].map((m) => m[1]))];
  assert.ok(prefixes.length >= 5, `prefix scan looks broken: ${prefixes}`);
  const gc = fs.readFileSync(SCRIPT, 'utf8');
  // acceptance-check- is makeFreshCheckout's default prefix.
  for (const p of ['acceptance-check-', ...prefixes]) {
    assert.ok(gc.includes(`${p}??????`), `gc-merged-worktrees.sh reap allowlist is missing ${p}`);
  }
});
