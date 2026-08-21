'use strict';

/**
 * Pure stage-verification predicates for the opening-night fast_path
 * pipeline (gather -> collect -> score -> rebuild -> deploy), which already
 * runs as one sequential job in .github/workflows/opening-night-poller.yml.
 * Each fn takes a plain stage-result object (built from that stage's GitHub
 * Actions step outcome/outputs — no I/O here) and returns { ok, reason,
 * degraded? }.
 *
 * BRO-735: the 4 data stages used bare `continue-on-error: true` / `|| true`,
 * so a genuine crash (uncaught exception, non-zero exit) was swallowed
 * exactly the same as "ran fine, found nothing new" — 6 opening nights broke
 * silently this way. These predicates draw that line explicitly: a stage
 * that ran clean-but-found-nothing is `ok`; a stage that crashed is not.
 * Partial per-show crashes (some shows failed, others didn't) are `ok` but
 * `degraded` — full pipeline coverage still matters more than halting on one
 * bad show, so the pipeline is not stopped, but the crash is not silent
 * either (see verifyPipeline below).
 */

function verifyCountedStage(name, { failed = 0, total = 0 } = {}) {
  if (total === 0) return { ok: true, reason: `${name}: nothing to do` };
  if (failed === 0) return { ok: true, reason: `${name}: ${total}/${total} succeeded` };
  if (failed < total) {
    return {
      ok: true,
      degraded: true,
      reason: `${name}: ${failed}/${total} failed (partial — ${total - failed} succeeded)`,
    };
  }
  return { ok: false, reason: `${name}: all ${total} failed` };
}

function verifyStepStage(name, { attempted = true, outcome } = {}) {
  if (!attempted) return { ok: true, reason: `${name}: skipped (nothing to do)` };
  if (outcome === 'success') return { ok: true, reason: `${name}: completed` };
  if (outcome === 'skipped') return { ok: true, reason: `${name}: skipped` };
  return { ok: false, reason: `${name}: step outcome was '${outcome || 'unknown'}' — crashed` };
}

function verifyGatherStage({ failed = 0, total = 0 } = {}) {
  return verifyCountedStage('gather', { failed, total });
}

function verifyCollectStage({ attempted = true, outcome } = {}) {
  return verifyStepStage('collect', { attempted, outcome });
}

function verifyScoreStage({ failed = 0, total = 0 } = {}) {
  return verifyCountedStage('score', { failed, total });
}

function verifyRebuildStage({ attempted = true, outcome } = {}) {
  return verifyStepStage('rebuild', { attempted, outcome });
}

/**
 * Deploy is the one unavoidable cross-workflow call (project rule: deploys
 * go ONLY through vercel-deploy.yml). The gap this closes is that the
 * dispatch used to be fire-and-forget (`gh workflow run ... || echo
 * warning`) with no wait and no check that the commit actually went live —
 * a genuinely silent handoff. Both `!dispatched` (the `gh workflow run` API
 * call itself failed — e.g. a transient network blip) and `timedOut` (the
 * call succeeded but the deployment wasn't observed live within the wait
 * window) count as `ok` (degraded), NOT a hard pipeline failure: in both
 * cases vercel-deploy.yml's own 5-min content-aware cron gate is the
 * documented backstop that will pick it up shortly regardless. Ship-check
 * finding (2026-08-21): treating a transient dispatch-call failure as a hard
 * failure would page the owner for something that self-heals in <5 minutes —
 * only a genuine verification failure (Vercel API/token broken, which would
 * ALSO break the cron backstop's own deploy) should page. Not silent either
 * way — both are surfaced in the pipeline summary.
 */
function verifyDeployStage({ attempted = true, dispatched, verified, timedOut, reason } = {}) {
  if (!attempted) return { ok: true, reason: 'deploy: skipped (no rebuild happened)' };
  if (!dispatched) {
    return {
      ok: true,
      degraded: true,
      reason: 'deploy: dispatch call failed — 5-min cron gate will pick it up',
    };
  }
  if (verified) return { ok: true, reason: 'deploy: verified live on production' };
  if (timedOut) {
    return {
      ok: true,
      degraded: true,
      reason: 'deploy: dispatched but not verified live within the wait window — 5-min cron gate will retry',
    };
  }
  return { ok: false, reason: `deploy: verification failed — ${reason || 'unknown'}` };
}

/**
 * Aggregate every stage verdict into one pipeline verdict. Any ok:false
 * verdict fails the whole pipeline — this is the fail-fast gate: the job
 * step calling this exits non-zero, which flips the job conclusion to
 * failure and fires the existing notify-failure step, instead of the crash
 * disappearing behind continue-on-error.
 */
function verifyPipeline(stageResults) {
  const results = Array.isArray(stageResults) ? stageResults : [];
  const failed = results.filter((r) => r && r.ok === false);
  const degraded = results.filter((r) => r && r.ok === true && r.degraded);
  return {
    ok: failed.length === 0,
    failed,
    degraded,
    summary: results.map((r) => (r ? r.reason : 'unknown stage: no result')),
  };
}

module.exports = {
  verifyGatherStage,
  verifyCollectStage,
  verifyScoreStage,
  verifyRebuildStage,
  verifyDeployStage,
  verifyPipeline,
};
