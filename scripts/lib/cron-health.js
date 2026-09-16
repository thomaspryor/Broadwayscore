'use strict';

/**
 * cron-health.js — pure job-failure-shape classification for a chronically
 * stale cron (BRO-2530).
 *
 * check-cron-health.yml's "stale 3+ consecutive days" escalation (routeAlert
 * conditionKey `cron-health-chronic:<name>`) hands the owner a generic hint —
 * "check whether its runs are CANCELLED rather than failed ... or failing at
 * severity:low/email:false" — because notify-failure is a documented no-op
 * for `cancelled` conclusions and for any severity other than `critical` (see
 * .github/workflows/CLAUDE.md "Notification Severity"), so a cron can go
 * chronically stale without ever producing a real-time alert.
 *
 * `classifyJob` is the actual decision behind that hint: it turns a job's
 * conclusion + step list into one of the shapes that produce this exact
 * silence — extracted out of scripts/cron-health-chronic-orchestrator.js
 * (previously untested, CLAUDE.md rule 15) so the classification itself has
 * coverage, not just the orchestrator script that prints it.
 */

/** Minutes between two ISO timestamps; null if either is missing/unparsable. */
function minutesBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return (end - start) / 60000;
}

/**
 * Classify a single job from `gh run view --json jobs` into the shape that
 * explains why it went silently stale rather than paging in real time.
 *
 * @param {{conclusion: string, startedAt?: string, completedAt?: string, name: string, steps?: Array<{name: string, conclusion: string}>}} job
 * @param {Object<string, number>} timeouts job name -> timeout-minutes, from the workflow YAML
 * @returns {string} one of: 'success' | 'skipped' | 'timeout-cancelled (...)' |
 *   'cancelled (not timeout-shaped — check for a concurrency cancel or manual stop)' |
 *   'push-contention (...)' | 'other failure (...)' | 'other failure' | job.conclusion | 'unknown'
 */
function classifyJob(job, timeouts) {
  if (job.conclusion === 'success' || job.conclusion === 'skipped') return job.conclusion;

  const durationMin = minutesBetween(job.startedAt, job.completedAt);
  const timeout = timeouts[job.name];

  if (job.conclusion === 'cancelled') {
    // A job killed by `timeout-minutes:` reports conclusion=cancelled, not
    // failure (see .github/workflows/CLAUDE.md) — notify-failure's `if:
    // failure()` never fires for it. Duration close to (or over) the
    // declared timeout is the fingerprint; 0.85 tolerates the run summing
    // its own step overhead before GitHub's kill takes effect.
    if (timeout != null && durationMin != null && durationMin >= timeout * 0.85) {
      return `timeout-cancelled (${durationMin.toFixed(0)}min vs ${timeout}min timeout)`;
    }
    return 'cancelled (not timeout-shaped — check for a concurrency cancel or manual stop)';
  }

  if (job.conclusion === 'failure') {
    const failedSteps = (job.steps || []).filter((s) => s.conclusion === 'failure');
    const pushStep = failedSteps.find((s) => /^(commit|push)\b/i.test(s.name));
    if (pushStep) return `push-contention (failed step: "${pushStep.name}")`;
    if (failedSteps.length) return `other failure (failed step: "${failedSteps[0].name}")`;
    return 'other failure';
  }

  return job.conclusion || 'unknown';
}

module.exports = { minutesBetween, classifyJob };
