#!/usr/bin/env node
/**
 * Daily Failure Digest
 *
 * Queries GitHub API for workflow failures in the last 24 hours,
 * excludes critical workflows (which alert in real-time), and sends
 * a single consolidated Discord report.
 *
 * Runs as part of the Daily Data Health Check workflow.
 *
 * Requires: GH_TOKEN, DISCORD_WEBHOOK_ALERTS
 */

const fs = require('fs');
const path = require('path');
const { sendAlert } = require('./lib/discord-notify.js');

const HISTORY_PATH = path.join(__dirname, '..', 'data', 'audit', 'digest-history.json');

// These workflows send real-time critical alerts — skip them in the digest
const CRITICAL_WORKFLOWS = new Set([
  'vercel-deploy.yml',
  'opening-night-broadcast.yml',
  'opening-night-poller.yml',
  'send-follow-notifications.yml',
  'check-cron-health.yml',
  'gather-reviews.yml',
]);

// Workflows that fail routinely and aren't actionable in a digest
const IGNORED_WORKFLOWS = new Set([
  'data-health-check.yml', // This workflow — would be circular
]);

async function fetchFailedRuns() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('[Digest] No GH_TOKEN, skipping failure digest');
    return [];
  }

  const owner = process.env.GITHUB_REPOSITORY_OWNER || 'thomaspryor';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'Broadwayscore';

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sinceDate = since.toISOString().split('T')[0];

  // Fetch recent failed workflow runs
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?status=failure&created=%3E%3D${sinceDate}&per_page=100`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    console.error(`[Digest] GitHub API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const data = await res.json();
  return (data.workflow_runs || []).filter(run => {
    const created = new Date(run.created_at);
    return created >= since;
  });
}

function extractWorkflowFile(run) {
  // run.path is like ".github/workflows/test.yml"
  return run.path?.replace('.github/workflows/', '') || run.name;
}

async function main() {
  console.log('[Digest] Checking for workflow failures in the last 24 hours...');

  const allFailures = await fetchFailedRuns();
  console.log(`[Digest] Found ${allFailures.length} total failed runs`);

  // Filter out critical and ignored workflows
  const digestFailures = allFailures.filter(run => {
    const file = extractWorkflowFile(run);
    return !CRITICAL_WORKFLOWS.has(file) && !IGNORED_WORKFLOWS.has(file);
  });

  // Log every run to history for signal-to-noise evaluation
  const historyEntry = {
    timestamp: new Date().toISOString(),
    totalFailures: allFailures.length,
    criticalFiltered: allFailures.length - digestFailures.length,
    digestFailures: digestFailures.length,
    workflows: {},
  };
  for (const run of digestFailures) {
    const name = run.name || extractWorkflowFile(run);
    historyEntry.workflows[name] = (historyEntry.workflows[name] || 0) + 1;
  }
  saveHistory(historyEntry);

  if (digestFailures.length === 0) {
    console.log('[Digest] No non-critical failures to report — logged quiet day');
    return;
  }

  // Group by workflow name
  const byWorkflow = new Map();
  for (const run of digestFailures) {
    const name = run.name || extractWorkflowFile(run);
    if (!byWorkflow.has(name)) {
      byWorkflow.set(name, []);
    }
    byWorkflow.get(name).push(run);
  }

  // Build the digest message
  const lines = [];
  const sortedWorkflows = [...byWorkflow.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [name, runs] of sortedWorkflows) {
    const count = runs.length;
    const latest = runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const latestUrl = latest.html_url;
    const timeAgo = getTimeAgo(new Date(latest.created_at));
    lines.push(`**${name}** — ${count}x ([latest](${latestUrl}), ${timeAgo})`);
  }

  const totalFailures = digestFailures.length;
  const totalWorkflows = byWorkflow.size;
  const summary = `${totalFailures} failure${totalFailures === 1 ? '' : 's'} across ${totalWorkflows} workflow${totalWorkflows === 1 ? '' : 's'} in the last 24h.\n\n${lines.join('\n')}`;

  console.log(`[Digest] Sending digest: ${totalFailures} failures across ${totalWorkflows} workflows`);

  await sendAlert({
    title: 'Daily Failure Digest',
    description: summary,
    severity: 'warning',
  });

  console.log('[Digest] Digest sent');
}

function getTimeAgo(date) {
  const hours = Math.round((Date.now() - date.getTime()) / (1000 * 60 * 60));
  if (hours < 1) return '<1h ago';
  if (hours === 1) return '1h ago';
  return `${hours}h ago`;
}

function saveHistory(entry) {
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch {}
  history.push(entry);
  // Keep last 30 days
  if (history.length > 30) history = history.slice(-30);
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
  console.log(`[Digest] Logged to digest-history.json (${history.length} entries)`);
}

main().catch(err => {
  console.error('[Digest] Fatal error:', err.message);
  process.exit(1);
});
