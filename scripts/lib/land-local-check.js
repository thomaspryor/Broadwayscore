#!/usr/bin/env node
/**
 * land-local-check.js — run the land gauntlet's test gates locally before pushing land/<name>
 * (BRO-5730). 65 of 77 refused land runs (10/16-10/19) failed in Checks on repo-wide guard
 * tests the branch tripped; the Codex runner, which runs these gates before landing, was
 * refused 3% of the time against 17% for Claude workers.
 *
 * It is the land.yml sequence, run on HEAD in this checkout with the same CLIs:
 *   1. land-gauntlet.sh on HEAD (GAUNTLET_GATES = the chosen gates)
 *   2. land-gate-delta.js --red-gates: which gates are red on HEAD; a red node test gate whose
 *      failures sit in a few files of a finished batch re-runs those files alone on HEAD, and the
 *      base runs the same files alone (BRO-7752: a timing failure no longer forces a full base)
 *   3. land-gauntlet.sh on the merge-base with origin/main, failing test files only when
 *      safely identifiable (otherwise full red gates), in a throwaway
 *      detached worktree (BRO-6252: never in this checkout, which keeps committing meanwhile)
 *   4. land-gate-delta.js --base-dir --branch-dir: a failure counts only when main passes it
 * so a later change to land.yml's judging (land-gate-delta.js) applies here too.
 *
 * The gauntlet runs under the container-wide land-check mutex the Codex runner also takes
 * (codex-runner.js CONTAINER_LAND_MUTEX): two at once on a 4-core container time tests out.
 *
 * Usage: node scripts/lib/land-local-check.js [--gates a,b] [--all] [--max-wait-minutes N]
 *   --gates  comma list (default: every gate land.yml blocks on, less LOCAL_SKIPPED_GATES;
 *            BRO-5771's land was refused on unit-tests-tsx, then not a default)
 *   --all    every gauntlet gate (land-gate-delta.js GATES)
 *   --max-wait-minutes  give up waiting for the mutex after N min (default 20): exit 4 with a
 *            warning, so a worker is never stranded behind another check
 * Exit: 0 no new failures | 1 new failures (printed) | 2 usage | 3 not ready (tracked
 *       changes, under 4 GB free disk (BRO-7186, BRO-7467), no common history with origin/main even after bounded
 *       --deepen rounds on a shallow clone (BRO-7731: prints the cut-new-branch recipe), or no local core data) | 4 skipped
 *       (mutex wait timed out)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./codex-runner.js');
const { lowDiskMessage, freeBytesOf, envFailureLogs } = require('./land-check-resources.js');
const { GATES, ADVISORY_GATES, readGateResult, readGateFiles, parseGateFailures, computeRerunScope } = require('./land-gate-delta.js');

// Blocking gates left out of the default run, each with its reason. Every other gate land.yml
// blocks on runs by default, so a new blocking gate is checked locally the day it is armed
// (land-local-check.test.mjs fails if a blocking gate is in neither list).
const LOCAL_SKIPPED_GATES = {
  'bash-integration': 'slow shell suites; rarely behind a refusal (run with --all)',
  'toplevel-regression': 'slow top-level regression scripts (run with --all)',
};
const isAdvisory = (g) => !!(ADVISORY_GATES[g] && ADVISORY_GATES[g]());
const DEFAULT_GATES = GATES.filter((g) => !isAdvisory(g) && !LOCAL_SKIPPED_GATES[g]);
// Gates whose test files run under plain `node --test`; a tsx gate's .mjs files import .ts
// source through `@/` aliases, so a lone `node --test` re-run fails for another reason.
const NODE_RERUN_GATES = new Set(['unit-tests-node', 'scripts-lib-tests']);
const ROOT = path.resolve(__dirname, '..', '..');

// Core data files the unit gates read (gitignored, so a fresh worktree has none). land.yml
// checks them out; without them both the base and the branch run fail data-dependent tests in
// slightly different sets, which reads as "new failures" (BRO-6037 session, 2026-10-23: 24 min
// spent to report 13 false failures in show-identity / show-venue / review-file-writer tests).
// The generated cast manifests are also static imports in src/: tsc fails without them,
// even when setup-local-data.sh found the private core data in a cloud checkout.
const CORE_DATA_FILES = ['data/shows.json', 'data/reviews.json', 'data/cast-manifest.json', 'data/actor-slugs.json'];

/** -> list of CORE_DATA_FILES missing under root */
function missingCoreData(root, exists = fs.existsSync) {
  return CORE_DATA_FILES.filter((f) => !exists(path.join(root, f)));
}

// BRO-7110: the branch gauntlet runs in this tree and regenerates tracked
// prebuild outputs (data/gold-lists-computed.json). They were clean when the
// check started (it refuses a dirty tree), so put them back: otherwise the next
// run refuses with "commit or discard tracked changes", and a session may commit
// a generated file it never meant to change.
/** Restore modified tracked prebuild outputs under <root>; -> the paths restored */
function restorePrebuildResidue(root, git = (...a) => run('git', a, { cwd: root })) {
  const { PREBUILD_OUTPUTS } = require('./prebuild-outputs.js');
  const changed = git('diff', '--name-only', '--no-renames').stdout.split('\n').filter(Boolean);
  const residue = changed.filter((f) => PREBUILD_OUTPUTS.some((re) => re.test(f)));
  if (residue.length) git('checkout', '--', ...residue);
  return residue;
}

// BRO-7431: `next dev` writes .next/dev/types, which tsconfig.json includes. A stale or live copy
// makes the tsc gate fail with TS6053 on code that is fine. Remove it before the gates run and
// say so when a dev server is still alive (it will rewrite the dir).
/** Remove <root>/.next/dev; -> { removed, devAlive } */
function clearStaleDevTypes(root, { exists = fs.existsSync, rm = (p) => fs.rmSync(p, { recursive: true, force: true }), pgrep = () => run('pgrep', ['-f', 'next[ -]dev|next-server'], { cwd: root }).stdout } = {}) {
  const dir = path.join(root, '.next', 'dev');
  const removed = exists(dir);
  if (removed) rm(dir);
  return { removed, devAlive: !!String(pgrep() || '').trim() };
}

// BRO-7110: a run stopped mid-gauntlet never reaches restorePrebuildResidue, so
// its regenerated outputs block the next run. Not restored here (the tree's
// state at start is unknown), but named, with the one command that clears them.
/** porcelain status -> the refusal text */
function dirtyTreeMessage(porcelain) {
  const { PREBUILD_OUTPUTS } = require('./prebuild-outputs.js');
  const files = porcelain.split('\n').filter(Boolean).map((l) => l.trim().replace(/^\S+\s+/, '').replace(/^.* -> /, '')); // the caller's output may be trimmed
  const base = 'land-local-check: commit or discard tracked changes first:\n' + porcelain;
  if (!files.length || !files.every((f) => PREBUILD_OUTPUTS.some((re) => re.test(f)))) return base;
  // HEAD, not the index: a staged output must go back too. Many files (public/data/shows/*.json):
  // name their directories instead; every dirty file there is a generated output, so only those change.
  const targets = files.length <= 10 ? files : [...new Set(files.map((f) => path.dirname(f)))];
  return base + (base.endsWith('\n') ? '' : '\n') +
    `  only generated prebuild outputs changed (${files.length} file(s), often left by a stopped run); if you did not mean to change them: git checkout HEAD -- ${targets.join(' ')}`;
}

// BRO-7110: a worktree under the main checkout with no node_modules of its own
// still type-checks, resolving packages from the parent directory, but the /tmp
// base copy finds none. The two sides then fail with different error text and
// every error reads as new (639 false tsc failures on a diff with no TypeScript).
/** -> true when <root> has its own node_modules (a directory or a symlink to one) */
function hasOwnNodeModules(root, exists = fs.existsSync) {
  return exists(path.join(root, 'node_modules'));
}

const { missingDeclaredPackages } = require('./declared-packages.js');

// The main checkout links nothing (its git-common-dir is its own .git): install there.
// -sfn replaces a dangling link, which existsSync also reports as missing.
/** -> the one-line fix for a checkout with no node_modules */
function nodeModulesRemedy(root, commonDir) {
  const main = commonDir ? path.resolve(root, commonDir, '..') : root;
  if (main === path.resolve(root)) return 'Install them first: npm ci';
  return `Link them first: ln -sfn ${path.join(main, 'node_modules')} node_modules`;
}

// BRO-7731: a shallow cloud checkout whose branch was cut from an older base has no merge-base
// with origin/main inside the fetched history, so the run refused with a bare "shares no history".
// Deepen in bounded rounds instead. `git fetch --deepen=N origin main` deepens every shallow point
// the client holds, HEAD's own cut-off root included (checked on a scratch repo whose depth-1
// branch root is not on main). Each round is bounded in time (DEEPEN_TIMEOUT_MS) and in size:
// without a partial-clone (promisor) remote every blob of every commit comes down, so the last
// and largest round runs only when blobs can be left behind with --filter=blob:none.
const DEEPEN_TIMEOUT_MS = 120_000;
/** -> the fetch rounds to try, smallest first: [{ depth, args }] */
function deepenRounds({ promisor = false } = {}) {
  const depths = promisor ? [200, 1000, 5000] : [200, 1000];
  return depths.map((depth) => ({ depth, args: ['fetch', '-q', `--deepen=${depth}`, ...(promisor ? ['--filter=blob:none'] : []), 'origin', 'main'] }));
}

/**
 * Pure decision for the next step when HEAD and origin/main share no merge-base.
 * state: { shallow, mergeBase, round (rounds tried so far), rounds, last: { ok, progressed } | null }
 * -> { action: 'done' } | { action: 'deepen', round } | { action: 'give-up', reason }
 */
function nextHistoryStep({ shallow, mergeBase, round = 0, rounds = [], last = null }) {
  if (mergeBase) return { action: 'done' };
  if (!shallow) return { action: 'give-up', reason: 'not-shallow' };
  if (last && !last.ok) return { action: 'give-up', reason: 'fetch-failed' };
  // A round that moved no shallow point will not be helped by a bigger one: stop, don't burn fetches.
  if (last && !last.progressed) return { action: 'give-up', reason: 'no-progress' };
  if (round >= rounds.length) return { action: 'give-up', reason: 'rounds-exhausted' };
  return { action: 'deepen', round: rounds[round] };
}

const GIVE_UP_REASONS = {
  'not-shallow': 'this is a full clone, so HEAD and origin/main really share no commit',
  'fetch-failed': 'a bounded deepen fetch failed or timed out',
  'no-progress': 'a deepen fetch brought no older history',
  'rounds-exhausted': 'the bounded deepen rounds did not reach a common commit',
};

/**
 * The recipe that moves a branch's own commits onto current origin/main.
 * commits: oldest first, the output of `git rev-list --reverse origin/main..HEAD`; only trusted
 * (and so only printed) when a merge-base exists. Without one that range is HEAD's whole fetched
 * history, not the branch's commits, so the recipe has the reader find them by hand.
 * cutOffRoots: shallow points HEAD's own history still ends at.
 */
function noCommonHistoryRecipe({ branch, mergeBase = '', commits = [], cutOffRoots = [], reason = '' } = {}) {
  const name = `${branch && branch !== 'HEAD' ? branch : 'my-branch'}-v2`;
  const lines = [];
  if (!mergeBase) {
    lines.push(`land-local-check: HEAD shares no history with origin/main${reason ? ` (${GIVE_UP_REASONS[reason] || reason})` : ''}.`);
    if (cutOffRoots.length) lines.push(`  HEAD's own history is cut off at ${cutOffRoots.map((s) => s.slice(0, 10)).join(', ')} (a shallow clone boundary), so its base commit is not here.`);
  }
  lines.push('  Move your commits onto current origin/main:', '    git fetch origin main', `    git switch -c ${name} origin/main`);
  if (mergeBase && commits.length && commits.length <= 20) {
    lines.push(`    git cherry-pick ${commits.join(' ')}`); // keep-run-ok: printed advice for a human, never executed
  } else {
    lines.push(`    git log --oneline -n 20 ${branch && branch !== 'HEAD' ? branch : '<old-branch>'}   # find your own commits (newest first)`,
      '    git cherry-pick <your oldest sha>^..<your newest sha>   # or list them, oldest first'); // keep-run-ok: printed advice for a human, never executed
  }
  lines.push('  then re-run this check from the new branch.');
  return lines.join('\n');
}

/** -> { gates, maxWaitMs } or { error } */
function parseArgs(argv) {
  let gates = DEFAULT_GATES;
  let maxWaitMs = 20 * 60_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') gates = GATES;
    else if (a === '--gates') gates = String(argv[++i] || '').split(',').map((g) => g.trim()).filter(Boolean);
    else if (a === '--max-wait-minutes') maxWaitMs = Number(argv[++i]) * 60_000;
    else if (a === '-h' || a === '--help') return { help: true };
    else return { error: `unknown argument: ${a}` };
  }
  const unknown = gates.filter((g) => !GATES.includes(g));
  if (!gates.length || unknown.length) return { error: `unknown gate(s): ${unknown.join(',') || '(none given)'}; known: ${GATES.join(',')}` };
  if (!(maxWaitMs > 0)) return { error: '--max-wait-minutes must be a positive number' };
  return { gates, maxWaitMs };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status === null ? 1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
const git = (...args) => run('git', args);

/** -> the shallow-boundary commits the repo at cwd holds ([] in a full clone) */
function shallowPoints(cwd = ROOT) {
  const file = path.resolve(cwd, run('git', ['rev-parse', '--git-path', 'shallow'], { cwd }).stdout || '.git/shallow');
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).sort(); } catch { return []; }
}

/** -> shallow-boundary commits in HEAD's own history (where HEAD itself is cut off) */
function headShallowRoots(head, cwd = ROOT) {
  const points = new Set(shallowPoints(cwd));
  if (!points.size) return [];
  return run('git', ['rev-list', head], { cwd }).stdout.split('\n').filter((c) => points.has(c));
}

/** -> { base, reason, deepened }: the merge-base with origin/main, deepening a shallow clone in bounded rounds */
function findMergeBase(head, { cwd = ROOT, rounds = null, timeoutMs = DEEPEN_TIMEOUT_MS, log = (m) => console.error(m) } = {}) {
  const g = (...args) => run('git', args, { cwd });
  let plan = rounds;
  let round = 0;
  let last = null;
  for (;;) {
    const mergeBase = g('merge-base', head, 'origin/main').stdout;
    if (mergeBase) return { base: mergeBase, deepened: round };
    // Only a missing merge-base pays for the shallow and promisor lookups.
    if (!plan) plan = deepenRounds({ promisor: g('config', '--get', 'remote.origin.promisor').stdout === 'true' });
    const step = nextHistoryStep({ shallow: g('rev-parse', '--is-shallow-repository').stdout === 'true', mergeBase, round, rounds: plan, last });
    if (step.action === 'done') return { base: mergeBase, deepened: round };
    if (step.action === 'give-up') return { base: '', reason: step.reason, deepened: round };
    const before = shallowPoints(cwd).join('\n');
    log(`land-local-check: no merge-base with origin/main in this shallow clone; git fetch --deepen=${step.round.depth} (up to ${Math.round(timeoutMs / 1000)}s)`);
    const r = run('git', step.round.args, { cwd, timeout: timeoutMs });
    last = { ok: r.code === 0, progressed: shallowPoints(cwd).join('\n') !== before };
    round += 1;
  }
}

class MutexTimeout extends Error {}

// The gauntlet already persists stdout and stderr per gate. Surface diagnostics
// before the potentially long base comparison, reusing the verdict's parsers.
function printRedGates(dir, gates, label) {
  for (const gate of gates) {
    const result = readGateResult(dir, gate);
    console.log(`land-local-check: ${label} ${gate}: ${path.join(dir, `${gate}.log`)}`);
    const failures = result ? [...parseGateFailures(gate, result.text, result.root).values()] : [];
    for (const failure of failures.slice(0, 5)) console.log(`  ${failure.file}::${failure.name}`);
    if (failures.length > 5) console.log(`  ${failures.length - 5} more failure(s) in the log`);
    if (!failures.length) console.log('  No individual failure parsed (missing result, crash or timeout); inspect the gate log.');
  }
}

/**
 * The test files behind land-gate-delta.js's "NEW on the branch" lists, or null when a re-run
 * cannot clear the verdict: a new failure that is not a test case (a lint finding), one in a
 * gate whose files do not run under plain node (NODE_RERUN_GATES), or a FAIL gate with no NEW
 * list of its own (no result, a crash or timeout, a fail-safe verdict).
 */
function newFailureFiles(deltaText) {
  const files = new Set();
  const failGates = new Set();
  const newGates = new Set();
  let inNew = false;
  let gate = null;
  for (const line of String(deltaText || '').split('\n')) {
    const row = line.match(/^\|\s*([\w-]+)\s*\|\s*\*\*FAIL\*\*/);
    if (row) { failGates.add(row[1]); continue; }
    if (/^#{2,4} /.test(line)) {
      inNew = /NEW on the branch/.test(line);
      const g = line.match(/^#{2,4} ([\w-]+) /);
      gate = g ? g[1] : null;
      if (inNew && g) newGates.add(g[1]);
      continue;
    }
    if (!inNew || !/^\s+- /.test(line)) continue;
    if (!NODE_RERUN_GATES.has(gate)) return null;
    const m = line.match(/`([^`:]+\.test\.m?js)::/);
    if (!m) return null;
    files.add(m[1]);
  }
  if ([...failGates].some((g) => !newGates.has(g))) return null;
  return [...files];
}

// BRO-7752: a load timing failure (testTimeoutFailure) in a HEAD batch made --rerun-scope pick a
// FULL base gate, and the base unit gates in full pushed the check past the 30 min background
// limit. As the Codex runner does (BRO-7134, daily-runner.js isolatedBranchRuns), re-run the
// failing files alone on HEAD too and scope the base to the same files: alone vs alone.
// Above this many files a shared break is likelier than a few flaky files: keep today's path.
const MAX_ISOLATED_FILES = 25;

/**
 * Pure. Red node gates whose failures can be judged by re-running the failing files alone on both
 * sides -> [{ gate, files }] (files as the batch listed them). computeRerunScope({isolated}) decides:
 * every failure located in a file the finished batch ran (a killed batch keeps the full base).
 */
function isolatedRecheckPlan(red, branchDir, { read = readGateResult, readFiles = readGateFiles, maxFiles = MAX_ISOLATED_FILES } = {}) {
  const plans = [];
  for (const gate of red) {
    if (!NODE_RERUN_GATES.has(gate)) continue;
    const scope = computeRerunScope({ gate, branch: read(branchDir, gate), branchFiles: readFiles(branchDir, gate), isolated: true });
    if (scope.scoped && scope.files.length && scope.files.length <= maxFiles) plans.push({ gate, files: scope.files });
  }
  return plans;
}

/** Pure. An alone re-run counts only when it finished: an exit code and node's final `# tests N` line.
 * Anything else (killed, crashed, no result) keeps the batch verdict. */
function aloneRunFinished(result) {
  return !!result && (result.exit === 0 || result.exit === 1) && /^# tests \d+\s*$/m.test(result.text || '');
}

/** Write <dir>/<gate>.files for each plan (land-gauntlet.sh GAUNTLET_SCOPE_DIR format). */
function writeScopeFiles(dir, plans) {
  fs.mkdirSync(dir, { recursive: true });
  for (const { gate, files } of plans) fs.writeFileSync(path.join(dir, `${gate}.files`), `${files.join('\n')}\n`);
}

/** Make the alone result <gate>'s branch verdict; the batch result stays as <gate>.batch.{log,exit}. */
function adoptAloneResult(branchDir, aloneDir, gate) {
  for (const ext of ['log', 'exit']) {
    const cur = path.join(branchDir, `${gate}.${ext}`);
    if (fs.existsSync(cur)) fs.renameSync(cur, path.join(branchDir, `${gate}.batch.${ext}`));
    fs.copyFileSync(path.join(aloneDir, `${gate}.${ext}`), cur);
  }
}

// The base run checks out an older tree, so the gauntlet runs from a copy outside it. That copy
// needs every sibling the gauntlet calls via $(dirname "${BASH_SOURCE[0]}")/... (BRO-6152: a lone
// copy lost tsc-node-options.sh). land.yml's "Stage the branch's gauntlet harness" step mirrors
// this list; land-local-check.test.mjs fails if either drifts from the gauntlet's references.
const HARNESS_FILES = ['land-gauntlet.sh', 'tsc-node-options.sh'];

/** Copy the harness from <fromRoot>/scripts/lib into <dir>; returns the gauntlet copy's path.
 * A helper missing from the source tree is skipped (the gauntlet has a fallback); the gauntlet is not. */
function stageGauntletHarness(fromRoot, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // mkdtemp dirs are 0700; the codex runner runs the copy as the sandbox user, which must be able to read it.
  // 0755, not 0777: the sandbox must not be able to rewrite the harness.
  fs.chmodSync(dir, 0o755);
  for (const name of HARNESS_FILES) {
    const src = path.join(fromRoot, 'scripts/lib', name);
    if (name === 'land-gauntlet.sh' || fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  return path.join(dir, 'land-gauntlet.sh');
}

// Paths git ignores that the base tree needs but a fresh `git worktree add` lacks: node_modules,
// core data, generated manifests. The old in-place base run saw every one of them; linking only
// a few would let the base fail data-dependent tests the branch passes, which the delta forgives
// as pre-existing (a false CLEAN). Build output and nested worktrees stay out.
// .claude/ and lock dirs are live session state the caller keeps writing while the base run goes.
const LINK_SKIP = [/^\.next\//, /^\.claude\//, /\.lock\/?$/, /\.tsbuildinfo$/, /^\.git\//];

/** -> ignored paths (dirs end with "/") present under root */
function ignoredPaths(root) {
  const r = run('git', ['ls-files', '-z', '-oi', '--exclude-standard', '--directory'], { cwd: root });
  return r.stdout.split('\0').filter((p) => p && !LINK_SKIP.some((re) => re.test(p)));
}

/** Symlink every ignored path of <root> that <dir> lacks into <dir>; -> the symlinks created (also pushed into <made> as they appear, so a throw midway still leaves a cleanup list) */
function linkIgnored(root, dir, made = []) {
  for (const rel of ignoredPaths(root)) {
    const name = rel.replace(/\/$/, '');
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(path.join(root, name), dest);
    made.push(dest);
  }
  // BRO-7150: a job worktree (~/Broadwayscore/.claude/worktrees/job-*) has no node_modules of its own;
  // Node finds the main checkout's by walking up. A throwaway worktree under os.tmpdir() cannot, so
  // every base re-run there crashed ("Cannot find module 'typescript'") and the fast tests could
  // never refuse from a job worktree. Link the node_modules <root> actually resolves.
  const nm = path.join(dir, 'node_modules');
  const resolved = !fs.existsSync(nm) && resolvedNodeModules(root);
  if (resolved) {
    fs.symlinkSync(resolved, nm);
    made.push(nm);
  }
  return made;
}

/** The node_modules directory Node resolves from <root>: its own, else the nearest ancestor's. -> path | null */
function resolvedNodeModules(root) {
  for (let d = path.resolve(root); ; d = path.dirname(d)) {
    const nm = path.join(d, 'node_modules');
    try { if (fs.statSync(nm).isDirectory()) return nm; } catch { /* keep walking */ }
    if (path.dirname(d) === d) return null;
  }
}

/** True when <head> changes package.json or package-lock.json relative to <base>. */
function depsChangedSince(git, base, head) {
  return Boolean(git('diff', '--name-only', base, head, '--', 'package.json', 'package-lock.json').stdout);
}

/**
 * Run fn(worktreeDir) on <sha> checked out in a throwaway detached worktree at <dir>, then remove
 * it. The caller's checkout (HEAD, branch, index) is never touched, so it can keep committing
 * while the base gates run. Never pass --deps-changed to a gauntlet run here: `npm ci` would wipe
 * the caller's node_modules through the symlink.
 */
function withBaseWorktree(root, sha, dir, fn) {
  const g = (...args) => run('git', args, { cwd: root });
  g('worktree', 'prune'); // a run killed by SIGKILL leaves its entry behind
  const add = g('worktree', 'add', '--detach', '-f', dir, sha);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
  const links = [];
  try {
    linkIgnored(root, dir, links);
    return fn(dir);
  } finally {
    // Unlink exactly what was linked, first: remove --force must not follow them into the caller's data.
    for (const p of links) {
      try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* absent */ }
    }
    g('worktree', 'remove', '--force', dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    g('worktree', 'prune');
  }
}

const RUN_DIR_RE = /^land-local-check-[a-f0-9]{10}-[A-Za-z0-9]{6}$/;
const STALE_RUN_MS = 2 * 3600_000;

/**
 * BRO-7652: what cleanupStaleRuns does with one temp entry. Pure.
 * hasLiveProcess: true | false | 'unknown' (no /proc, or a process whose cwd could not be read).
 * -> 'skip' (not a run dir) | 'keep' | 'remove'
 * A process working inside the dir keeps it at every age. A dir over maxAgeMs goes (the old
 * rule). A younger one goes only when it holds a registered, unlocked base worktree and no
 * process is known to be in it: a killed run's ~1.8 GB checkout, which would otherwise trip the
 * 4 GB free-disk guard on a re-run inside 2h. Unknown liveness falls back to the age rule.
 */
function staleRunDecision({ name, isDirectory, ageMs, hasBaseWorktree, hasLiveProcess }, { maxAgeMs = STALE_RUN_MS } = {}) {
  if (!isDirectory || !RUN_DIR_RE.test(String(name || ''))) return 'skip';
  if (hasLiveProcess === true) return 'keep';
  if (ageMs > maxAgeMs) return 'remove';
  if (hasBaseWorktree && hasLiveProcess === false) return 'remove';
  return 'keep';
}

/** -> { cwds: real cwd paths of running processes, unknown: true when /proc or any cwd was unreadable } */
function processCwds(procDir = '/proc') {
  let pids;
  try { pids = fs.readdirSync(procDir).filter((p) => /^\d+$/.test(p)); } catch { return { cwds: [], unknown: true }; }
  const cwds = [];
  let unknown = false;
  for (const pid of pids) {
    try { cwds.push(fs.readlinkSync(path.join(procDir, pid, 'cwd'))); } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ESRCH')) continue; // exited meanwhile
      unknown = true; // EACCES/EPERM: it may be working in the dir
    }
  }
  return { cwds, unknown };
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const within = (p, realDir) => p === realDir || p.startsWith(realDir + path.sep);

/** -> true | false | 'unknown': is any process working inside <dir>? */
function liveProcessIn(dir, scan) {
  const realDir = realOr(dir);
  if (scan.cwds.some((c) => within(realOr(c), realDir))) return true;
  return scan.unknown ? 'unknown' : false;
}

/** porcelain `git worktree list` -> Map(real path -> { locked }) */
function parseWorktreeList(porcelain) {
  const out = new Map();
  for (const block of String(porcelain || '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '));
    if (!wt) continue;
    out.set(realOr(wt.slice('worktree '.length)), { locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')) });
  }
  return out;
}

/** True when <dir>/basewt is a real directory (not a link) registered as an unlocked worktree of root. */
function hasRegisteredBaseWorktree(dir, worktrees) {
  const wt = path.join(dir, 'basewt');
  try { if (!fs.lstatSync(wt).isDirectory()) return false; } catch { return false; }
  const reg = worktrees.get(realOr(wt));
  return !!reg && !reg.locked;
}

// Call only while holding CONTAINER_LAND_MUTEX: every run creates its dir inside it.
// SIGKILL cannot run a finally handler, so the next run reclaims its checkout before
// checking free space. Keep recent logs for diagnosis, and never follow directory links.
function cleanupStaleRuns(root, temp = os.tmpdir(), now = Date.now(), { procDir = '/proc' } = {}) {
  const removed = [];
  let scan = null;
  let worktrees = null;
  for (const entry of fs.readdirSync(temp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_DIR_RE.test(entry.name)) continue; // staleRunDecision's 'skip', before any /proc scan
    const dir = path.join(temp, entry.name);
    try {
      scan = scan || processCwds(procDir);
      worktrees = worktrees || parseWorktreeList(run('git', ['worktree', 'list', '--porcelain'], { cwd: root }).stdout);
      const decision = staleRunDecision({
        name: entry.name,
        isDirectory: true,
        ageMs: now - fs.statSync(dir).mtimeMs,
        hasBaseWorktree: hasRegisteredBaseWorktree(dir, worktrees),
        hasLiveProcess: liveProcessIn(dir, scan),
      });
      if (decision !== 'remove') continue;
      const wt = path.join(dir, 'basewt');
      if (fs.existsSync(wt)) {
        const result = run('git', ['worktree', 'remove', '--force', wt], { cwd: root });
        // A foreign/locked worktree or a failed removal is not ours to erase.
        if (result.code !== 0 && fs.existsSync(path.join(wt, '.git'))) continue;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      removed.push(dir);
    } catch (e) {
      console.error(`land-local-check: could not clean ${dir}: ${e.message}`);
    }
  }
  if (removed.length) run('git', ['worktree', 'prune'], { cwd: root });
  return removed;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    const lines = fs.readFileSync(__filename, 'utf8').split('\n');
    console.log(lines.slice(1, lines.indexOf(' */') + 1).join('\n'));
    return 0;
  }
  if (opts.error) { console.error(`land-local-check: ${opts.error}`); return 2; }

  // The branch run judges the working tree as committed; uncommitted tracked edits would make it
  // judge something no push carries. (The base run no longer touches this tree: BRO-6252.)
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty.stdout) { console.error(dirtyTreeMessage(dirty.stdout)); return 3; }
  const missing = missingCoreData(ROOT);
  if (missing.length) {
    console.error(`land-local-check: ${missing.join(', ')} missing in this checkout (a worktree has no local data). `
      + 'Data-dependent tests would fail on both sides and report false new failures. '
      + 'Run ./scripts/setup-local-data.sh --link-only: it links core data and builds the cast manifests from data/cast/ '
      + '(by hand: node scripts/build-actor-slugs-manifest.js && node scripts/build-cast-manifest.js).');
    return 3;
  }
  if (!hasOwnNodeModules(ROOT)) {
    console.error('land-local-check: node_modules missing in this checkout. Packages would resolve from a parent '
      + 'checkout here but not in the base copy, so every type and lint error would read as new. '
      + nodeModulesRemedy(ROOT, git('rev-parse', '--git-common-dir').stdout));
    return 3;
  }
  const pkgs = missingDeclaredPackages(ROOT);
  if (pkgs.missing.length) {
    console.error(`land-local-check: node_modules is incomplete (${pkgs.missing.length} package(s) declared in ${pkgs.owner}/package.json are not installed, e.g. ${pkgs.missing.slice(0, 5).join(', ')}). `
      + `Both runs share this install, so every gate would fail on both sides and nothing could be judged. Reinstall first: (cd ${pkgs.owner} && npm ci)`);
    return 3;
  }
  const fetch = git('fetch', '-q', 'origin', 'main');
  if (fetch.code !== 0) console.error(`land-local-check: git fetch failed, judging against the local origin/main (${fetch.stderr.split('\n').pop()})`);
  const head = git('rev-parse', 'HEAD').stdout;
  // Judge against the main commit HEAD sits on: main moves every few minutes, so demanding the
  // newest one would refuse nearly every run. Rebase conflicts are land-preflight.mjs's job.
  const { base, reason, deepened } = findMergeBase(head);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout;
  if (!base) {
    console.error(noCommonHistoryRecipe({ branch, reason, cutOffRoots: headShallowRoots(head) }));
    return 3;
  }
  if (deepened) console.log(`land-local-check: deepened the shallow history ${deepened} time(s) to find the merge-base with origin/main`);
  const behind = Number(git('rev-list', '--count', `${head}..origin/main`).stdout) || 0;
  if (behind > 200) {
    const commits = git('rev-list', '--reverse', '--max-count=21', `origin/main..${head}`).stdout.split('\n').filter(Boolean);
    console.error(`land-local-check: HEAD is ${behind} commits behind origin/main; rebase for a closer match to what land.yml judges\n`
      + noCommonHistoryRecipe({ branch, mergeBase: base, commits }));
  }

  const dev = clearStaleDevTypes(ROOT);
  if (dev.removed) console.log('land-local-check: removed .next/dev (stale `next dev` types fail the tsc gate with TS6053)');
  if (dev.devAlive) console.error('land-local-check: a `next dev`/`next-server` process is alive and will rewrite .next/dev/types; stop it (pkill -f "next dev") or tsc may fail with TS6053');
  // BRO-7101: the land workflow arms live-data-lane from a repo variable this
  // machine cannot read; arm it here too so a local check never reports CLEAN
  // on a test land.yml refuses. Override with LAND_LIVE_DATA_LANE_ARMED=0.
  const env = { LAND_LIVE_DATA_LANE_ARMED: '1', ...process.env, GAUNTLET_PARALLEL: '1', LAND_BASE: base };
  const t0 = Date.now();
  let waited = false;
  try {
    return R.withFileMutex(R.CONTAINER_LAND_MUTEX, () => {
      if (waited) console.log(`land-local-check: got the land-check mutex after ${Math.round((Date.now() - t0) / 60_000)} min`);
      const reclaimed = cleanupStaleRuns(ROOT);
      if (reclaimed.length) console.log(`land-local-check: removed ${reclaimed.length} stale temporary run(s)`);
      // Reclaim killed runs first, so their checkouts cannot trip our own disk guard.
      const lowDisk = lowDiskMessage(freeBytesOf(ROOT)) || lowDiskMessage(freeBytesOf(os.tmpdir()), { when: 'in the temp dir before the run' });
      if (lowDisk) { console.error(lowDisk); return 3; }
      const out = fs.mkdtempSync(path.join(os.tmpdir(), `land-local-check-${head.slice(0, 10)}-`));
      const branchDir = path.join(out, 'branch');
      const baseDir = path.join(out, 'base');
      console.log(`land-local-check: gates ${opts.gates.join(',')} on HEAD ${head.slice(0, 10)} (base ${base.slice(0, 10)}, the merge-base with origin/main)`);
      const b = run('bash', ['scripts/lib/land-gauntlet.sh', branchDir], { env: { ...env, GAUNTLET_GATES: opts.gates.join(',') }, stdio: ['ignore', 'ignore', 'inherit'] });
      const restored = restorePrebuildResidue(ROOT);
      if (restored.length) console.log(`land-local-check: restored ${restored.join(', ')} (regenerated by the gauntlet)`);
      if (!fs.existsSync(path.join(branchDir, 'meta.json'))) { console.error(`land-local-check: the gauntlet wrote no result (exit ${b.code}); see ${branchDir}`); return 1; }
      const redGatesNow = () => run('node', ['scripts/lib/land-gate-delta.js', '--red-gates', branchDir, '--gates', opts.gates.join(',')]).stdout;
      let red = redGatesNow();
      if (red) printRedGates(branchDir, red.split(','), 'HEAD');
      // BRO-7752: failing files re-run alone on HEAD, through the same gauntlet code path the base uses.
      const isolated = [];
      const plans = red ? isolatedRecheckPlan(red.split(','), branchDir) : [];
      if (plans.length) {
        const isoScope = path.join(out, 'isolated-scope');
        const aloneDir = path.join(out, 'branch-alone');
        writeScopeFiles(isoScope, plans);
        const { GAUNTLET_PARALLEL: _p, ...aloneEnv } = env;
        run('bash', ['scripts/lib/land-gauntlet.sh', aloneDir], { env: { ...aloneEnv, GAUNTLET_GATES: plans.map((p) => p.gate).join(','), GAUNTLET_SCOPE_DIR: isoScope }, stdio: ['ignore', 'ignore', 'inherit'] }); // no spawn timeout: it would kill bash and orphan node --test (per-test --test-timeout bounds it)
        const residue = restorePrebuildResidue(ROOT);
        if (residue.length) console.log(`land-local-check: restored ${residue.join(', ')} (regenerated by the alone re-run)`);
        for (const p of plans) {
          const r = readGateResult(aloneDir, p.gate);
          if (!aloneRunFinished(r)) { console.log(`land-local-check: ${p.gate}: the alone re-run of ${p.files.length} file(s) did not finish; keeping the batch verdict`); continue; }
          adoptAloneResult(branchDir, aloneDir, p.gate);
          isolated.push(p);
          console.log(`land-local-check: ${p.gate}: ${p.files.length} failing file(s) re-run alone on HEAD: ${r.exit === 0 ? 'all pass (failed only under batch load, not counted; land.yml still judges the full batch)' : 'still failing, judged alone against the same files alone on base'} (batch log: ${path.join(branchDir, `${p.gate}.batch.log`)})`);
        }
        if (isolated.length) red = redGatesNow();
      }
      // BRO-6114: the base worktree shares this checkout's node_modules (never reinstalled, see
      // withBaseWorktree), so with changed deps the base would be judged on HEAD's packages and a
      // dependency regression would read as "red on base too". Skip it: with no base result
      // land-gate-delta counts every red gate as new; land.yml reinstalls and judges the base.
      const depsChanged = red && depsChangedSince(git, base, head);
      if (depsChanged) console.log(`land-local-check: package.json/package-lock.json differ from the base; not judging the base with HEAD's node_modules, so red gates (${red}) count as new here. land.yml reinstalls the base's own deps and decides.`);
      if (red && !depsChanged) {
        // Same as land.yml: the gauntlet copy runs from outside the tree it checks out.
        const copy = stageGauntletHarness(ROOT, out);
        const scope = path.join(out, 'scope');
        const scoped = run('node', ['scripts/lib/land-gate-delta.js', '--rerun-scope', branchDir, '--gates', red, '--out', scope]);
        // BRO-7752: an alone-judged gate runs the same files alone on base, whatever --rerun-scope chose.
        const aloneRed = isolated.filter((p) => red.split(',').includes(p.gate));
        console.log(scoped.stdout.split('\n').filter((l) => !aloneRed.some((p) => l.startsWith(`${p.gate}: `))).join('\n'));
        writeScopeFiles(scope, aloneRed);
        for (const p of aloneRed) console.log(`${p.gate}: base re-check scoped to the ${p.files.length} file(s) re-run alone on HEAD (BRO-7752)`);
        const scopeDir = scoped.code === 0 || aloneRed.length ? scope : '';
        console.log(`land-local-check: red on HEAD: ${red}; running them on the base to tell new failures from old`);
        // A separate worktree on the merge-base: this checkout may commit while the base runs.
        try {
          withBaseWorktree(ROOT, base, path.join(out, 'basewt'), (wt) => {
            run('bash', [copy, baseDir], { cwd: wt, env: { ...env, GAUNTLET_GATES: red, GAUNTLET_SCOPE_DIR: scopeDir }, stdio: ['ignore', 'ignore', 'inherit'] });
            printRedGates(baseDir, red.split(',').filter((gate) => readGateResult(baseDir, gate)?.exit !== 0), 'base');
          });
        } catch (e) {
          // No base result: land-gate-delta fails safe on the missing base meta instead of this crashing.
          console.error(`land-local-check: base run failed (${e.message}); the verdict below has no base to compare against`);
        }
      }
      const d = run('node', ['scripts/lib/land-gate-delta.js', '--base-dir', baseDir, '--branch-dir', branchDir, '--gates', opts.gates.join(','), '--base-source', depsChanged ? 'skipped: deps changed vs base (BRO-6114)' : red ? `ran locally for ${red}` : 'not needed (every gate green on HEAD)'], { stdio: ['ignore', 'pipe', 'inherit'] });
      console.log(d.stdout);
      let clean = d.code === 0;
      // BRO-7186: disk filled during the run, or the raw gate logs show ENOSPC (on either side, clean or not):
      // those failures are the machine's, not the branch's. The delta summary drops error text, so read the logs.
      const enospc = envFailureLogs([branchDir, baseDir]);
      const lowAfter = lowDiskMessage(freeBytesOf(ROOT), { when: 'after the run' }) || lowDiskMessage(freeBytesOf(os.tmpdir()), { when: 'in the temp dir after the run' })
        || (enospc.length ? `land-local-check: ENOSPC (disk full) in ${enospc.join(', ')}. The run is not a valid verdict. Free space and re-run.` : null);
      if (lowAfter) { console.error(lowAfter); return 3; }
      // A gauntlet test file failing under load can pass alone (2026-10-20: a duplicate-of-url
      // test failed in the gauntlet, then passed 16/16 twice by itself). Re-run the new failures'
      // files once, alone; clean only when every new failure is a test file and all of them pass.
      const files = clean ? [] : newFailureFiles(d.stdout);
      if (files && files.length) {
        const again = run('node', ['--test', ...files]);
        console.log(`land-local-check: re-ran ${files.length} new-failure file(s) alone: ${again.code === 0 ? 'all pass (failed only under gauntlet load)' : 'still failing'}`);
        clean = again.code === 0;
      }
      console.log(`land-local-check: ${clean ? 'CLEAN, no new failures' : 'NEW FAILURES, fix them before pushing land/'} (${Math.round((Date.now() - t0) / 60_000)} min; logs in ${out})`);
      return clean ? 0 : 1;
    }, {
      pollMs: 15_000,
      onWait: () => {
        if (!waited) console.log('land-local-check: another land check holds the container mutex; waiting');
        waited = true;
        if (Date.now() - t0 > opts.maxWaitMs) throw new MutexTimeout();
      },
    });
  } catch (e) {
    if (!(e instanceof MutexTimeout)) throw e;
    console.error(`land-local-check: SKIPPED, waited ${Math.round(opts.maxWaitMs / 60_000)} min for the land-check mutex. Pushing now means land.yml is the only check.`);
    return 4;
  }
}

module.exports = { deepenRounds, nextHistoryStep, noCommonHistoryRecipe, findMergeBase, headShallowRoots, DEEPEN_TIMEOUT_MS, isolatedRecheckPlan, aloneRunFinished, writeScopeFiles, adoptAloneResult, MAX_ISOLATED_FILES, cleanupStaleRuns, staleRunDecision, processCwds, liveProcessIn, parseWorktreeList, clearStaleDevTypes, dirtyTreeMessage, nodeModulesRemedy, main, withBaseWorktree, depsChangedSince, linkIgnored, resolvedNodeModules, ignoredPaths, parseArgs, newFailureFiles, missingCoreData, hasOwnNodeModules, restorePrebuildResidue, stageGauntletHarness, HARNESS_FILES, CORE_DATA_FILES, DEFAULT_GATES, LOCAL_SKIPPED_GATES };

if (require.main === module) {
  // Capture the tip before the ~20 min run: the session may commit meanwhile, and that commit was not tested.
  const judgedHead = git('rev-parse', 'HEAD').stdout;
  const code = main();
  // BRO-5730: record the verdict so the land push hook can tell whether this tip was checked.
  if (!parseArgs(process.argv.slice(2)).help) require('./land-local-check-log.js').recordVerdict(ROOT, code, { head: judgedHead });
  require('./exit-flushed.js').exitFlushed(code); // BRO-7111: a plain exit truncated the ~1MB verdict above when piped
}
