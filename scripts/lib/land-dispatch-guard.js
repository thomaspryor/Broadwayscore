'use strict';

/**
 * land-dispatch-guard.js — refuse a hand dispatch of land.yml while a push
 * run for the same land/** branch is live (BRO-6276).
 *
 * A workflow_dispatch run used to share the push run's `land-checks-<branch>`
 * group (cancel-in-progress) and its `landing-<branch>` group, where GitHub
 * keeps one pending run: a dispatch could cancel the push run's Checks or
 * evict its pending Land job. The Checks group now carries event_name; this
 * guard closes the Land-group half by stopping the dispatch before Checks.
 *
 * Live means: a push run for the branch not yet completed (started within
 * LIVE_MAX_HOURS, so a run GitHub left stuck in `queued` stops blocking), or a
 * cancelled push run the sweep will resume (decideLandRetry says retry: Admit
 * parked it, or it was evicted while queued). The fix for that run is the
 * sweep's own path, `node scripts/land-retry-cancelled.js --run=<id>`. A
 * cancelled run the sweep will NOT resume (Checks cancelled, Land cancelled
 * mid-flight, attempts spent) does not block: a dispatch is then the way out.
 *
 * Check-then-act: a push landing between this read and Checks starting is not
 * seen. The Checks group split keeps that case from cancelling anything.
 */

const { decideLandRetry } = require('./land-retry-on-cancel');

const BRANCH_RE = /^land\/[\w./-]+$/;
const RUNS_PER_PAGE = 100;
const LIVE_MAX_HOURS = 8;

// Cancelled push runs at the current tip, newest first: the ones whose jobs
// main() reads so decideDispatchGuard can ask decideLandRetry about them.
function cancelledAtTip(runs, tipSha) {
  return tipSha ? (runs || []).filter((r) => r.conclusion === 'cancelled' && r.head_sha === tipSha) : [];
}

function decideDispatchGuard({ branch, tipSha, runs, jobsByRun = {}, disabled = false, now = Date.now() }) {
  if (disabled) return { allow: true, reason: 'disabled' };
  if (!BRANCH_RE.test(branch || '')) return { allow: false, reason: 'bad-branch' };
  if (!tipSha) return { allow: false, reason: 'branch-gone' };
  const started = (r) => Date.parse(r.run_started_at || r.created_at || '');
  const live = (runs || []).find((r) => r.status !== 'completed' &&
    !(now - started(r) > LIVE_MAX_HOURS * 3600000));
  if (live) return { allow: false, reason: 'push-run-live', runId: live.id };
  const resumable = cancelledAtTip(runs, tipSha).find((run) =>
    decideLandRetry({ run, jobs: jobsByRun[run.id], branchExists: true, branchTip: tipSha }).retry);
  if (resumable) return { allow: false, reason: 'push-run-parked', runId: resumable.id };
  return { allow: true, reason: 'no-live-push-run' };
}

function refusalMessage(decision, branch) {
  if (decision.reason === 'bad-branch') return `branch input must be land/<name>, got "${branch}"`;
  if (decision.reason === 'branch-gone') return `${branch} does not exist on origin (already landed, or never pushed)`;
  const head = (state) => `a push run for ${branch} is ${state} (run ${decision.runId}); a dispatch would compete with it. `;
  if (decision.reason === 'push-run-parked') {
    return head('parked in the landing line') + `Wait for the sweep, or resume it with: node scripts/land-retry-cancelled.js --run=${decision.runId}`;
  }
  return head('live') + 'Wait for it to finish.';
}

function main() {
  const { execFileSync } = require('child_process');
  const { runGhWithFallback, isRefNotFound } = require('./land-retry-on-cancel');
  const branch = process.env.BRANCH || '';
  const repo = process.env.REPO;
  const disabled = process.env.LAND_DISPATCH_GUARD_DISABLED === 'true';
  const gh = (endpoint) => JSON.parse(runGhWithFallback([endpoint],
    { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN }));
  let decision;
  try {
    let tipSha = null;
    let runs = [];
    const jobsByRun = {};
    if (!disabled && BRANCH_RE.test(branch)) {
      try {
        tipSha = gh(`repos/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`).object?.sha || null;
      } catch (err) {
        if (!isRefNotFound(err)) throw err;
      }
      if (tipSha) {
        runs = gh(`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=${RUNS_PER_PAGE}`).workflow_runs || [];
        for (const run of cancelledAtTip(runs, tipSha)) {
          jobsByRun[run.id] = gh(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=50`).jobs || [];
        }
      }
    }
    decision = decideDispatchGuard({ branch, tipSha, runs, jobsByRun, disabled });
  } catch (err) {
    // Fail closed: an unreadable API must not let a dispatch through blind.
    console.log(`::error::dispatch guard could not read run state (${String(err.message).split('\n')[0]}); ` +
      'set repo variable LAND_DISPATCH_GUARD_DISABLED=true to bypass');
    process.exit(1);
  }
  if (!decision.allow) {
    console.log(`::error::${refusalMessage(decision, branch)}`);
    process.exit(1);
  }
  console.log(`dispatch guard: allow (${decision.reason})`);
}

if (require.main === module) main();

module.exports = { decideDispatchGuard, refusalMessage, cancelledAtTip, BRANCH_RE, LIVE_MAX_HOURS };
