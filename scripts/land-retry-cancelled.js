#!/usr/bin/env node
'use strict';

/**
 * land-retry-cancelled.js — re-run Land jobs that were only queue casualties
 * of the shared `landing` slot (BRO-4246), spending an attempt only while the
 * slot is free (BRO-4653) or held by one running job with nobody pending
 * (BRO-4677). Run by land-retry-cancelled.yml.
 *
 *   node scripts/land-retry-cancelled.js --sweep [--dry-run]
 *     Slot free, or held by a running job with the pending seat empty →
 *     re-run at most ONE stranded cancelled Land run, oldest first. Pending
 *     seat taken → wait, except a run stranded >30 min is
 *     re-run anyway (BRO-4676 aging; still one re-run per sweep).
 *   node scripts/land-retry-cancelled.js --run=<id> [--dry-run]
 *     Targeted retry of one run, same slot rule.
 *
 * Decisions: scripts/lib/land-retry-on-cancel.js (is this run a queue
 * casualty?) and scripts/lib/land-queue-backoff.js (is the slot free, which
 * run goes next?).
 */

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { decideLandRetry, runGhWithFallback, isRefNotFound } = require('./lib/land-retry-on-cancel');
const {
  slotQueries, inFlightBlocker, slotHolderKind, orderForSlotCheck, supersededByNewerRun, decideSweep, MAX_AGE_HOURS, MAX_JOB_LOOKUPS,
} = require('./lib/land-queue-backoff');

const USAGE = 'usage: node scripts/land-retry-cancelled.js --sweep | --run=<id> [--dry-run]';
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(USAGE);
  process.exit(0);
}

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const runId = arg('run');
const sweep = process.argv.includes('--sweep');
const dry = process.argv.includes('--dry-run');
if (sweep === Boolean(runId) || (runId && !/^\d+$/.test(runId))) { console.error(USAGE); process.exit(2); }

const ghRaw = (args) => runGhWithFallback(args, { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN });
const gh = (args) => JSON.parse(ghRaw(args));
const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

const jobsOf = (id) => gh([`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=50`]).jobs;
const blocker = (r, why) => ({ busy: true, blockers: [{ id: r.id, branch: r.head_branch, status: r.status, why }] });

// Status-filtered listings (not a created-desc page: re-runs keep their
// original created_at), all gathered first, then checked likeliest holder
// first. A land.yml run costs one jobs lookup to tell "in Checks" (clear) from
// "Land job running or pending" (busy). Anything unknown reads as busy.
function slotState(selfRunId) {
  const byId = new Map();
  for (const q of slotQueries(repo)) {
    const page = gh([q]);
    const runs = page.workflow_runs || [];
    for (const run of runs) byId.set(run.id, run);
    if ((page.total_count || 0) > runs.length) return { busy: true, rerunInFlight: true, blockers: [{ id: '-', branch: q, status: 'unlisted', why: 'too-many-in-flight' }] };
  }
  // BRO-4676: a land.yml re-run still in flight (pending or running) must finish
  // before another aged re-run is allowed to compete for the slot.
  const rerunInFlight = [...byId.values()].some((r) => /(^|\/)land\.yml$/.test(r.path || '') && (r.run_attempt || 1) > 1 && r.status !== 'completed');
  const withFlag = (s) => ({ ...s, rerunInFlight });
  // BRO-4677: scan every in-flight run (stop early only at a PENDING entrant, or
  // when anything is unreadable) so the verdict says whether the pending seat is
  // empty. `pending: false` is set only after the full scan.
  let lookups = 0;
  let running = null;
  for (const run of orderForSlotCheck([...byId.values()])) {
    let jobs;
    let v = inFlightBlocker(run, { selfRunId });
    if (v === 'needs-jobs') {
      if (lookups >= MAX_JOB_LOOKUPS) return withFlag({ ...blocker(run, 'lookup-cap'), pending: true });
      lookups += 1;
      jobs = jobsOf(run.id);
      v = inFlightBlocker(run, { selfRunId, jobs });
    }
    if (v === 'busy') {
      if (slotHolderKind(run, jobs) === 'pending') return withFlag({ ...blocker(run, 'holds-slot'), pending: true });
      running = running || blocker(run, 'running');
    }
    if (v === 'stale') console.log(`ignoring stale in-flight run ${run.id} ${run.head_branch} (${run.status} since ${run.run_started_at || run.created_at})`);
  }
  if (running) return withFlag({ ...running, pending: false });
  return { busy: false, blockers: [] };
}

const describe = (blockers) => blockers.map((b) => `${b.id} ${b.branch} ${b.status} ${b.why}`).join(', ');

function rerun(id) {
  if (dry) { console.log(`dry-run: would re-run ${id}`); return; }
  process.stdout.write(ghRaw(['-X', 'POST', `repos/${repo}/actions/runs/${id}/rerun-failed-jobs`]));
  console.log(`re-run requested for ${id} (Land job only; Checks result kept)`);
  settle(id);
}

// BRO-4677: the run can read `completed` for a few seconds after the POST. The
// next sweep starts the moment this one exits, and would not see the re-run in
// flight (rerunInFlight), re-running the next stranded run onto the same seat.
function settle(id, tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    if (gh([`repos/${repo}/actions/runs/${id}`]).status !== 'completed') return;
    execFileSync('sleep', ['5']);
  }
  console.log(`run ${id} still reads completed after ${tries * 5}s; continuing`);
}

function runTargeted() {
  const run = gh([`repos/${repo}/actions/runs/${runId}`]);
  const jobs = jobsOf(runId);
  let branchExists = false;
  let branchTip;
  try {
    branchTip = gh([`repos/${repo}/git/ref/heads/${run.head_branch}`]).object.sha;
    branchExists = true;
  } catch (err) {
    if (!isRefNotFound(err)) throw err; // only a 404 means landed/deleted
  }
  const d = decideLandRetry({ run, jobs, branchExists, branchTip });
  console.log(`run ${runId} ${run.head_branch} attempt ${run.run_attempt}: ${d.retry ? 'eligible' : 'skip'} (${d.reason})`);
  if (!d.retry) return;
  const slot = slotState(runId);
  if (slot.busy) {
    // Targeted retries keep the strict free-slot rule; only the sweep uses the
    // BRO-4677 running-only exception.
    console.log(`landing slot busy (${describe(slot.blockers)}): not re-running, no attempt spent; the next sweep picks it up`);
    return;
  }
  rerun(runId);
}

function runSweep() {
  const slot = slotState();
  // Cancelled runs only (status filter): the last 24h held ~150 Land runs, so
  // an unfiltered page would drop the oldest stranded ones first.
  const since = encodeURIComponent(`>=${new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString()}`);
  const cancelledRuns = [];
  for (let p = 1; p <= 3; p += 1) {
    const runs = gh([`repos/${repo}/actions/workflows/land.yml/runs?status=cancelled&created=${since}&per_page=100&page=${p}`]).workflow_runs || [];
    cancelledRuns.push(...runs);
    if (runs.length < 100) break;
  }
  // `heads/land` is a prefix match (a trailing slash is rejected by some
  // proxies), so keep only land/** refs.
  const refs = new Map(gh([`repos/${repo}/git/matching-refs/heads/land`])
    .filter((r) => r.ref.startsWith('refs/heads/land/'))
    .map((r) => [r.ref.replace(/^refs\/heads\//, ''), r.object.sha]));
  const d = decideSweep({ slot, cancelledRuns, refs, now: Date.now() });
  if (d.action === 'wait') { console.log(`landing slot busy (${describe(d.blockers)}): waiting, no attempt spent`); return; }
  if (d.action !== 'inspect') { console.log(`slot free, ${d.reason}`); return; }
  if (d.reason === 'no-pending-slot-busy') console.log(`landing slot held (${describe(d.blockers)}) but the pending seat is empty: re-running the oldest eligible stranded run (BRO-4677)`);
  if (d.aged) console.log(`landing slot busy (${describe(d.blockers)}) but ${d.candidates.length} run(s) stranded past the aging threshold: re-running the oldest eligible (BRO-4676)`);
  for (const run of d.candidates) {
    const latest = (gh([`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(run.head_branch)}&per_page=1`]).workflow_runs || [])[0];
    if (supersededByNewerRun(run, latest)) {
      console.log(`run ${run.id} ${run.head_branch}: skip (newer run ${latest.id} ${latest.conclusion || latest.status})`);
      continue;
    }
    // Decide on the fresh run, not the listing: a listed run may already have
    // been re-run since (status back to queued/pending, conclusion null → skip).
    const fresh = latest || run;
    const r = decideLandRetry({ run: fresh, jobs: jobsOf(run.id), branchExists: true, branchTip: refs.get(run.head_branch) });
    console.log(`run ${run.id} ${run.head_branch} attempt ${fresh.run_attempt}: ${r.retry ? 'RETRY' : 'skip'} (${r.reason})`);
    if (r.retry) { rerun(run.id); return; } // one per sweep: the next Land completion sweeps again
  }
}

if (sweep) runSweep(); else runTargeted();
