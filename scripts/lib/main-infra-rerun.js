'use strict';

/**
 * main-infra-rerun.js — pure decision for BRO-4754.
 *
 * During a GitHub Actions incident (2026-10-05 19:12Z-~21:40Z) main test.yml
 * runs went red because jobs were cancelled before any runner picked them up:
 * job conclusion 'cancelled', no step ran, and the check-run annotation reads
 * "The job was not acquired by Runner of type hosted even after multiple
 * attempts". Those shas never got a code verdict. This decides whether the
 * NEWEST main push run is that case and should get `rerun-failed-jobs`.
 *
 * Newest-only (plan review): re-running an older sha whose rerun goes green
 * would fire test-summary's "Resolve alert" step and close incidents while a
 * newer run is genuinely red. Wait MIN_AGE_MS after the run ended so a rerun
 * during an ongoing incident does not starve again and burn the budget.
 */

const MAX_ATTEMPTS = 3;
const MIN_AGE_MS = 15 * 60 * 1000;
const AGGREGATOR_JOB = 'Test Summary';
const STARVED_ANNOTATION = /not acquired by Runner/i;

const isGreen = (c) => c === 'success' || c === 'skipped';

/** A job that never got a runner: cancelled, no step ran, GitHub's starvation annotation. */
function isStarvedJob(job, annotations) {
  if (!job || job.conclusion !== 'cancelled') return false;
  const ran = (job.steps || []).some((s) => s.conclusion === 'success' || s.conclusion === 'failure');
  if (ran) return false;
  return (annotations || []).some((a) => STARVED_ANNOTATION.test(String((a && a.message) || '')));
}

/** Jobs whose annotations must be fetched to decide: non-green, not the aggregator. */
function candidateJobs(jobs) {
  return (jobs || []).filter((j) => j.name !== AGGREGATOR_JOB && !isGreen(j.conclusion));
}

/**
 * runs: test.yml push runs on main, newest first (created_at desc).
 * jobs: the newest run's jobs (latest attempt). annotationsByJobId: { [id]: [{message}] }.
 */
function decideInfraRerun({ runs, jobs, annotationsByJobId = {}, now = Date.now(), maxAttempts = MAX_ATTEMPTS, minAgeMs = MIN_AGE_MS } = {}) {
  const no = (reason, run) => ({ retry: false, reason, runId: run ? run.id : null });
  const run = (runs || [])[0];
  if (!run) return no('no-run');
  if (run.event !== 'push' || run.head_branch !== 'main') return no('not-main-push', run);
  if (run.status !== 'completed') return no('newest-run-not-completed', run);
  if (run.conclusion !== 'failure' && run.conclusion !== 'cancelled') return no(`conclusion-${run.conclusion || 'none'}`, run);
  const attempt = run.run_attempt || 1;
  if (attempt >= maxAttempts) return no('attempts-exhausted', run);
  const ended = Date.parse(run.updated_at || '');
  if (!Number.isFinite(ended) || now - ended < minAgeMs) return no('too-recent', run);
  const bad = candidateJobs(jobs);
  if (bad.length === 0) return no('no-failed-jobs', run);
  const real = bad.filter((j) => !isStarvedJob(j, annotationsByJobId[j.id]));
  if (real.length) return no(`real-failure:${real.map((j) => j.name).join(',')}`, run);
  return { retry: true, reason: 'runner-starvation-only', runId: run.id, attempt, starved: bad.map((j) => j.name) };
}

/**
 * BRO-4771: the 15-minute cron fires every 4-8h in this repo, so the workflow also
 * runs on each red Test Suite completion and waits out MIN_AGE in-job. Returns
 * how long to sleep before deciding again: > 0 only when the run is too recent
 * AND would be re-run once old enough (decided again at ended + MIN_AGE), so a
 * real failure never holds a runner asleep. Capped at maxWaitMs.
 */
function waitMsFor(input = {}, { now = Date.now(), minAgeMs = MIN_AGE_MS, maxWaitMs = MIN_AGE_MS + 60 * 1000 } = {}) {
  const d = decideInfraRerun({ ...input, now, minAgeMs });
  if (d.retry || d.reason !== 'too-recent') return 0;
  const ended = Date.parse(((input.runs || [])[0] || {}).updated_at || '');
  if (!Number.isFinite(ended)) return 0;
  const later = ended + minAgeMs;
  if (!decideInfraRerun({ ...input, now: later, minAgeMs }).retry) return 0;
  return Math.max(0, Math.min(maxWaitMs, later - now + 5000));
}

module.exports = { decideInfraRerun, waitMsFor, isStarvedJob, candidateJobs, MAX_ATTEMPTS, MIN_AGE_MS, AGGREGATOR_JOB };
