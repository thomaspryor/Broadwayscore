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

/*
 * BRO-8236 (part 2): a ROUTINE deploy that another deploy has overtaken stops before upload.
 *
 * After the reveal fix, routine deploys still came in bursts of 2-6 within ~10 min each
 * hour (72 READY/24h, target <=60): once the 45-min interval opens, every trigger in the
 * next few minutes sees the same old READY baseline, because a new deploy only shows up
 * on Vercel after its ~8 min build on the runner. Same SHA shipped twice at 06:09/06:10,
 * 10:25/10:26 and 12:26/12:28 on 2026-11-26.
 *
 * A routine run (gate urgent=false, reason in ROUTINE_REDUNDANT_REASONS) stops when
 *   - Vercel has a non-failed production deployment created since this run's gate
 *     baseline (another deploy got there first), or
 *   - an OLDER main run is inside its own "Deploy to Production" step right now
 *     (uploading, not on Vercel yet; older wins so two runs never stop each other).
 * The caller then dispatches one follow-up run, whose gate holds it to the interval
 * and ships whatever this run carried. Urgent runs (opening-night reveals, /go-live-now),
 * code changes and fail-open reasons never stop. Missing data = no stop (fail open).
 */
const ROUTINE_REDUNDANT_REASONS = ['content-changed', 'data-changed', 'staleness-backstop'];
const IN_FLIGHT_STATES = new Set(['QUEUED', 'INITIALIZING', 'BUILDING']);
// A prebuilt deploy is READY within minutes; an older in-flight one is stuck and must not
// suppress routine shipping indefinitely (Codex ship-check).
const IN_FLIGHT_MAX_AGE_MS = 20 * 60 * 1000;
// baseline created time is rebuilt from a whole-second ageSec; the baseline itself is excluded by url.
const CREATED_SLACK_MS = 5000;

/** Pure: id of an older main run whose "Deploy to Production" step is running, else null. */
function olderRunUploading({ selfRunId, runs, jobsByRun }) {
  for (const r of runs || []) {
    if (!r || !(r.id < selfRunId) || r.head_branch !== 'main' || r.status !== 'in_progress') continue;
    const deploy = ((jobsByRun || {})[r.id] || []).find((j) => j && j.name === 'deploy');
    if (!deploy || deploy.status !== 'in_progress') continue;
    const step = (deploy.steps || []).find((s) => s && s.name === PASSED_STEP);
    if (step && step.status === 'in_progress') return r.id;
  }
  return null;
}

/**
 * codeChanged must be the string 'false' (gate positively found no CODE_PATHS change vs the
 * live baseline); anything else never stops, so a code fix is never discarded.
 * @returns {{stop: boolean, why: string}}
 */
function redundantRoutineDeploy({ urgent, reason, codeChanged, selfRunId, runs, jobsByRun, deployments, baselineUrl, baselineCreatedMs, nowMs = Date.now() }) {
  if (String(urgent) !== 'false') return { stop: false, why: `urgent=${urgent === undefined || urgent === '' ? 'unknown' : urgent}` };
  if (!ROUTINE_REDUNDANT_REASONS.includes(reason)) return { stop: false, why: `reason=${reason || 'unknown'}` };
  if (String(codeChanged) !== 'false') return { stop: false, why: `code-changed=${codeChanged === undefined || codeChanged === '' ? 'unknown' : codeChanged}` };
  const since = Number(baselineCreatedMs);
  if (Array.isArray(deployments) && baselineUrl && Number.isFinite(since) && since > 0) {
    const newer = deployments.find((d) => {
      if (!d || !d.url || d.url === baselineUrl || !(Number(d.created) > since - CREATED_SLACK_MS)) return false;
      const state = String(d.state || d.readyState || '');
      if (state === 'READY') return true;
      return IN_FLIGHT_STATES.has(state) && nowMs - Number(d.created) <= IN_FLIGHT_MAX_AGE_MS;
    });
    if (newer) return { stop: true, why: `newer-deployment ${newer.url} (${newer.state || newer.readyState})` };
  }
  const up = selfRunId ? olderRunUploading({ selfRunId, runs, jobsByRun }) : null;
  if (up) return { stop: true, why: `older-run-uploading ${up}` };
  return { stop: false, why: 'not-overtaken' };
}

module.exports = { decide, pendingBeforeCoreData, PASSED_STEP, redundantRoutineDeploy, olderRunUploading, ROUTINE_REDUNDANT_REASONS };
