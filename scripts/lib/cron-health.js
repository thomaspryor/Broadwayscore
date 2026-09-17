'use strict';

const fs = require('fs');
const path = require('path');

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

/**
 * Best-effort `timeout-minutes:` per top-level job, parsed straight out of a
 * workflow YAML's text (not a full YAML parser — good enough for this repo's
 * consistently-formatted workflow files). Extracted from
 * scripts/cron-health-chronic-orchestrator.js (BRO-2534) so the parse itself
 * has test coverage, not just the orchestrator script that calls it — this is
 * the exact math that showed weekly-video-reviews.yml's "Commit and push"
 * step was running on push-with-retry.sh's shared 240s default despite the
 * job carrying a 180-minute (10800s) timeout, which is what let 13 of its
 * last 20 runs fail on push-contention (CLAUDE.md rule 15 extraction).
 *
 * @param {string} yamlText raw workflow YAML text
 * @returns {Object<string, number>} job name -> timeout-minutes
 */
function parseJobTimeouts(yamlText) {
  const lines = yamlText.split('\n');
  const timeouts = {};
  let currentJob = null;
  // Jobs are top-level keys under `jobs:` at 2-space indent; `timeout-minutes:`
  // lines nested under a job are indented further.
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const jobMatch = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (jobMatch) { currentJob = jobMatch[1]; continue; }
    const timeoutMatch = line.match(/^\s+timeout-minutes:\s*(\d+)/);
    if (timeoutMatch && currentJob) {
      timeouts[currentJob] = parseInt(timeoutMatch[1], 10);
    }
  }
  return timeouts;
}

/**
 * IO wrapper around parseJobTimeouts: reads a workflow file by name (relative
 * to .github/workflows/) from this repo checkout.
 *
 * @param {string} workflowFile filename under .github/workflows/
 * @returns {Object<string, number>} job name -> timeout-minutes
 */
function readJobTimeouts(workflowFile) {
  const wfPath = path.join(__dirname, '..', '..', '.github', 'workflows', workflowFile);
  return parseJobTimeouts(fs.readFileSync(wfPath, 'utf8'));
}

module.exports = { minutesBetween, classifyJob, parseJobTimeouts, readJobTimeouts };
