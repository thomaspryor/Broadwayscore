#!/usr/bin/env node
'use strict';

/**
 * land-retry-cancelled.js — re-run Land jobs that were only queue casualties
 * of the shared `landing` slot (BRO-4246), spending an attempt only while the
 * slot is free (BRO-4653). Run by land-retry-cancelled.yml.
 *
 *   node scripts/land-retry-cancelled.js --sweep [--dry-run]
 *     Slot free → re-run at most ONE stranded cancelled Land run, oldest
 *     first. Slot busy → do nothing (the next Land completion sweeps again).
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
const { slotQueries, landingSlotBusy, decideSweep, MAX_AGE_HOURS } = require('./lib/land-queue-backoff');

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

// Status-filtered listings, stopping at the first in-flight run: a busy slot
// usually costs one call. Status filters (not a created-desc page) also see
// re-runs, which keep their original created_at.
function slotState(selfRunId) {
  for (const q of slotQueries(repo)) {
    const slot = landingSlotBusy(gh([q]).workflow_runs, { selfRunId });
    if (slot.busy) return slot;
  }
  return { busy: false, blockers: [] };
}

const describe = (blockers) => blockers.map((b) => `${b.id} ${b.branch} ${b.status}`).join(', ');

function rerun(id) {
  if (dry) { console.log(`dry-run: would re-run ${id}`); return; }
  process.stdout.write(ghRaw(['-X', 'POST', `repos/${repo}/actions/runs/${id}/rerun-failed-jobs`]));
  console.log(`re-run requested for ${id} (Land job only; Checks result kept)`);
}

function runTargeted() {
  const run = gh([`repos/${repo}/actions/runs/${runId}`]);
  const jobs = gh([`repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=50`]).jobs;
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
    console.log(`landing slot busy (${describe(slot.blockers)}): not re-running, no attempt spent; the next sweep picks it up`);
    return;
  }
  rerun(runId);
}

function runSweep() {
  const slot = slotState();
  if (slot.busy) {
    console.log(`landing slot busy (${describe(slot.blockers)}): waiting, no attempt spent`);
    return;
  }
  const since = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString();
  const landRuns = gh([`repos/${repo}/actions/workflows/land.yml/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=100`]).workflow_runs;
  // `heads/land` is a prefix match (a trailing slash is rejected by some
  // proxies), so keep only land/** refs.
  const refs = new Map(gh([`repos/${repo}/git/matching-refs/heads/land`])
    .filter((r) => r.ref.startsWith('refs/heads/land/'))
    .map((r) => [r.ref.replace(/^refs\/heads\//, ''), r.object.sha]));
  const d = decideSweep({ slot, landRuns, refs, now: Date.now() });
  if (d.action !== 'inspect') { console.log(`slot free, ${d.reason}`); return; }
  for (const run of d.candidates) {
    const jobs = gh([`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=50`]).jobs;
    const r = decideLandRetry({ run, jobs, branchExists: true, branchTip: refs.get(run.head_branch) });
    console.log(`run ${run.id} ${run.head_branch} attempt ${run.run_attempt}: ${r.retry ? 'RETRY' : 'skip'} (${r.reason})`);
    if (r.retry) { rerun(run.id); return; } // one per sweep: the next Land completion sweeps again
  }
}

if (sweep) runSweep(); else runTargeted();
