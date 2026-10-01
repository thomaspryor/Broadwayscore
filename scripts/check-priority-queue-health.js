#!/usr/bin/env node
/**
 * check-priority-queue-health.js — daily outcome check for the Linear P0/P1
 * queue (BRO-4487). See scripts/lib/priority-queue-health.js for what is
 * counted and why.
 *
 *   node scripts/check-priority-queue-health.js            print the summary
 *   node scripts/check-priority-queue-health.js --json     machine-readable
 *   node scripts/check-priority-queue-health.js --alert    also queue the
 *        summary for the owner's morning digest when any P0/P1 is overdue
 *
 * Exit codes: 0 = measured (healthy or not; the verdict is in the output),
 * 3 = could not be measured (Linear unreachable / no API key). Never exits
 * non-zero for an unhealthy queue: a red data-health-check job emails the
 * owner directly, and paging is the owner's call (page-worthy-alerts.js).
 */

'use strict';

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const linear = require('./lib/linear-client');
const { assessPriorityQueue, formatSummary } = require('./lib/priority-queue-health');

const USAGE = 'Usage: node scripts/check-priority-queue-health.js [--json] [--alert]';
const MAX_PAGES = 40; // 250 × 40 = 10,000 open issues; the board holds ~2,000

// Non-archived, non-terminal issues of every priority (the total is part of
// the verdict — see the lib header). includeArchived deliberately omitted.
const OPEN_ISSUES_QUERY = `query($teamKey: String!, $after: String) {
  issues(first: 250, after: $after, filter: {
    team: { key: { eq: $teamKey } },
    state: { type: { nin: ["completed", "canceled", "duplicate"] } }
  }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title priority createdAt state { type } }
  }
}`;

async function fetchOpenIssues() {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await linear.graphql(OPEN_ISSUES_QUERY, { teamKey: linear.TEAM_KEY, after });
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return { issues: out, truncated: false };
    after = data.issues.pageInfo.endCursor;
  }
  return { issues: out, truncated: true };
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  let fetched;
  try {
    fetched = await fetchOpenIssues();
  } catch (err) {
    console.error(`[priority-queue-health] could not read Linear: ${err.message}`);
    return 3;
  }
  const result = { ...assessPriorityQueue(fetched.issues, Date.now()), truncated: fetched.truncated };
  const summary = `${formatSummary(result)}${result.truncated ? ' (count truncated: a floor, not exact)' : ''}`;

  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`P0/P1 queue: ${summary}`);
    for (const i of result.oldestP0) console.log(`  overdue P0 ${i.identifier} (${Math.round(i.ageHours / 24)}d): ${i.title}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### P0/P1 queue\n${summary}\n`); } catch { /* summary is cosmetic */ }
  }

  if (argv.includes('--alert') && !result.healthy) {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    const list = result.oldestP0.map((i) => `- ${i.identifier} (${Math.round(i.ageHours / 24)}d): ${i.title}`).join('\n');
    await routeAlert({
      conditionKey: 'priority-queue:overdue',
      title: `P0/P1 queue overdue: ${result.p0Overdue} P0 older than 24h, ${result.p1Overdue} P1 older than 7d`,
      description: `${summary}\n\nOldest overdue P0s:\n${list || '(none)'}`,
      severity: 'warning',
      disposition: 'digest',
      cooldownHours: 20,
    });
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[priority-queue-health] ${err.stack || err.message}`);
    process.exitCode = 3;
  });
}

module.exports = { main, fetchOpenIssues, OPEN_ISSUES_QUERY };
