'use strict';

const { cachedFetch, hasLowHeadroom, LOW_HEADROOM_THRESHOLD } = require('./gh-api-cache.js');
const { fetchGitHubJSON } = require('./gh-api-client.js');

// At most 3 run-list pages + 12 job pages per refresh, with the existing
// reserve untouched. Completed attempts are immutable, so share their jobs
// across the day's health checks. Pages, including retries, count toward the cap.
const MAX_JOB_REQUESTS = 12;
const JOB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function failedSteps(jobs) {
  const steps = [];
  for (const job of jobs) {
    if (job.conclusion !== 'failure') continue;
    const failed = (job.steps || []).filter(step => step.conclusion === 'failure');
    for (const step of failed) steps.push({ job: job.name, step: step.name });
    if (!failed.length) steps.push({ job: job.name, step: null });
  }
  return steps;
}

async function enrichRepeatFailureSteps(completed, {
  token,
  fetchJSON = fetchGitHubJSON,
  cache = cachedFetch,
  lowHeadroom = hasLowHeadroom,
} = {}) {
  // Single failures never produce repeat alerts. Gate refusals already have
  // per-branch routing, so only fetch jobs for workflows that can alert.
  const candidates = new Set(summarizeRepeatFailures(completed).map(entry => entry.name));
  const detailed = [...completed];
  let requests = 0;
  // Newest first ensures the latest actionable failures get details first
  // when a busy day uses the entire budget. Preserve the caller's ordering.
  const indexes = completed.map((_, i) => i)
    .filter(i => completed[i].conclusion === 'failure' && candidates.has(completed[i].name))
    .sort((a, b) => String(completed[b].created_at).localeCompare(String(completed[a].created_at)));
  for (const i of indexes) {
    const run = completed[i];
    let failureSteps = [];
    try {
      if (!run.id) throw new Error('missing run id');
      failureSteps = await cache(`workflow-failed-steps-v1:${run.id}:${run.run_attempt || 1}`, async () => {
        const jobs = [];
        let page = 1;
        let total;
        do {
          // Reserve the whole remaining batch even if the quota sample is
          // cached. No uncached calls are allowed after the cap is reached.
          if (requests >= MAX_JOB_REQUESTS || lowHeadroom(LOW_HEADROOM_THRESHOLD + MAX_JOB_REQUESTS)) {
            throw new Error('jobs request budget unavailable');
          }
          requests++;
          const response = await fetchJSON(
            `https://api.github.com/repos/thomaspryor/Broadwayscore/actions/runs/${run.id}/attempts/${run.run_attempt || 1}/jobs?per_page=100&page=${page}`,
            { token, caller: 'health-check.js', headers: { 'User-Agent': 'bsc-health-check' } },
          );
          if (!Array.isArray(response?.jobs) || !Number.isInteger(response.total_count)) {
            throw new Error('invalid jobs response');
          }
          jobs.push(...response.jobs);
          total = response.total_count;
          if (jobs.length < total && !response.jobs.length) throw new Error('incomplete jobs response');
          page++;
        } while (jobs.length < total);
        // Cache only the names needed for grouping, not full jobs payloads.
        return failedSteps(jobs);
      }, { ttlMs: JOB_CACHE_TTL_MS });
    } catch {
      // Missing details stay separate from known steps. Never attribute an
      // uninspected run to another run's failure, or drop its failures.
    }
    detailed[i] = { ...run, failureSteps, failureDetailsUnavailable: !failureSteps.length };
  }
  return detailed;
}

function repeatFailureLabel(entry) {
  if (!entry.job && !entry.step) return entry.name;
  return `${entry.name} / ${entry.job || 'unknown job'} / ${entry.step || 'failed step unavailable'}`;
}

// Pure (no I/O): group completed runs into repeat-failure entries (>=2 reds
// in the window), annotated selfHealed, minus gate workflows that are only
// refusing input. @param {object[]} completed - GitHub workflow_run objects
function summarizeRepeatFailures(completed) {
  // Keep different failed jobs/steps in their own buckets. Each run counts
  // once per bucket, including matrix jobs with duplicate display names.
  const byWorkflow = new Map();
  for (const run of completed.filter(r => r.conclusion === 'failure')) {
    const failures = run.failureSteps?.length ? run.failureSteps : [{}];
    const seen = new Set();
    for (const { job, step } of failures) {
      const key = JSON.stringify([run.name, job || null, step || null]);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = byWorkflow.get(key) || { name: run.name, count: 0, latestUrl: null, latestAt: null,
        ...(job ? { job, step: step || null } : {}) };
      if (run.failureDetailsUnavailable || (job && !step)) entry.detailsUnavailable = true;
      entry.count += 1;
      if (!entry.latestAt || run.created_at > entry.latestAt) {
        entry.latestAt = run.created_at;
        entry.latestUrl = run.html_url;
      }
      byWorkflow.set(key, entry);
    }
  }
  const repeatFailures = Array.from(byWorkflow.values())
    .filter(entry => entry.count >= 2)
    .sort((a, b) => b.count - a.count);

  // Self-heal annotation: a repeat-failure whose streak has demonstrably
  // ENDED (2+ consecutive green completed runs since the last failure) has
  // likely already been fixed - the trailing-24h window just hasn't aged the
  // failures out yet. The Aug 1 Test Suite streak ended 05:10 UTC but the
  // digest fired a "likely broken" Fix-this card ~6.5h later, burning a
  // session on an already-resolved condition. Deliberately NOT a bare
  // latest-run-green check: a flapping workflow (11/19 failures, 2026-06-13)
  // has a green latest run most mornings, and last-successful-run heuristics
  // are the exact blindness repeatFailureResults was built to fix
  // (second-opinion review, 2026-08-01).
  for (const entry of repeatFailures) {
    const conclusions = completed
      .filter(r => r.name === entry.name)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map(r => r.conclusion);
    entry.selfHealed = isRepeatFailureSelfHealed(conclusions);
    entry.gateRefusalsOnly = GATE_WORKFLOWS.has(entry.name) && !isGateWorkflowBroken(conclusions);
  }
  // BRO-5174: a gate workflow's red run is the gate refusing a branch
  // (already alerted per branch), not the workflow breaking.
  return repeatFailures.filter(entry => !entry.gateRefusalsOnly);
}

function isRepeatFailureSelfHealed(conclusionsNewestFirst) {
  if (!Array.isArray(conclusionsNewestFirst) || conclusionsNewestFirst.length < 2) return false;
  let leadingGreens = 0;
  for (const c of conclusionsNewestFirst) {
    if (c !== 'success') break;
    leadingGreens++;
  }
  return leadingGreens >= 2;
}

// Gate workflows: a red run means the gate REFUSED its input (Land: the
// branch broke a test or would not rebase), and that refusal is already
// alerted per branch (scripts/land-alert.js, conditionKey land:<branch>).
// Counting those reds as "Workflow repeat-failure: Land" filed BRO-5174 for
// a day of 6 correct refusals among ~22 landings. The gate itself is broken
// only when it stops landing anything: no green run in the window, or
// GATE_BROKEN_STREAK+ reds in a row at the head (interleaved refusals in
// practice run at most 2 deep). Cancelled/skipped runs are neutral, so
// Land's own queue-park cancels cannot reset a crash streak. A crash that hits
// only some branches is still routed: land-retry-cancelled.yml escalates every
// red land/** ref to its card hourly (scripts/lib/land-stranded-refs.js).
const GATE_WORKFLOWS = new Set(['Land']);
const GATE_BROKEN_STREAK = 4;
// Pure (no I/O). @param {string[]} conclusionsNewestFirst - completed runs, newest first
function isGateWorkflowBroken(conclusionsNewestFirst) {
  const cs = Array.isArray(conclusionsNewestFirst) ? conclusionsNewestFirst : [];
  if (!cs.includes('success')) return true;
  let leadingFailures = 0;
  for (const c of cs) {
    if (c === 'success') break;
    if (c === 'failure') leadingFailures++;
  }
  return leadingFailures >= GATE_BROKEN_STREAK;
}

module.exports = {
  enrichRepeatFailureSteps, failedSteps, repeatFailureLabel,
  summarizeRepeatFailures, isRepeatFailureSelfHealed, isGateWorkflowBroken,
  GATE_WORKFLOWS, MAX_JOB_REQUESTS, JOB_CACHE_TTL_MS,
};
