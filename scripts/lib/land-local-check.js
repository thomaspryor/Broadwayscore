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
 *   --gates  comma list (default: unit-tests-node,scripts-lib-tests,lint-workflows, the gates
 *            behind the refusals and the ones the Codex runner checks)
 *   --all    every gauntlet gate (land-gate-delta.js GATES)
 *   --max-wait-minutes  give up waiting for the mutex after N min (default 40): exit 4 with a
 *            warning, so a worker is never stranded behind another check
 * Exit: 0 no new failures | 1 new failures (printed) | 2 usage | 3 not ready (tracked
 *       changes, or no common history with origin/main) | 4 skipped (mutex wait timed out)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./codex-runner.js');
const { GATES } = require('./land-gate-delta.js');

const DEFAULT_GATES = ['unit-tests-node', 'scripts-lib-tests', 'lint-workflows'];
const ROOT = path.resolve(__dirname, '..', '..');

/** -> { gates, maxWaitMs } or { error } */
function parseArgs(argv) {
  let gates = DEFAULT_GATES;
  let maxWaitMs = 40 * 60_000;
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

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 28).join('\n')); return 0; }
  if (opts.error) { console.error(`land-local-check: ${opts.error}`); return 2; }

  // The base run checks out origin/main in this tree and returns to HEAD: tracked changes would be lost.
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty.stdout) { console.error('land-local-check: commit or discard tracked changes first:\n' + dirty.stdout); return 3; }
  const fetch = git('fetch', '-q', 'origin', 'main');
  if (fetch.code !== 0) console.error(`land-local-check: git fetch failed, judging against the local origin/main (${fetch.stderr.split('\n').pop()})`);
  const head = git('rev-parse', 'HEAD').stdout;
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
        const copy = path.join(out, 'land-gauntlet.sh');
        fs.copyFileSync(path.join(ROOT, 'scripts/lib/land-gauntlet.sh'), copy);
        console.log(`land-local-check: red on HEAD: ${red}; running them on the base to tell new failures from old`);
        run('bash', [copy, baseDir, '--checkout', base, '--return-to', head], { env: { ...env, GAUNTLET_GATES: red }, stdio: ['ignore', 'ignore', 'inherit'] });
        if (git('rev-parse', 'HEAD').stdout !== head) console.error(`land-local-check: WARNING: HEAD is not back at ${head.slice(0, 10)}; run git checkout ${head}`);
      }
      const d = run('node', ['scripts/lib/land-gate-delta.js', '--base-dir', baseDir, '--branch-dir', branchDir, '--gates', opts.gates.join(','), '--base-source', red ? `ran locally for ${red}` : 'not needed (every gate green on HEAD)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      console.log(`land-local-check: ${d.code === 0 ? 'CLEAN, no new failures' : 'NEW FAILURES, fix them before pushing land/'} (${Math.round((Date.now() - t0) / 60_000)} min; logs in ${out})`);
      return d.code === 0 ? 0 : 1;
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

module.exports = { parseArgs, DEFAULT_GATES };

if (require.main === module) process.exit(main());
