#!/usr/bin/env node
/**
 * land-shard.js: the two-runner split of land.yml's Checks (BRO-7324 step C).
 *
 * Runner A is the `checks` job ("Checks"); runner B is the `checks-shard` job
 * ("Checks (shard 2/2)"). Both rebase onto the base sha dispatch-guard pinned
 * and run land-gauntlet.sh on the same tree: every gate whole on exactly one
 * part, and the node unit batch split with GAUNTLET_SHARD=k/2. B uploads its
 * out-dir as an artifact. Right after its own part, A collects B's part, merges
 * it with land-gauntlet-merge.js, and only then decides which gates need a base
 * result. Kill switch: repo variable LAND_NODE_SHARD_DISABLED=1 (dispatch-guard
 * reads it once; B is skipped and A runs every gate unsplit, as before).
 *
 * Fail closed, and never idle on a runner that is not coming: when B's part is
 * not there (B queued, missing from this attempt, finished without uploading,
 * past the wait deadline, or the API is down), A runs part 2 itself with the
 * same harness. So every gate always runs on some runner; a lost part costs
 * time, never a gate. A merge refusal or a failed local run exits 1, which the
 * Gate verdict reports as the `node-shard` gate. A merged dir missing a gate
 * is refused later by land-gate-delta.js (shard-incomplete).
 *
 * B runs its gauntlet under `watch`, which stops it once A's job has completed
 * (A failed fast, or finished part 2 itself), so a fast refusal stays fast.
 *
 * CLI:
 *   land-shard.js gates <1|2>
 *   land-shard.js collect --repo=o/r --run-id=N --attempt=N --out=DIR --merge-into=DIR
 *                         --harness=PATH [--data-rev=SHA] [--wait-min=12] [--interval-s=20]
 *     (--data-rev: this runner's core-data commit; a fetched part with another, or none, is not merged)
 *   land-shard.js watch --repo=o/r --run-id=N --attempt=N --stopped-marker=FILE -- <cmd> [args...]
 *   land-shard.js checks-done --repo=o/r --run-id=N --attempt=N
 *
 * $GITHUB_OUTPUT (when set):
 *   collect      source=artifact|local and node_shard=artifact|local, written only
 *                after a successful merge (never on a failure path).
 *   checks-done  done=true when the job named exactly "Checks" in this attempt has
 *                completed, else done=false (also on any API error: B then just runs).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CHECKS_JOB_NAME = 'Checks';
const SHARD_JOB_NAME = 'Checks (shard 2/2)';
// From land-timing-report.js --gates (5 full branch gauntlets, 2026-11-21):
// unit-tests-node 924s, scripts-lib-tests 333s, bash-integration 327s and
// lint-workflows 302s (A's background lane under GAUNTLET_PARALLEL), tsx 63s,
// tsc 57s, the rest under 20s. A: ~460s node half + ~150s small gates, with a
// ~630s background lane beside them, after a ~3 min fast-fail. B: ~460s node
// half + 333s scripts-lib, no fast-fail. Both reach the merge close together.
const SHARD_PARTS = {
  1: ['tsc', 'tsc-llm-scoring', 'next-lint', 'unit-tests-node', 'unit-tests-tsx', 'unit-tests-e2e', 'bash-integration', 'toplevel-regression', 'lint-workflows'],
  2: ['unit-tests-node', 'scripts-lib-tests'],
};

/** Name of B's artifact for one run attempt (land.yml's upload step uses the same shape). */
function shardArtifactName(runId, attempt) { return `land-node-shard-${runId}-${attempt}`; }

/**
 * Pure. One poll of A's collect step.
 * job: B's job in this attempt from the jobs API (undefined when not listed);
 * artifactId: B's artifact id when listed; recheck: the previous poll saw B
 * completed without an artifact (listing lag gets one more look).
 * -> { action: 'fetch'|'wait'|'recheck'|'local', reason }
 */
function decideShardPoll({ job, artifactId, elapsedMs, waitMs, recheck = false }) {
  if (artifactId) return { action: 'fetch', reason: `artifact ${artifactId} listed` };
  if (!job) return { action: 'local', reason: `no "${SHARD_JOB_NAME}" job in this run attempt (kill switch flipped mid-run, or only failed jobs were re-run)` };
  if (job.status === 'completed') {
    if (!recheck) return { action: 'recheck', reason: `shard job completed (${job.conclusion}); listing the artifacts once more` };
    return { action: 'local', reason: `shard job finished (${job.conclusion || 'no conclusion'}) without uploading its part` };
  }
  if (job.status !== 'in_progress') return { action: 'local', reason: `shard job has not started (${job.status}); not waiting for a runner` };
  if (elapsedMs >= waitMs) return { action: 'local', reason: `shard job still running after ${Math.round(waitMs / 60000)} min` };
  return { action: 'wait', reason: 'shard job running' };
}

/**
 * Pure. Is the fetched part 2/2 really B's half of THIS split? metaA is A's
 * part 1 (the merge-into dir), metaB the artifact's meta.json. A part that is
 * unfinished, another part, or another tree is not merged: A runs part 2 itself.
 * -> { ok, reason }
 */
function validateFetchedPart(metaA, metaB) {
  if (!metaB || typeof metaB !== 'object') return { ok: false, reason: 'meta.json unreadable' };
  if (metaB.partial) return { ok: false, reason: 'the part never finished (partial)' };
  if (metaB.shard !== '2/2') return { ok: false, reason: `shard is ${JSON.stringify(metaB.shard)}, not "2/2"` };
  if (!metaA || typeof metaA !== 'object') return { ok: false, reason: 'this runner\'s part 1 meta.json is unreadable' };
  for (const k of ['root', 'tree']) {
    if (!metaA[k] || metaA[k] !== metaB[k]) return { ok: false, reason: `${k} differs (${metaA[k]} here vs ${metaB[k]} in the artifact)` };
  }
  return { ok: true, reason: 'part 2/2 of the same tree' };
}

/** B writes the private core-data commit it tested against here, next to meta.json. */
const DATA_REV_FILE = 'data-rev.txt';
const REV_RE = /^[0-9a-f]{40}$/;
/**
 * Pure. Did both parts read the SAME private core data? Each runner clones the
 * data repo's main at its own time, and the tree check covers tracked files
 * only. Missing or malformed on either side counts as different (fail closed).
 * -> { ok, reason }
 */
function validateDataRev(revA, revB) {
  const a = String(revA || '').trim(); const b = String(revB || '').trim();
  if (!REV_RE.test(a)) return { ok: false, reason: `this runner's core-data revision is missing (${JSON.stringify(a)})` };
  if (!REV_RE.test(b)) return { ok: false, reason: `the artifact's core-data revision is missing (${JSON.stringify(b)})` };
  if (a !== b) return { ok: false, reason: `core data differs (${a.slice(0, 10)} here vs ${b.slice(0, 10)} in the artifact)` };
  return { ok: true, reason: 'same core-data revision' };
}

/** Pure. B's first step: is A's "Checks" job already over? Exact name only. */
function decideChecksDone({ jobs }) {
  const j = lastNamed(Array.isArray(jobs) ? jobs : [], CHECKS_JOB_NAME);
  return Boolean(j && j.status === 'completed');
}

/** Pure. One poll of B's watcher: stop once A's job is over. */
function decidePeerWatch({ peerJob }) {
  if (peerJob && peerJob.status === 'completed') return { action: 'stop', reason: `"${CHECKS_JOB_NAME}" already completed (${peerJob.conclusion}); its result no longer needs this part` };
  return { action: 'continue' };
}

function parseArgs(argv) {
  const o = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { rest.push(...argv.slice(i + 1)); break; }
    const m = /^--([a-z0-9-]+)=(.*)$/.exec(argv[i]); if (m) o[m[1]] = m[2];
  }
  o._ = rest;
  return o;
}

function gh(args, exec, extra = {}) {
  const { runGhWithFallback } = require('./land-retry-on-cancel.js');
  return runGhWithFallback(args, { exec, fallbackToken: process.env.GH_FALLBACK_TOKEN, ...extra });
}
// A hung gh would block watch's event loop (and with it the child's exit), or
// eat the whole Checks job in collect, so every network call is bounded:
// listings 60s, the artifact zip 180s (unzip, local, 60s). In collect each
// bound is also clipped to the --wait-min deadline (never below MIN_CALL_MS),
// and a timed-out call there runs part 2 locally at once instead of retrying.
const GH_TIMEOUT_MS = 60000;
const GH_DOWNLOAD_TIMEOUT_MS = 180000;
const UNZIP_TIMEOUT_MS = 60000;
const MIN_CALL_MS = 30000;
const bounded = (exec, ms) => (cmd, args, opts) => exec(cmd, args, { ...opts, timeout: ms });
// execFileSync's own timeout kill: code ETIMEDOUT (signal SIGTERM).
function isTimeout(err) { return Boolean(err && err.code === 'ETIMEDOUT'); }
function jobsOfAttempt(o, exec, timeoutMs = GH_TIMEOUT_MS) {
  return JSON.parse(gh([`repos/${o.repo}/actions/runs/${o['run-id']}/attempts/${o.attempt}/jobs?per_page=100`], bounded(exec, timeoutMs))).jobs || [];
}
function lastNamed(jobs, name) { return jobs.filter((j) => j && j.name === name).pop(); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function appendOutput(line) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`); }

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function firstLine(err) { return String((err && err.message) || err).split('\n')[0]; }

/** Run part 2 on this runner (A), into a fresh dir. Exit code of the gauntlet. */
function runLocal(o, { spawn, log }) {
  fs.rmSync(o.out, { recursive: true, force: true });
  log(`node-shard: running part 2/2 (${SHARD_PARTS[2].join(', ')}) on this runner`);
  const r = spawn('bash', [o.harness, o.out], {
    stdio: 'inherit',
    env: { ...process.env, GAUNTLET_GATES: SHARD_PARTS[2].join(','), GAUNTLET_SHARD: '2/2', GAUNTLET_PARALLEL: '0', GAUNTLET_SCOPE_DIR: '' },
  });
  return r.status === null ? 1 : r.status;
}

function fetchPart(o, artifactId, name, { exec, timeoutMs = GH_DOWNLOAD_TIMEOUT_MS }) {
  fs.rmSync(o.out, { recursive: true, force: true }); fs.mkdirSync(o.out, { recursive: true });
  const zip = `${o.out.replace(/\/+$/, '')}.zip`;
  // gh writes the zip to stdout; latin1 keeps every byte.
  const bin = gh([`repos/${o.repo}/actions/artifacts/${artifactId}/zip`], (cmd, args, opts) => exec(cmd, args, { ...opts, encoding: 'latin1', timeout: timeoutMs }));
  fs.writeFileSync(zip, Buffer.from(bin, 'latin1'));
  exec('unzip', ['-oq', zip, '-d', o.out], { stdio: ['ignore', 'inherit', 'inherit'], timeout: UNZIP_TIMEOUT_MS });
  if (!fs.existsSync(path.join(o.out, 'meta.json'))) throw new Error(`artifact ${name} has no meta.json`);
}

function collect(o, { exec = require('child_process').execFileSync, spawn = require('child_process').spawnSync, now = Date.now, sleep = sleepMs, log = console.log } = {}) {
  const fail = (msg) => { console.error(`::error::node-shard: ${msg}`); return 1; };
  for (const k of ['repo', 'run-id', 'attempt', 'out', 'merge-into', 'harness']) if (!o[k]) return fail(`collect needs --${k}`);
  const name = shardArtifactName(o['run-id'], o.attempt);
  const waitMs = Number(o['wait-min'] || 12) * 60000;
  const intervalMs = Number(o['interval-s'] || 20) * 1000;
  const t0 = now();
  // --wait-min is a deadline for the whole collect wait, network calls included.
  const deadline = t0 + waitMs;
  const callMs = (cap) => Math.min(cap, Math.max(deadline - now(), MIN_CALL_MS));
  let recheck = false; let apiErrors = 0; let source = null;
  for (;;) {
    if (now() >= deadline) { log(`node-shard: local, no part 2/2 within the ${Math.round(waitMs / 60000)} min wait`); source = 'local'; break; }
    let job; let artifactId = null;
    try {
      job = lastNamed(jobsOfAttempt(o, exec, callMs(GH_TIMEOUT_MS)), SHARD_JOB_NAME);
      const arts = JSON.parse(gh([`repos/${o.repo}/actions/runs/${o['run-id']}/artifacts?name=${encodeURIComponent(name)}&per_page=10`], bounded(exec, callMs(GH_TIMEOUT_MS)))).artifacts || [];
      const a = arts.find((x) => x.name === name && !x.expired);
      artifactId = a ? a.id : null;
      apiErrors = 0;
    } catch (err) {
      if (isTimeout(err)) { log(`node-shard: local, a GitHub API call timed out: ${firstLine(err)}`); source = 'local'; break; }
      apiErrors++;
      log(`node-shard: API error ${apiErrors}/3: ${firstLine(err)}`);
      if (apiErrors >= 3) { log('node-shard: local, the GitHub API failed 3 times in a row'); source = 'local'; break; }
      sleep(Math.min(intervalMs, Math.max(0, deadline - now()))); continue;
    }
    const d = decideShardPoll({ job, artifactId, elapsedMs: now() - t0, waitMs, recheck });
    log(`node-shard: ${d.action}, ${d.reason}`);
    if (d.action === 'fetch') {
      try { fetchPart(o, artifactId, name, { exec, timeoutMs: callMs(GH_DOWNLOAD_TIMEOUT_MS) }); source = 'artifact'; } catch (err) { log(`node-shard: could not download or unpack ${name}: ${firstLine(err)}; running part 2 here`); source = 'local'; }
      if (source === 'artifact') {
        const v = validateFetchedPart(readJson(path.join(o['merge-into'], 'meta.json')), readJson(path.join(o.out, 'meta.json')));
        if (!v.ok) { log(`node-shard: not merging ${name}: ${v.reason}; running part 2 here`); source = 'local'; }
      }
      if (source === 'artifact') {
        let revB = null; try { revB = fs.readFileSync(path.join(o.out, DATA_REV_FILE), 'utf8'); } catch { revB = null; }
        const v = validateDataRev(o['data-rev'], revB);
        if (!v.ok) { log(`node-shard: not merging ${name}: ${v.reason}; running part 2 here`); source = 'local'; }
      }
      break;
    }
    if (d.action === 'local') { source = 'local'; break; }
    recheck = d.action === 'recheck';
    sleep(Math.min(recheck ? Math.min(intervalMs, 10000) : intervalMs, Math.max(0, deadline - now())));
  }
  if (source === 'local') {
    const rc = runLocal(o, { spawn, log });
    if (rc !== 0) return fail(`part 2/2 on this runner exited ${rc}`);
  }
  const { mergeGauntletDirs } = require('./land-gauntlet-merge.js');
  const r = mergeGauntletDirs(o['merge-into'], o.out);
  if (!r.ok) { for (const p of r.problems) console.error(`::error::split merge refused: ${p}`); return 1; }
  log(`node-shard: merged part 2/2 (${source}) into ${o['merge-into']}: ${r.gates.length} gate(s)`);
  appendOutput(`source=${source}`);
  appendOutput(`node_shard=${source}`);
  return 0;
}

/** B: run <cmd> and stop it once A's job has completed. Exit code of <cmd>, or 0 when stopped. */
function watch(o, { exec = require('child_process').execFileSync, spawnAsync = require('child_process').spawn, log = console.log, intervalMs = 30000 } = {}) {
  for (const k of ['repo', 'run-id', 'attempt', 'stopped-marker']) if (!o[k]) { console.error(`::error::watch needs --${k}`); return Promise.resolve(2); }
  if (!o._.length) { console.error('::error::watch needs -- <cmd>'); return Promise.resolve(2); }
  fs.rmSync(o['stopped-marker'], { force: true });
  return new Promise((resolve) => {
    const child = spawnAsync(o._[0], o._.slice(1), { stdio: 'inherit', detached: true });
    let stopped = false;
    const timer = setInterval(() => {
      let peerJob;
      try { peerJob = lastNamed(jobsOfAttempt(o, exec), CHECKS_JOB_NAME); } catch (err) { log(`node-shard watch: API error (keeps running): ${firstLine(err)}`); return; }
      const d = decidePeerWatch({ peerJob });
      if (d.action !== 'stop' || stopped) return;
      stopped = true;
      log(`node-shard watch: stopping, ${d.reason}`);
      fs.writeFileSync(o['stopped-marker'], `${d.reason}\n`);
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000).unref();
    }, intervalMs);
    child.on('exit', (code) => {
      clearInterval(timer);
      resolve(stopped ? 0 : (code === null ? 1 : code));
    });
  });
}

/** B's first step: done=true|false on $GITHUB_OUTPUT. Never blocks B on an API error. */
function checksDone(o, { exec = require('child_process').execFileSync, log = console.log } = {}) {
  for (const k of ['repo', 'run-id', 'attempt']) if (!o[k]) { console.error(`::error::checks-done needs --${k}`); appendOutput('done=false'); return 2; }
  let done = false;
  try { done = decideChecksDone({ jobs: jobsOfAttempt(o, exec) }); } catch (err) { log(`node-shard checks-done: API error, running anyway: ${firstLine(err)}`); }
  log(`node-shard checks-done: "${CHECKS_JOB_NAME}" ${done ? 'already completed' : 'not completed'}`);
  appendOutput(`done=${done}`);
  return 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'gates') {
    const part = SHARD_PARTS[rest[0]];
    if (!part) { console.error(`usage: land-shard.js gates <${Object.keys(SHARD_PARTS).join('|')}>`); return 2; }
    console.log(part.join(','));
    return 0;
  }
  if (cmd === 'collect') return collect(parseArgs(rest));
  if (cmd === 'watch') return watch(parseArgs(rest));
  if (cmd === 'checks-done') return checksDone(parseArgs(rest));
  console.error('usage: land-shard.js gates <k> | collect ... | watch ... -- <cmd> | checks-done ...');
  return 2;
}

module.exports = { GH_TIMEOUT_MS, GH_DOWNLOAD_TIMEOUT_MS, MIN_CALL_MS, CHECKS_JOB_NAME, SHARD_JOB_NAME, SHARD_PARTS, DATA_REV_FILE, shardArtifactName, decideShardPoll, decidePeerWatch, validateFetchedPart, validateDataRev, decideChecksDone, collect, watch, checksDone, parseArgs };

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
