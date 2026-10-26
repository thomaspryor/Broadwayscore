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
 * Live means: any push run for the branch not yet completed, or a push run
 * cancelled at the branch's current tip (Admit parks a run by cancelling it,
 * and the sweep resumes it in place). The fix for a parked run is the sweep's
 * own path, `node scripts/land-retry-cancelled.js --run=<id>`, not a new run.
 *
 * Check-then-act: a push landing between this read and Checks starting is not
 * seen. The Checks group split keeps that case from cancelling anything.
 */

const BRANCH_RE = /^land\/[\w./-]+$/;
const RUNS_PER_PAGE = 20;

function decideDispatchGuard({ branch, tipSha, runs, disabled = false }) {
  if (disabled) return { allow: true, reason: 'disabled' };
  if (!BRANCH_RE.test(branch || '')) return { allow: false, reason: 'bad-branch' };
  const live = (runs || []).find((r) => r.status !== 'completed');
  if (live) return { allow: false, reason: 'push-run-live', runId: live.id };
  const parked = tipSha && (runs || []).find((r) => r.conclusion === 'cancelled' && r.head_sha === tipSha);
  if (parked) return { allow: false, reason: 'push-run-parked', runId: parked.id };
  return { allow: true, reason: 'no-live-push-run' };
}

function refusalMessage(decision, branch) {
  if (decision.reason === 'bad-branch') return `branch input must be land/<name>, got "${branch}"`;
  const state = decision.reason === 'push-run-parked' ? 'parked in the landing line' : 'live';
  return `a push run for ${branch} is ${state} (run ${decision.runId}); a dispatch would compete with it. ` +
    `Wait for it, or resume it with: node scripts/land-retry-cancelled.js --run=${decision.runId}`;
}

function main() {
  const { execFileSync } = require('child_process');
  const branch = process.env.BRANCH || '';
  const repo = process.env.REPO;
  const disabled = process.env.LAND_DISPATCH_GUARD_DISABLED === 'true';
  const gh = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
  let decision;
  try {
    let tipSha = null;
    if (!disabled && BRANCH_RE.test(branch)) {
      tipSha = gh(`repos/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`).object?.sha || null;
    }
    const runs = disabled || !BRANCH_RE.test(branch) ? [] :
      gh(`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=${RUNS_PER_PAGE}`).workflow_runs || [];
    decision = decideDispatchGuard({ branch, tipSha, runs, disabled });
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

module.exports = { decideDispatchGuard, refusalMessage, BRANCH_RE };
