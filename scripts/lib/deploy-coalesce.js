'use strict';

/**
 * BRO-7983: coalesce dispatched vercel-deploy.yml runs by SUPERSEDING.
 *
 * Opening night 2026-11-20 (Elektra): 31 workflow_dispatch deploys stacked in 70 min
 * (poller fast_path, rebuild-fast, express, lane-live), each building in parallel and
 * taking 20-40 min, so a review ingested at 05:25Z went live at 05:54Z.
 *
 * Rule (run by a NEWER run that has finished its BUILD and is about to deploy): cancel
 * every OLDER in-flight run still before its "Deploy to Production" step.
 * Main only moves forward and core data is pulled at build time, so the newer run ships
 * a superset of what the older would. The cancel happens only after the canceller's own
 * Build succeeded (ship-check 2026-11-21: cancelling at start left nothing deploying when
 * the newer run failed). Only main runs are touched, both sides.
 *
 * Never cancelled: pre-warm runs (they own their own wait/handoff), runs whose
 * should-deploy job has not finished with success (unknown fate), runs at or past
 * "Deploy to Production" (it may already be deploying), and anything with
 * missing or unexpected job/step data (fail open = leave it alone).
 */

const PASSED_STEP = 'Deploy to Production';

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
function decide({ selfRunId, selfBranch = 'main', runs, jobsByRun }) {
  const out = { cancel: [], kept: [] };
  if (!selfRunId || selfBranch !== 'main' || !Array.isArray(runs)) return out;
  for (const r of runs) {
    if (!r || r.id >= selfRunId) continue;
    if (r.head_branch !== 'main') continue;
    if (r.status !== 'queued' && r.status !== 'in_progress') continue;
    if (isPrewarm(r)) { out.kept.push({ id: r.id, reason: 'prewarm' }); continue; }
    if (pendingBeforeCoreData((jobsByRun || {})[r.id])) out.cancel.push(r.id);
    else out.kept.push({ id: r.id, reason: 'not-pending-or-unknown' });
  }
  return out;
}

module.exports = { decide, pendingBeforeCoreData, PASSED_STEP };
