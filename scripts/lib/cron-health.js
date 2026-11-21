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
 * Keys the result by BOTH the job's YAML key (e.g. "video-reviews") and its
 * declared `name:` (e.g. "Discover, collect, score and publish new video
 * reviews"), when one is set — `gh run view --json jobs` reports `job.name`
 * as the LATTER, so classifyJob's `timeouts[job.name]` lookup silently missed
 * every job with an explicit `name:` before this (BRO-2534, Codex adversarial
 * review: this exact workflow's job was one, so timeout-cancelled detection
 * could never fire for it). Also restricts `timeout-minutes:` matching to
 * exactly 4-space indent (one level under the 2-space job key) — matching any
 * deeper indent picked up a STEP's own `timeout-minutes:` and let it silently
 * overwrite the job-level value with whichever one appeared last in the file
 * (same review pass, reproduced live on rebuild-reviews.yml: a 40-minute job
 * timeout with a 12-minute step timeout on one of its steps used to parse as
 * 12).
 *
 * @param {string} yamlText raw workflow YAML text
 * @returns {Object<string, number>} job key (and job display name, if set) -> timeout-minutes
 */
function parseJobTimeouts(yamlText) {
  const lines = yamlText.split('\n');
  const jobs = [];
  let current = null;
  // Jobs are top-level keys under `jobs:` at 2-space indent; job-level
  // attributes (name, timeout-minutes, ...) sit at exactly 4-space indent in
  // this repo's consistent 2-space-per-level style. Steps live in a nested
  // list starting at 6-space indent (`      - name: ...`), with their own
  // attributes at 8-space — deliberately NOT matched below.
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const jobMatch = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (jobMatch) { current = { key: jobMatch[1], name: null, timeoutMinutes: null }; jobs.push(current); continue; }
    if (!current) continue;
    const nameMatch = line.match(/^ {4}name:\s*(.+?)\s*$/);
    if (nameMatch) { current.name = nameMatch[1]; continue; }
    const timeoutMatch = line.match(/^ {4}timeout-minutes:\s*(\d+)/);
    if (timeoutMatch) { current.timeoutMinutes = parseInt(timeoutMatch[1], 10); }
  }
  const timeouts = {};
  for (const job of jobs) {
    if (job.timeoutMinutes == null) continue;
    timeouts[job.key] = job.timeoutMinutes;
    if (job.name) timeouts[job.name] = job.timeoutMinutes;
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

/**
 * PURE (BRO-7102 stage 4). Time headroom per job: how close each job's NORMAL
 * duration sits to its declared `timeout-minutes`. The class this guards: a
 * job's runtime creeps up to its limit, runs get killed there and counted red
 * with nothing broken (test.yml Unit Tests, 30 days to 2026-11-07: 74 of 79
 * cancelled main runs). classifyJob only names a kill after it happens; this
 * warns while there is still room.
 *
 * Counted: success and failure jobs at their duration, plus timeout-cancelled
 * jobs (>= 0.85 x timeout, classifyJob's fingerprint). Leaving the killed ones
 * out would hide exactly the runs that hit the wall (survivor bias). Other
 * cancels (concurrency, manual stop) and skips say nothing about runtime.
 * Jobs with no declared timeout, or not matched by name (matrix templates),
 * are left out.
 *
 * @param {Array<{name,conclusion,startedAt,completedAt}>} jobs
 * @param {Object<string, number>} timeouts parseJobTimeouts output
 * @param {{ratio?: number, minSamples?: number}} [opts]
 * @returns {Array<{name,n,p90Min,timeoutMin,ratio,tight}>} tightest first
 */
function timeoutHeadroom(jobs, timeouts, { ratio = 0.8, minSamples = 5 } = {}) {
  const byName = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || !job.name) continue;
    // Matrix jobs report as `Unit Test Shard (2)`; the workflow's `name:` has no
    // suffix, so the shards pool under one row (same strip as main-red-streak.js).
    const name = String(job.name).replace(/\s*\(\d+\)$/, '');
    const timeout = timeouts[name];
    if (timeout == null) continue;
    const d = minutesBetween(job.startedAt, job.completedAt);
    if (d == null || d < 0) continue;
    const counted = job.conclusion === 'success' || job.conclusion === 'failure'
      || (job.conclusion === 'cancelled' && d >= timeout * 0.85);
    if (!counted) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(d);
  }
  const rows = [];
  for (const [name, ds] of byName) {
    if (ds.length < minSamples) continue;
    const sorted = ds.slice().sort((a, b) => a - b);
    // Nearest-rank p90: with 10 or fewer samples this is the max, so one slow run can warn
    // (advisory, by design: a single run near the wall is worth a look).
    const p90Min = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
    const timeoutMin = timeouts[name];
    const r = p90Min / timeoutMin;
    rows.push({ name, n: ds.length, p90Min, timeoutMin, ratio: r, tight: r >= ratio });
  }
  return rows.sort((a, b) => b.ratio - a.ratio);
}

module.exports = { minutesBetween, classifyJob, parseJobTimeouts, readJobTimeouts, timeoutHeadroom };
