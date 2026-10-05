#!/usr/bin/env node
/**
 * wait-for-land.js — wait for a land/<name> ref to land or be refused (BRO-4671).
 *
 *   node scripts/lib/wait-for-land.js land/<name> [timeout-min]     (default 60)
 *
 * Why: CLOUD.md's landing step used to wait on `git ls-remote` alone. The ref
 * disappears when land.yml lands it, but it STAYS when the run is refused (red
 * Checks, rebase gate), so a ref-only loop noticed a refusal only at its ~60
 * min cap. That cost ~1h twice (BRO-4236 on 2026-09-28, BRO-4619 on
 * 2026-10-05). This checks the ref AND the latest push-triggered land.yml run
 * for it on every poll, one REST call per ~60-90s.
 *
 * Exit codes:
 *   0  landed (the ref is gone)
 *   1  refused (the land run for the ref's current tip completed red)
 *   2  timed out, still waiting
 *   3  usage error, 5 API/git failures in a row, or a ref that is gone
 *      without a landing (missing with no recent green run: a typo; or
 *      deleted after a red run)
 *
 * A cancelled run is an eviction from the shared landing slot, not a refusal:
 * land-retry-cancelled.yml re-runs it after the next Land completes, so this
 * keeps waiting. A run dispatched by hand (`land.yml` with branch=land/<name>)
 * is listed under head_branch=main and is invisible here; for those the ref
 * check still reports the landing, and a refusal surfaces only at the timeout.
 */

'use strict';

const { execFileSync } = require('child_process');
const { runGhWithFallback } = require('./land-retry-on-cancel');

const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const USAGE = 'usage: node scripts/lib/wait-for-land.js land/<name> [timeout-min]';
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

const RECENT_LANDING_MS = 6 * 3600_000;
const STALE_EVICTION_MS = 30 * 60_000;

/**
 * Decide what one poll means. refSha is the ref's current tip (null when the
 * ref is gone); lastSha the tip an earlier poll saw (null if none did); run
 * the latest push-triggered land.yml run for the ref, or null; nowMs the
 * clock. A run whose head_sha is not the current tip belongs to an older push
 * (the new push's run has not registered yet), so it says nothing about it.
 * "Gone" only counts as landed when nothing contradicts it: a ref deleted
 * after a red run was not landed, and a ref missing from the first poll needs
 * a recent green run (a typo'd or never-pushed name may share an old run).
 */
function landVerdict({ refSha, lastSha = null, run, nowMs }) {
  const ageMs = run && run.updated_at ? nowMs - Date.parse(run.updated_at) : Infinity;
  if (!refSha) {
    if (lastSha) {
      if (run && run.head_sha === lastSha && run.status === 'completed' && RED_CONCLUSIONS.has(run.conclusion)) {
        return { verdict: 'unknown', why: `ref deleted but its run ${run.id} was ${run.conclusion}: deleted by hand, not landed` };
      }
      return { verdict: 'landed' };
    }
    if (run && run.conclusion === 'success' && ageMs < RECENT_LANDING_MS) return { verdict: 'landed', before: true };
    return { verdict: 'unknown', why: 'not on origin and no recent green land run for it (typo, or the push never reached origin?)' };
  }
  if (!run) return { verdict: 'waiting', why: 'no push-triggered land run for this ref yet (a [skip ci] tip or a hand-dispatched run never shows here)' };
  if (run.head_sha !== refSha) {
    return { verdict: 'waiting', why: `latest run ${run.id} is for an older tip; the run for ${refSha.slice(0, 9)} has not registered yet` };
  }
  if (run.status !== 'completed') return { verdict: 'waiting', why: `run ${run.id} ${run.status}` };
  if (run.conclusion === 'cancelled') {
    const retry = `node scripts/land-retry-cancelled.js --run=${run.id}`;
    if (ageMs > STALE_EVICTION_MS) return { verdict: 'waiting', why: `run ${run.id} cancelled 30+ min ago and not re-run (retries spent?): ${retry}` };
    return { verdict: 'waiting', why: `run ${run.id} cancelled (evicted from the landing slot; the sweep re-runs it, or: ${retry})` };
  }
  if (RED_CONCLUSIONS.has(run.conclusion)) return { verdict: 'refused', why: `run ${run.id} ${run.conclusion}` };
  return { verdict: 'waiting', why: `run ${run.id} ${run.conclusion}, ref not deleted yet` };
}

function parseArgs(argv) {
  const [ref, timeoutArg = '60'] = argv;
  if (!ref || !/^land\/[\w./-]+$/.test(ref)) return null;
  if (!/^[1-9]\d*$/.test(timeoutArg)) return null;
  return { ref, timeoutMin: Number(timeoutArg) };
}

function readRefSha(ref) {
  const out = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${ref}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim().split(/\s+/)[0] || null;
}

function readLatestRun(ref) {
  const raw = runGhWithFallback(
    [`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(ref)}&event=push&per_page=1`],
    { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN },
  );
  const r = JSON.parse(raw).workflow_runs?.[0];
  return r ? { id: r.id, head_sha: r.head_sha, status: r.status, conclusion: r.conclusion, updated_at: r.updated_at, url: r.html_url } : null;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const stamp = () => new Date().toISOString().slice(11, 19) + 'Z';

async function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 3;
  }
  const deadline = Date.now() + args.timeoutMin * 60_000;
  let errors = 0;
  let lastLine = '';
  let lastSha = null;
  for (;;) {
    let v;
    let run = null;
    try {
      const refSha = readRefSha(args.ref);
      // Remember the tip before the API call: if that call fails and the ref
      // lands before the next good poll, it must still read as landed.
      if (refSha) lastSha = refSha;
      run = readLatestRun(args.ref);
      v = landVerdict({ refSha, lastSha, run, nowMs: Date.now() });
      errors = 0;
    } catch (err) {
      errors += 1;
      console.error(`${stamp()} poll failed (${errors}/5): ${String(err.message || err).split('\n')[0]}`);
      if (errors >= 5) return 3;
    }
    if (v) {
      if (v.verdict === 'landed') {
        const before = v.before ? ` before this wait started; its last land run ${run.id} ${run.conclusion}` : '';
        console.log(`${stamp()} LANDED: ${args.ref} is gone from origin${before} (land.yml deletes it after the fast-forward)`);
        return 0;
      }
      if (v.verdict === 'unknown') {
        console.error(`${stamp()} UNKNOWN: ${args.ref} ${v.why}`);
        return 3;
      }
      if (v.verdict === 'refused') {
        console.log(`${stamp()} REFUSED: ${args.ref} ${v.why}${run && run.url ? ` ${run.url}` : ''}`);
        return 1;
      }
      const line = `waiting: ${v.why}`;
      if (line !== lastLine) console.log(`${stamp()} ${line}`);
      lastLine = line;
    }
    if (Date.now() >= deadline) {
      console.log(`${stamp()} TIMEOUT after ${args.timeoutMin} min: ${args.ref} still on origin (${lastLine || 'no successful poll'})`);
      return 2;
    }
    await sleep(60_000 + Math.floor(Math.random() * 30_000));
  }
}

if (require.main === module) {
  // Exit 1 means "refused", so an unexpected crash must not reuse it.
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`wait-for-land crashed: ${err && err.stack ? err.stack : err}`);
      process.exit(3);
    },
  );
}

module.exports = { landVerdict, parseArgs, RED_CONCLUSIONS };
