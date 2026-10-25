#!/usr/bin/env node
/**
 * land-local-check.js — run the land gauntlet's test gates locally before pushing land/<name>
 * (BRO-5730). 65 of 77 refused land runs (10/16-10/19) failed in Checks on repo-wide guard
 * tests the branch tripped; the Codex runner, which runs these gates before landing, was
 * refused 3% of the time against 17% for Claude workers.
 *
 * It is the land.yml sequence, run on HEAD in this checkout with the same CLIs:
 *   1. land-gauntlet.sh on HEAD (GAUNTLET_GATES = the chosen gates)
 *   2. land-gate-delta.js --red-gates: which gates are red on HEAD
 *   3. land-gauntlet.sh --checkout <merge-base with origin/main> --return-to HEAD, those gates only
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
 *       changes, no common history with origin/main, or no local core data) | 4 skipped
 *       (mutex wait timed out)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./codex-runner.js');
const { GATES, ADVISORY_GATES } = require('./land-gate-delta.js');

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

class MutexTimeout extends Error {}

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

// The base run checks out an older tree, so the gauntlet runs from a copy outside it. That copy
// needs every sibling the gauntlet calls via $(dirname "${BASH_SOURCE[0]}")/... (BRO-6152: a lone
// copy lost tsc-node-options.sh). land.yml's "Stage the branch's gauntlet harness" step mirrors
// this list; land-local-check.test.mjs fails if either drifts from the gauntlet's references.
const HARNESS_FILES = ['land-gauntlet.sh', 'tsc-node-options.sh'];

/** Copy the harness from <fromRoot>/scripts/lib into <dir>; returns the gauntlet copy's path.
 * A helper missing from the source tree is skipped (the gauntlet has a fallback); the gauntlet is not. */
function stageGauntletHarness(fromRoot, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of HARNESS_FILES) {
    const src = path.join(fromRoot, 'scripts/lib', name);
    if (name === 'land-gauntlet.sh' || fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  return path.join(dir, 'land-gauntlet.sh');
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    const lines = fs.readFileSync(__filename, 'utf8').split('\n');
    console.log(lines.slice(1, lines.indexOf(' */') + 1).join('\n'));
    return 0;
  }
  if (opts.error) { console.error(`land-local-check: ${opts.error}`); return 2; }

  // The base run checks out origin/main in this tree and returns to HEAD: tracked changes would be lost.
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty.stdout) { console.error('land-local-check: commit or discard tracked changes first:\n' + dirty.stdout); return 3; }
  const missing = missingCoreData(ROOT);
  if (missing.length) {
    console.error(`land-local-check: ${missing.join(', ')} missing in this checkout (a worktree has no local data). `
      + 'Data-dependent tests would fail on both sides and report false new failures. '
      + 'Run ./scripts/setup-local-data.sh --link-only for core data. With data/cast/ available, generate the manifests with '
      + 'node scripts/build-actor-slugs-manifest.js && node scripts/build-cast-manifest.js.');
    return 3;
  }
  const fetch = git('fetch', '-q', 'origin', 'main');
  if (fetch.code !== 0) console.error(`land-local-check: git fetch failed, judging against the local origin/main (${fetch.stderr.split('\n').pop()})`);
  const head = git('rev-parse', 'HEAD').stdout;
  // land-gauntlet.sh returns to a detached sha; put a branch checkout back on its branch, or
  // fix commits made after an exit 1 would not advance it.
  const branch = git('symbolic-ref', '-q', '--short', 'HEAD').stdout;
  // Judge against the main commit HEAD sits on: main moves every few minutes, so demanding the
  // newest one would refuse nearly every run. Rebase conflicts are land-preflight.mjs's job.
  const base = git('merge-base', head, 'origin/main').stdout;
  if (!base) { console.error('land-local-check: HEAD shares no history with origin/main'); return 3; }
  const behind = Number(git('rev-list', '--count', `${head}..origin/main`).stdout) || 0;
  if (behind > 200) console.error(`land-local-check: HEAD is ${behind} commits behind origin/main; rebase for a closer match to what land.yml judges`);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), `land-local-check-${head.slice(0, 10)}-`));
  const branchDir = path.join(out, 'branch');
  const baseDir = path.join(out, 'base');
  const env = { ...process.env, GAUNTLET_PARALLEL: '1', LAND_BASE: base };
  const t0 = Date.now();
  let waited = false;
  try {
    return R.withFileMutex(R.CONTAINER_LAND_MUTEX, () => {
      if (waited) console.log(`land-local-check: got the land-check mutex after ${Math.round((Date.now() - t0) / 60_000)} min`);
      console.log(`land-local-check: gates ${opts.gates.join(',')} on HEAD ${head.slice(0, 10)} (base ${base.slice(0, 10)}, the merge-base with origin/main)`);
      const b = run('bash', ['scripts/lib/land-gauntlet.sh', branchDir], { env: { ...env, GAUNTLET_GATES: opts.gates.join(',') }, stdio: ['ignore', 'ignore', 'inherit'] });
      if (!fs.existsSync(path.join(branchDir, 'meta.json'))) { console.error(`land-local-check: the gauntlet wrote no result (exit ${b.code}); see ${branchDir}`); return 1; }
      const red = run('node', ['scripts/lib/land-gate-delta.js', '--red-gates', branchDir, '--gates', opts.gates.join(',')]).stdout;
      if (red) {
        // Same as land.yml: the gauntlet copy runs from outside the tree it checks out.
        const copy = stageGauntletHarness(ROOT, out);
        console.log(`land-local-check: red on HEAD: ${red}; running them on the base to tell new failures from old`);
        run('bash', [copy, baseDir, '--checkout', base, '--return-to', head], { env: { ...env, GAUNTLET_GATES: red }, stdio: ['ignore', 'ignore', 'inherit'] });
        if (git('rev-parse', 'HEAD').stdout !== head) console.error(`land-local-check: WARNING: HEAD is not back at ${head.slice(0, 10)}; run git checkout ${branch || head}`);
        else if (branch && git('checkout', '-q', branch).code !== 0) console.error(`land-local-check: WARNING: could not return to branch ${branch}; run git checkout ${branch}`);
      }
      const d = run('node', ['scripts/lib/land-gate-delta.js', '--base-dir', baseDir, '--branch-dir', branchDir, '--gates', opts.gates.join(','), '--base-source', red ? `ran locally for ${red}` : 'not needed (every gate green on HEAD)'], { stdio: ['ignore', 'pipe', 'inherit'] });
      console.log(d.stdout);
      let clean = d.code === 0;
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

module.exports = { main, parseArgs, newFailureFiles, missingCoreData, stageGauntletHarness, HARNESS_FILES, CORE_DATA_FILES, DEFAULT_GATES, LOCAL_SKIPPED_GATES };

if (require.main === module) process.exit(main());
