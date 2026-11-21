'use strict';

/**
 * BRO-7983: coalesce dispatched vercel-deploy.yml runs by SUPERSEDING.
 *
 * Opening night 2026-11-20 (Elektra): 31 workflow_dispatch deploys stacked in 70 min
 * (poller fast_path, rebuild-fast, express, lane-live), each building in parallel and
 * taking 20-40 min, so a review ingested at 05:25Z went live at 05:54Z.
 *
 * Rule (run by a NEWER run whose should-deploy gate already said proceed=true): cancel
 * every OLDER in-flight run that is still pre-"Checkout core data" in its deploy job.
 * Main only moves forward and core data is pulled at that step, so the newer run ships
 * a superset of what the older would. Why supersede and not "skip self": the older
 * run may itself end up not deploying (gate said already-live); a run that is
 * cancelled by a newer one always has a live successor. Different head SHAs are fine
 * because newer main contains older main.
 *
 * Never cancelled: pre-warm runs (they own their own wait/handoff), runs whose
 * should-deploy job has not finished with success (unknown fate), runs at or past
 * "Checkout core data" (data pulled; Build may be underway), and anything with
 * missing or unexpected job/step data (fail open = leave it alone).
 */

const PASSED_STEP = 'Checkout core data';

const isPrewarm = (r) => String(r.display_title || r.name || '').includes('pre-warm');

// true = deploy job exists and has NOT started the core-data checkout; false/null otherwise.
function pendingBeforeCoreData(jobs) {
  const gate = (jobs || []).find((j) => j && j.name === 'should-deploy');
  const deploy = (jobs || []).find((j) => j && j.name === 'deploy');
  if (!gate || gate.status !== 'completed' || gate.conclusion !== 'success') return false;
  if (!deploy || deploy.status === 'completed') return false;
  if (deploy.status === 'queued') return true;
  const step = (deploy.steps || []).find((s) => s.name === PASSED_STEP);
  return !!step && step.status === 'pending';
}

/** @returns {{cancel:number[], kept:Array<{id:number,reason:string}>}} */
function decide({ selfRunId, runs, jobsByRun }) {
  const out = { cancel: [], kept: [] };
  if (!selfRunId || !Array.isArray(runs)) return out;
  for (const r of runs) {
    if (!r || r.id >= selfRunId) continue;
    if (r.status !== 'queued' && r.status !== 'in_progress') continue;
    if (isPrewarm(r)) { out.kept.push({ id: r.id, reason: 'prewarm' }); continue; }
    if (pendingBeforeCoreData((jobsByRun || {})[r.id])) out.cancel.push(r.id);
    else out.kept.push({ id: r.id, reason: 'not-pending-or-unknown' });
  }
  return out;
}

module.exports = { decide, pendingBeforeCoreData, PASSED_STEP };
