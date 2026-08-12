#!/usr/bin/env node
/**
 * check-linear-cap.js — warns before the workspace hits Linear's free-tier
 * 250-unarchived-issue hard cap (BRO-285). Exits 1 (with the count) once
 * unarchived issues reach WARN_THRESHOLD, so an alert/cron can fire
 * scripts/linear-archive-done.js before new-issue creation starts throwing
 * USAGE_LIMIT_EXCEEDED (scripts/lib/linear-issue-create.js).
 *
 * All Linear API access goes through scripts/lib/linear-client.js — a raw
 * GraphQL mutation call or a direct reference to Linear's API host anywhere
 * outside that file's small allowlist fails the CI gate at
 * scripts/audit-linear-issuecreate-chokepoint.js.
 *
 * Usage: node scripts/check-linear-cap.js
 */

'use strict';

const linear = require('./lib/linear-client');
const { WARN_THRESHOLD, isOverCapThreshold } = require('./lib/linear-cap-policy');

async function main() {
  const team = await linear.getTeam();
  const issues = await linear.listIssues(team.id);
  const count = issues.length;

  if (isOverCapThreshold(count, WARN_THRESHOLD)) {
    console.error(
      `check-linear-cap: ${count} unarchived issues >= ${WARN_THRESHOLD} warn threshold ` +
      `(Linear's free-tier hard cap is 250). Run scripts/linear-archive-done.js to archive ` +
      `stale Done/Canceled issues.`
    );
    process.exit(1);
  }

  console.log(`check-linear-cap: OK — ${count} unarchived issues (< ${WARN_THRESHOLD} threshold).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`check-linear-cap: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
