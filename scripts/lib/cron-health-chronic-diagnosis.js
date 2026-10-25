'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ghApiJson } = require('./github-public-api.js');
const { classifyJob, readJobTimeouts } = require('./cron-health.js');

const CHECK_FILE = path.join(__dirname, '../../.github/workflows/check-cron-health.yml');
const MAX_SECTION_LENGTH = 2400;

// Use the monitor's exact friendly-name mapping, including aliases that differ
// from the workflow's YAML name. Never guess a filename from the alert text.
function resolveWorkflowFile(name, yaml = fs.readFileSync(CHECK_FILE, 'utf8')) {
  const block = yaml.match(/CRITICAL_CRONS=\(\s*\n([\s\S]*?)^\s*\)/m);
  if (!block) return null;
  const entries = [...block[1].matchAll(/^\s*"([\w-]+\.ya?ml)\|\d+\|([^"|]+)(?:\|[^"\n]+)?"/gm)];
  const matches = entries.filter(([, , displayName]) => displayName === name);
  return matches.length === 1 ? matches[0][1] : null;
}

/** Shared by the CLI and the alert filer. Read-only, at most 1 + limit requests. */
function collectDiagnosis({ workflowFile, limit = 15, repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore', readJson, readTimeouts = readJobTimeouts, timeoutMs = 30000 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1-100');
  if (!/^[\w-]+\.ya?ml$/.test(workflowFile)) throw new Error('Invalid workflow filename');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const deadline = Date.now() + timeoutMs;
  // The public fallback also works in the escalation step, which has no
  // GH_TOKEN. Preserve ghApiJson's refusal to retry rate/permission errors.
  const read = readJson || (apiPath => ghApiJson(apiPath, {
    exec: (command, args, options) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Diagnosis time budget exhausted');
      return execFileSync(command, args, { ...options, timeout: Math.min(10000, remaining) });
    },
  }));
  const timeouts = readTimeouts(workflowFile);
  const body = read(`repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=${limit}`);
  if (!Array.isArray(body.workflow_runs)) throw new Error('Invalid workflow run response');
  const runs = body.workflow_runs.slice(0, limit)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const shapeCounts = {};
  const details = [];
  for (const run of runs) {
    // A green, skipped or unfinished run cannot explain a completed failure.
    if (!run.conclusion || ['success', 'skipped'].includes(run.conclusion)) continue;
    if (!Number.isSafeInteger(run.id)) throw new Error('Invalid run ID');
    const { jobs } = read(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    if (!Array.isArray(jobs)) throw new Error('Invalid workflow jobs response');
    for (const job of jobs) {
      if (!job.conclusion || ['success', 'skipped'].includes(job.conclusion)) continue;
      const shape = classifyJob({ ...job, startedAt: job.started_at, completedAt: job.completed_at }, timeouts);
      const bucket = shape.split(' (')[0];
      shapeCounts[bucket] = (shapeCounts[bucket] || 0) + 1;
      details.push({ runId: run.id, name: job.name, shape });
    }
  }
  return { workflowFile, repo, runs, shapeCounts, details };
}

function text(value, max = 220) {
  return String(value).replace(/[\r\n`]/g, ' ').slice(0, max);
}

function failureFamily(shape) {
  const bucket = shape.split(' (')[0];
  return ['timeout-cancelled', 'push-contention'].includes(bucket) ? bucket : 'other';
}

function formatDiagnosis({ workflowFile, repo, runs, shapeCounts, details }) {
  const counts = Object.entries(shapeCounts).sort((a, b) => b[1] - a[1]);
  const families = {};
  for (const [shape, count] of counts) families[failureFamily(shape)] = (families[failureFamily(shape)] || 0) + count;
  const top = Object.entries(families).sort((a, b) => b[1] - a[1])[0];
  const dominant = top?.[0] || 'other';
  const lines = [
    '## Diagnosis',
    `Workflow: ${workflowFile}. Inspected ${runs.length} recent runs.`,
    `Dominant failure shape: **${dominant}**${top ? ` (${top[1]} jobs).` : '. No failing/cancelled jobs found; check scheduling or a stale success clock.'}`,
  ];
  if (counts.length) lines.push(`Job counts: ${counts.map(([shape, n]) => `${text(shape, 80)}: ${n}`).join(', ')}.`);
  // Put evidence for the dominant shape first, so unrelated secondary jobs
  // cannot crowd it out of the bounded card body.
  const evidence = [...details].sort((a, b) => Number(failureFamily(b.shape) === dominant) - Number(failureFamily(a.shape) === dominant));
  for (const d of evidence.slice(0, 3)) {
    lines.push(`- ${text(d.name)}: ${text(d.shape)} ([run ${d.runId}](https://github.com/${repo}/actions/runs/${d.runId}))`);
  }
  if (dominant === 'timeout-cancelled') lines.push('Check script wall-clock budgets against job timeout-minutes (scripts/lib/run-budget.js).');
  else if (dominant === 'push-contention') lines.push('Check push-with-retry.sh and Git Data API fallback eligibility in scripts/lib/core-data-merge-registry.js.');
  return lines.join('\n').slice(0, MAX_SECTION_LENGTH);
}

// Called only when the router has decided to file a NEW chronic-cron card.
// A diagnostic outage must never prevent that card from being filed.
function chronicDiagnosisSection(conditionKey, { resolve = resolveWorkflowFile, collect = collectDiagnosis } = {}) {
  const prefix = 'cron-health-chronic:';
  if (!conditionKey?.startsWith(prefix)) return null;
  try {
    const workflowFile = resolve(conditionKey.slice(prefix.length));
    if (!workflowFile) throw new Error('No unique CRITICAL_CRONS workflow mapping');
    return formatDiagnosis(collect({ workflowFile, limit: 15 }));
  } catch {
    // Do not include subprocess stderr: diagnostics are optional and CLI
    // errors can contain environment details that do not belong on a card.
    return '## Diagnosis\nDominant failure shape: **other** (diagnosis unavailable). Check workflow mapping, GitHub API access, rate limits, or the diagnostic time budget; no root cause was inferred.';
  }
}

module.exports = { resolveWorkflowFile, collectDiagnosis, formatDiagnosis, chronicDiagnosisSection };
