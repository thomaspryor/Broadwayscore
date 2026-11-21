'use strict';

/**
 * BRO-7983: coalesce dispatched vercel-deploy.yml runs.
 *
 * Opening night 2026-11-20 (Elektra): 31 workflow_dispatch deploys stacked in 70 min
 * (poller fast_path, rebuild-fast, express, lane-live), each building in parallel and
 * taking 20-40 min, so a review ingested at 05:25Z went live at 05:54Z.
 *
 * Rule: a dispatched run skips when an OLDER in-flight run of the same code SHA has not
 * yet passed "Checkout core data" in its deploy job. That run pulls core data after this
 * point, so it ships everything this dispatch would. Only older run ids count, so the
 * oldest run never skips (no mutual skip). Any doubt (missing data) means proceed.
 */

const PASSED_STEP = 'Checkout core data';

const isPrewarm = (r) => String(r.display_title || r.name || '').includes('pre-warm');

// Has this run's deploy job already pulled core data (or finished that step)?
function pastCoreDataCheckout(jobs) {
  const deploy = (jobs || []).find((j) => j && j.name === 'deploy');
  if (!deploy) return null; // unknown (job not created yet or API gap)
  if (deploy.status === 'queued') return false;
  const step = (deploy.steps || []).find((s) => s.name === PASSED_STEP);
  if (!step) return null; // unknown shape: fail open
  return step.status === 'completed' || step.status === 'in_progress';
}

/**
 * @param {{selfRunId:number, selfSha:string, runs:Array, jobsByRun:Object}} a
 * @returns {{proceed:boolean, reason:string, coveredBy?:number}}
 */
function decide({ selfRunId, selfSha, runs, jobsByRun }) {
  if (!selfRunId || !selfSha || !Array.isArray(runs)) return { proceed: true, reason: 'inputs-missing' };
  const older = runs
    .filter((r) => r && r.id < selfRunId && (r.status === 'queued' || r.status === 'in_progress'))
    .filter((r) => !isPrewarm(r) && r.head_sha === selfSha)
    .sort((a, b) => a.id - b.id);
  for (const r of older) {
    const past = pastCoreDataCheckout((jobsByRun || {})[r.id]);
    if (past === false) return { proceed: false, reason: `covered-by-pending-run-${r.id}`, coveredBy: r.id };
  }
  return { proceed: true, reason: older.length ? 'older-runs-already-pulled-data' : 'no-older-runs' };
}

module.exports = { decide, pastCoreDataCheckout, PASSED_STEP };
