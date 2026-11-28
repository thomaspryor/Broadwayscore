/**
 * BRO-8178 — gc-merged-worktrees.sh removes job-* worktrees whose work landed
 * through a REBASE (land.yml), and no longer keeps every bootstrapped worktree
 * over its setup-local-data.sh ignored files.
 *
 * Before: 37 finished job worktrees (~800MB each) were KEPT as "N unmerged
 * commit(s)" because the rebase rewrote their shas (and a conflict-resolved
 * patch defeats git cherry), and 56 merged ones were KEPT as "local inputs or
 * probe unavailable" because of .env symlinks / data/*.json copies / .cache/.
 *
 * Drives the REAL script against a throwaway fixture (same seams and isolation
 * guard as gc-retire-stale-job-worktree.test.mjs).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL('../gc-merged-worktrees.sh', import.meta.url));
const REPOS_HELPER = fileURLToPath(new URL('../lib/worktree-gc-repos.js', import.meta.url));
const SETUP_SCRIPT = fileURLToPath(new URL('../setup-local-data.sh', import.meta.url));
const { classifyIgnoredEntry, decideIgnoredInputs, gatherIgnoredInputs, SETUP_COPIED_DATA_FILES } = require('../lib/worktree-ignored-inputs.js');
const { branchLandedDespiteRebase, detectJobLanding, restoreRetiredJobWorktree } = require('../lib/headless-unlanded-detection.js');

const FIXTURE_ROOTS = [];
after(() => {
  for (const root of FIXTURE_ROOTS) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function commitFile(cwd, rel, body, msg) {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), body);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}
/** Write a fixture file under a tmp worktree (every caller's dir is under mkdtempSync). */
function writeUnder(dir, rel, body) {
  fs.writeFileSync(path.join(dir, rel), body);
}
/** What setup-local-data.sh leaves in every worktree (all gitignored). */
function bootstrapInputs(wt, repo) {
  fs.symlinkSync(path.join(repo, '.env'), path.join(wt, '.env'));
  fs.symlinkSync(path.join(repo, 'data/shows.json'), path.join(wt, 'data/shows.json'));
  writeUnder(wt, 'data/grosses.json', '{"copy":true}\n');
  fs.mkdirSync(path.join(wt, '.cache/x'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.cache/x/blob'), 'cache\n');
  fs.writeFileSync(path.join(wt, 'tsconfig.tsbuildinfo'), '{}\n');
  fs.mkdirSync(path.join(wt, 'data/review-texts'), { recursive: true });
}

/**
 *   job-rebased-tip      landed by land.yml rebase with a conflict-changed patch; tip in landings.jsonl -> removed
 *   job-rebased-content  landed through a differently-shaped commit, no ledger row; files identical    -> removed
 *   job-unlanded         a commit whose work is not on main                                            -> kept
 *   job-landed-private   landed (tip) but holds an ignored data/finances/ file                          -> kept
 *   job-edited-copy      landed (tip) but a setup-copied data file was edited after bootstrap           -> kept
 *   job-merge-after-tip  landed tip, then a merge of main whose conflict resolution added unlanded work -> kept
 */
const REMOVED = ['job-rebased-tip', 'job-rebased-content'];
const KEPT = ['job-unlanded', 'job-landed-private', 'job-edited-copy', 'job-merge-after-tip'];

function buildFixture() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rebase-landed-')));
  fs.mkdirSync(path.join(tmp, 'job-leases'));
  FIXTURE_ROOTS.push(tmp);
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  git(tmp, 'init', '-q', '--bare', origin);
  git(tmp, 'init', '-q', repo);
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'data/audit'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.cache/\ntsconfig.tsbuildinfo\ndata/*.json\ndata/review-texts/\ndata/finances/\n.claude/\n');
  fs.writeFileSync(path.join(repo, '.env'), 'K=v\n');
  fs.writeFileSync(path.join(repo, 'data/shows.json'), '[]\n');
  fs.writeFileSync(path.join(repo, 'data/audit/landings.jsonl'), '');
  commitFile(repo, 'src/a.ts', 'line1\nline2\nline3\n', 'seed');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const wtRoot = path.join(repo, '.claude/worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  const wts = {};
  for (const name of [...REMOVED, ...KEPT]) {
    wts[name] = path.join(wtRoot, name);
    git(repo, 'worktree', 'add', '-q', '-b', `job/${name.slice(4)}`, wts[name], 'main');
  }
  // job-rebased-tip: two commits; main receives a rebased copy where the first
  // patch was conflict-resolved differently, plus a landings.jsonl row whose
  // tip is the job's pre-rebase HEAD (what land.yml writes).
  commitFile(wts['job-rebased-tip'], 'src/a.ts', 'line1\nJOB\nline3\n', 'BRO-1: change line2');
  const tipA = commitFile(wts['job-rebased-tip'], 'src/b.ts', 'b\n', 'BRO-1: add b');
  // job-landed-private: landed the same way, but keeps a private ignored file.
  const tipP = commitFile(wts['job-landed-private'], 'src/p.ts', 'p\n', 'BRO-4: add p');
  fs.mkdirSync(path.join(wts['job-landed-private'], 'data/finances'), { recursive: true });
  writeUnder(wts['job-landed-private'], 'data/finances/q3.json', '{"real":1}\n');
  const tipE = commitFile(wts['job-edited-copy'], 'src/e.ts', 'e\n', 'BRO-5: add e');
  const tipM = commitFile(wts['job-merge-after-tip'], 'src/m.ts', 'm\n', 'BRO-6: add m');
  // job-rebased-content: x then y; main lands y in one differently-shaped commit.
  commitFile(wts['job-rebased-content'], 'src/c.ts', 'x\n', 'BRO-2: add c');
  commitFile(wts['job-rebased-content'], 'src/c.ts', 'y\n', 'BRO-2: tweak c');
  // job-unlanded: real work main never got.
  commitFile(wts['job-unlanded'], 'src/u.ts', 'u\n', 'BRO-3: unlanded work');

  // "Land" onto main: someone else changed line2 first, so the rebase resolved
  // the conflict (patch differs from the job's).
  commitFile(repo, 'src/a.ts', 'line1\nOTHER\nline3\n', 'BRO-9: unrelated change to line2');
  commitFile(repo, 'src/a.ts', 'line1\nOTHER+JOB\nline3\n', 'BRO-1: change line2');
  commitFile(repo, 'src/b.ts', 'b\n', 'BRO-1: add b');
  commitFile(repo, 'src/p.ts', 'p\n', 'BRO-4: add p');
  commitFile(repo, 'src/c.ts', 'y\n', 'BRO-2: land c');
  commitFile(repo, 'src/e.ts', 'e\n', 'BRO-5: add e');
  commitFile(repo, 'src/m.ts', 'm\n', 'BRO-6: add m');
  const rows = [tipA, tipP, tipE, tipM].map((tip) => JSON.stringify({ ts: new Date().toISOString(), branch: 'land/x', sha: 'f'.repeat(40), tip }));
  commitFile(repo, 'data/audit/landings.jsonl', `${rows.join('\n')}\n`, 'landings');
  git(repo, 'push', '-q', 'origin', 'main');

  // job-merge-after-tip merges main, and the merge commit itself carries extra work.
  git(wts['job-merge-after-tip'], 'merge', '-q', '--no-ff', '--no-commit', 'main');
  fs.writeFileSync(path.join(wts['job-merge-after-tip'], 'src/m.ts'), 'm\nresolution only in the merge\n');
  git(wts['job-merge-after-tip'], 'add', '-A');
  git(wts['job-merge-after-tip'], 'commit', '-q', '-m', 'Merge main');
  for (const name of [...REMOVED, ...KEPT]) bootstrapInputs(wts[name], repo);
  // A session edited its setup copy well after bootstrap (e.g. append-season-payback-history.ts).
  const edited = path.join(wts['job-edited-copy'], 'data/grosses.json');
  writeUnder(wts['job-edited-copy'], 'data/grosses.json', '{"edited":true}\n');
  const later = new Date(Date.now() + 3600e3);
  fs.utimesSync(edited, later, later);
  return { tmp, repo, wtRoot, wts };
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
    // Never read the real data/audit/job-leases (live-data-lane gate): an
    // empty fixture lease root means "no live lease" for every fixture path.
    BSC_JOB_LEASE_ROOT: path.join(fx.tmp, 'job-leases'),
    ...extraEnv,
  };
  const names = execFileSync('node', [REPOS_HELPER, '--list'], { encoding: 'utf8', env })
    .trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
  assert.deepEqual(names, ['fx'], `GC would run against [${names.join(', ')}]; refusing`);
  const out = execFileSync('bash', [SCRIPT, ...(dryRun ? ['--dry-run'] : [])], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 120000,
  });
  assert.ok(!out.includes('WORKTREE_GC_LOCK_DIR rejected'), `fixture lock rejected:\n${out}`);
  return out;
}

function decisionFor(out, name) {
  const re = new RegExp(`^\\[[^\\]]+\\] (WOULD-\\S+|REMOVE|FORCE-REMOVE|SALVAGE-REMOVE|SKIP|KEEP)\\s+\\[fx\\] ${name}\\b`);
  const m = out.split('\n').filter((l) => re.test(l));
  assert.equal(m.length, 1, `expected one decision line for ${name}:\n${out}`);
  return m[0];
}

test('real run removes rebase-landed job worktrees, keeps unlanded and private-input ones, keeps branches', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: false });
  for (const n of REMOVED) {
    assert.match(decisionFor(out, n), /\] REMOVE /, n);
    assert.ok(!fs.existsSync(fx.wts[n]), `${n} should be gone`);
    git(fx.repo, 'rev-parse', '--verify', `job/${n.slice(4)}`); // branch kept
  }
  assert.match(decisionFor(out, 'job-unlanded'), /KEEP .*unmerged commit/);
  assert.match(decisionFor(out, 'job-landed-private'), /KEEP .*keeps: data\/finances\//);
  assert.match(decisionFor(out, 'job-edited-copy'), /KEEP .*keeps: data\/grosses\.json/);
  assert.match(decisionFor(out, 'job-merge-after-tip'), /KEEP .*unmerged commit/);
  for (const n of KEPT) assert.ok(fs.existsSync(fx.wts[n]), `${n} must survive`);
  // Symlink targets in the main checkout survive the removal.
  assert.equal(fs.readFileSync(path.join(fx.repo, '.env'), 'utf8'), 'K=v\n');
  assert.equal(fs.readFileSync(path.join(fx.repo, 'data/shows.json'), 'utf8'), '[]\n');
  assert.match(out, /rebase-landed: every commit is on main or inside a landings\.jsonl tip/);
  assert.match(out, /rebase-landed: all 1 changed file\(s\) identical/);
});

test('dry-run predicts the same split and deletes nothing', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: true });
  for (const n of REMOVED) assert.match(decisionFor(out, n), /WOULD-REMOVE/, n);
  for (const n of KEPT) assert.match(decisionFor(out, n), /KEEP/, n);
  for (const n of [...REMOVED, ...KEPT]) assert.ok(fs.existsSync(fx.wts[n]), `dry-run must not delete ${n}`);
});

test('a git cherry timeout does not skip rebase-landed detection (cherry is slowest on exactly these branches)', () => {
  const fx = buildFixture();
  // A git shim on PATH that fails every `git cherry` the way a gc_probe timeout does.
  const shimDir = path.join(fx.tmp, 'shim');
  fs.mkdirSync(shimDir);
  const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shim = path.join(shimDir, 'git');
  writeUnder(shimDir, 'git', `#!/bin/bash\nfor a in "$@"; do [ "$a" = cherry ] && exit 124; done\nexec "${realGit}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  // A REAL run, so the pre-removal lease/tip/input re-check runs with cherry down too.
  const out = runGc(fx, { dryRun: false, extraEnv: { PATH: `${shimDir}:${process.env.PATH}` } });
  assert.match(out, /git cherry timed out\/failed/);
  for (const n of REMOVED) {
    assert.match(decisionFor(out, n), /\] REMOVE /, n);
    assert.ok(!fs.existsSync(fx.wts[n]), `${n} should be gone`);
  }
  for (const n of KEPT) assert.ok(fs.existsSync(fx.wts[n]), `${n} must survive`);
  assert.match(decisionFor(out, 'job-unlanded'), /KEEP/);
  assert.match(decisionFor(out, 'job-merge-after-tip'), /KEEP/);
});

test('WORKTREE_GC_REBASE_LANDED=0 keeps the rebase-landed worktrees', () => {
  const fx = buildFixture();
  const out = runGc(fx, { dryRun: true, extraEnv: { WORKTREE_GC_REBASE_LANDED: '0' } });
  for (const n of REMOVED) assert.match(decisionFor(out, n), /KEEP .*unmerged commit/, n);
});

test('branchLandedDespiteRebase: tip signal, content signal, and a genuine miss', () => {
  const fx = buildFixture();
  const tips = git(fx.repo, 'show', 'origin/main:data/audit/landings.jsonl').trim().split('\n').map((l) => JSON.parse(l).tip);
  const v = (b, t = tips) => branchLandedDespiteRebase({ repo: fx.repo, branch: b, tips: t });
  assert.equal(v('job/rebased-tip').landed, true);
  assert.equal(v('job/rebased-tip', []).landed, false, 'without the ledger row the conflict-changed patch is not provable');
  assert.equal(v('job/rebased-content', []).landed, true);
  assert.equal(v('job/unlanded').landed, false);
  assert.equal(v('job/unlanded', ['0'.repeat(40), 'not-a-sha']).landed, false, 'unresolvable tips are ignored');
});

test('a merge with its own edits inside a recorded tip gets no receipt-only clearance (land rebase drops merges)', () => {
  const fx = buildFixture();
  const r = fx.repo;
  const base = git(r, 'rev-parse', 'origin/main').trim();
  git(r, 'checkout', '-q', '-b', 'side', base);
  commitFile(r, 'src/s.ts', 's\n', 'side work');
  git(r, 'checkout', '-q', '-b', 'job/evil', base);
  commitFile(r, 'src/v.ts', 'v\n', 'BRO-7: add v');
  git(r, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  writeUnder(r, 'src/v.ts', 'v\nedit only in the merge\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'Merge side');
  const evilTip = git(r, 'rev-parse', 'HEAD').trim();
  git(r, 'checkout', '-q', '-b', 'job/clean', base);
  commitFile(r, 'src/w.ts', 'w\n', 'BRO-8: add w');
  git(r, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  const cleanTip = git(r, 'rev-parse', 'HEAD').trim();
  git(r, 'checkout', '-q', 'main');
  const v = (b, t) => branchLandedDespiteRebase({ repo: r, branch: b, tips: t });
  assert.equal(v('job/clean', [cleanTip]).landed, true, 'a clean merge inside the tip keeps receipt clearance');
  assert.equal(v('job/evil', [evilTip]).landed, false, 'an evil merge inside the tip must not be cleared by the receipt');
});

test('subject signal: landed when main has the same BRO-id subject even after main changed the file; generic or foreign subjects keep', () => {
  const fx = buildFixture();
  const r = fx.repo;
  const base = git(r, 'rev-parse', 'origin/main').trim();
  git(r, 'checkout', '-q', '-b', 'job/linear-BRO-40-x', base);
  commitFile(r, 'src/q.ts', 'q\n', 'BRO-40: add q');
  commitFile(r, 'STATE.md', 'scratch\n', 'BRO-40: STATE.md');
  git(r, 'checkout', '-q', '-b', 'job/linear-BRO-41-x', base);
  commitFile(r, 'src/g.ts', 'g\n', 'address ship-check findings');
  git(r, 'checkout', '-q', '-b', 'job/linear-BRO-42-x', base);
  commitFile(r, 'src/h.ts', 'h\n', 'BRO-40: add q'); // another card's subject
  git(r, 'checkout', '-q', '-b', 'job/linear-BRO-40-y', base);
  commitFile(r, 'src/q.ts', 'q\n', 'BRO-40: add q');
  commitFile(r, 'src/q2.ts', 'q2\n', 'BRO-40: add q'); // same subject reused for different work
  git(r, 'checkout', '-q', '-b', 'job/linear-BRO-40-z', base);
  commitFile(r, 'src/z.ts', 'z\n', 'BRO-40: add q'); // one commit, same subject, other file
  git(r, 'checkout', '-q', 'main');
  // Main lands BRO-40 (rebased sha), then edits the same file later; a generic subject also exists on main.
  commitFile(r, 'src/q.ts', 'q\n', 'BRO-40: add q');
  commitFile(r, 'src/q.ts', 'q\nlater main edit\n', 'BRO-99: touch q');
  commitFile(r, 'src/g.ts', 'other\n', 'address ship-check findings');
  git(r, 'push', '-q', 'origin', 'main');
  const v = (b) => branchLandedDespiteRebase({ repo: r, branch: b, tips: [] });
  const landed = v('job/linear-BRO-40-x');
  assert.equal(landed.landed, true, landed.reason);
  assert.match(landed.reason, /BRO-40 subject/);
  assert.equal(v('job/linear-BRO-41-x').landed, false, 'a generic subject without the branch BRO id never matches');
  assert.equal(v('job/linear-BRO-42-x').landed, false, "another card's subject does not count for this branch");
  assert.equal(v('job/linear-BRO-40-y').landed, false, 'a second commit under a reused subject is not accounted for');
  assert.equal(v('job/linear-BRO-40-z').landed, false, 'a reused subject on a different file is not accounted for');
});

test('watchdog re-check still works after GC retires a job worktree (reads the kept job/<x> ref)', () => {
  const fx = buildFixture();
  for (const n of ['job-unlanded', 'job-rebased-tip']) git(fx.repo, 'worktree', 'remove', '--force', fx.wts[n]);
  assert.equal(detectJobLanding({ cwd: fx.wts['job-unlanded'] }).status, 'unlanded');
  assert.equal(detectJobLanding({ cwd: fx.wts['job-rebased-tip'] }).status, 'landed');
  // resume-headless-job.js restores a retired checkout from the kept branch.
  assert.equal(restoreRetiredJobWorktree(fx.wts['job-unlanded']), 'job/unlanded');
  assert.equal(fs.readFileSync(path.join(fx.wts['job-unlanded'], 'src/u.ts'), 'utf8'), 'u\n');
  git(fx.repo, 'worktree', 'remove', '--force', fx.wts['job-unlanded']);
  git(fx.repo, 'branch', '-D', 'job/unlanded');
  assert.equal(detectJobLanding({ cwd: fx.wts['job-unlanded'] }).status, 'unknown', 'no worktree and no branch stays unknown');
  assert.equal(restoreRetiredJobWorktree(fx.wts['job-unlanded']), null);
});

test('gatherIgnoredInputs: a setup copy much older than the newest setup link is not "untouched"', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ignored-window-')));
  FIXTURE_ROOTS.push(tmp);
  git(tmp, 'init', '-q');
  writeUnder(tmp, '.gitignore', '.env\ndata/*.json\n');
  fs.mkdirSync(path.join(tmp, 'data'));
  writeUnder(tmp, 'data/grosses.json', '{"fresh":true}\n');
  writeUnder(tmp, 'data/commercial.json', '{"edited":true}\n');
  const old = new Date(Date.now() - 120e3);
  fs.utimesSync(path.join(tmp, 'data/commercial.json'), old, old); // edited two minutes before a link-only re-run
  fs.symlinkSync(path.join(tmp, '.gitignore'), path.join(tmp, '.env')); // the re-run's new link
  const facts = Object.fromEntries(gatherIgnoredInputs(tmp, null).map((i) => [i.entry, i.facts]));
  assert.equal(facts['data/grosses.json'].untouchedSinceSetup, true);
  assert.equal(facts['data/commercial.json'].untouchedSinceSetup, false);
});

test('ignored-input classifier: disposable vs keep', () => {
  for (const e of ['.cache/', 'data/audit/outlet-census/.cache/', 'scripts/x/__pycache__/', 'tsconfig.tsbuildinfo',
    'next-env.d.ts', 'expo-env.d.ts', '.expo/', 'dist/', 'ios/', 'node_modules/', '.claude/visual-qa/',
    'data/audit/intake-ledger.jsonl', 'data/site-image-versions.json']) {
    assert.notEqual(classifyIgnoredEntry(e, {}), null, e);
  }
  for (const e of ['data/finances/', 'data/grosses.json', 'data/opening-night-sent.json', 'data/review-texts/', 'data/aggregator-archive/', 'data/shows.json', '.env',
    '.env.local', 'data/subscribers.json', '.claude/settings.local.json', 'nested-repo/']) {
    assert.equal(classifyIgnoredEntry(e, {}), null, e);
  }
  assert.equal(classifyIgnoredEntry('.env', { isSymlink: true }), 'symlink');
  assert.equal(classifyIgnoredEntry('data/grosses.json', { untouchedSinceSetup: true }), 'setup-copy');
  assert.equal(classifyIgnoredEntry('data/grosses.json', { identicalToMain: true }), 'setup-copy');
  assert.equal(classifyIgnoredEntry('data/grosses.json', { untouchedSinceSetup: false }), null, 'an edited setup copy keeps');
  assert.equal(classifyIgnoredEntry('data/review-texts/', { isEmptyDir: true }), 'empty-dir');
  assert.equal(classifyIgnoredEntry('.env.local', { identicalToMain: true }), 'identical-to-main');
  const d = decideIgnoredInputs([{ entry: 'data/grosses.json', facts: { untouchedSinceSetup: true } }, { entry: 'data/finances/', facts: {} }]);
  assert.deepEqual(d, { safe: false, blocker: 'data/finances/', discardedCopies: ['data/grosses.json'] });
});

test('parity: every file setup-local-data.sh copies into data/ is a known setup copy', () => {
  const src = fs.readFileSync(SETUP_SCRIPT, 'utf8');
  for (const arr of ['COPY_FILES', 'GENERATED_FILES']) {
    const m = new RegExp(`^${arr}=\\(([^)]*)\\)`, 'm').exec(src);
    assert.ok(m, `${arr} not found in setup-local-data.sh`);
    for (const f of m[1].split(/\s+/).filter(Boolean)) {
      assert.ok(SETUP_COPIED_DATA_FILES.has(f), `${f} (setup-local-data.sh ${arr}) missing from SETUP_COPIED_DATA_FILES`);
    }
  }
});

test('morning-digest Mac disk line: free, worktree counts, top 3 by size', () => {
  const { macDiskLine } = require('../lib/mac-disk-digest.js');
  const line = macDiskLine({ freeGb: 38, worktrees: { total: 102, job: 61 }, sizes: [
    { label: 'a', kb: 1 * 1024 * 1024 }, { label: 'big', kb: 11 * 1024 * 1024 }, { label: 'mid', kb: 2.4 * 1024 * 1024 }, { label: 'c', kb: 2 * 1024 * 1024 },
  ] });
  assert.equal(line, 'Mac disk: 38GB free, 102 worktrees (61 job); biggest: big 11GB, mid 2.4GB, c 2.0GB.');
  const { statusDescription, digestLineFromStatus, readMacDiskStatus } = require('../lib/mac-disk-digest.js');
  assert.equal(statusDescription('x'.repeat(200)).length, 140);
  assert.match(digestLineFromStatus(null), /no report from the Mac/);
  assert.equal(digestLineFromStatus({ line: 'Mac disk: 5GB free.', at: '2026-11-23T00:00:00Z' }, new Date('2026-11-23T03:00:00Z')), 'Mac disk: 5GB free. (measured 3h ago)');
  assert.match(macDiskLine({ freeGb: null, worktrees: { total: 0, job: 0 }, sizes: null }), /free space unknown.*biggest consumers unavailable/);
});

test('readMacDiskStatus returns the newest mac/disk status walking main, {error} on a read failure', async () => {
  const { readMacDiskStatus, digestLineFromStatus } = require('../lib/mac-disk-digest.js');
  const pages = [
    { repository: { ref: { target: { history: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ status: null }, { status: { context: null } }] } } } } },
    { repository: { ref: { target: { history: { pageInfo: { hasNextPage: false }, nodes: [{ status: { context: { description: 'Mac disk: 9GB free.', createdAt: '2026-11-23T01:00:00Z' } } }] } } } } },
  ];
  let i = 0;
  assert.deepEqual(await readMacDiskStatus({ graphql: async () => pages[i++] }), { line: 'Mac disk: 9GB free.', at: '2026-11-23T01:00:00Z' });
  const failed = await readMacDiskStatus({ graphql: async () => { throw new Error('boom'); } });
  assert.deepEqual(failed, { error: 'boom' });
  assert.match(digestLineFromStatus(failed), /Mac disk: unknown \(could not read the Mac's report: boom\)/);
});
