#!/usr/bin/env node
/**
 * linear-archive-done.js — archives Done/Canceled Linear issues older than
 * ARCHIVE_AGE_HOURS, to keep the workspace under the free-tier 250-unarchived
 * -issue cap (BRO-285, scripts/check-linear-cap.js is the companion monitor).
 *
 * Every archive is logged to data/audit/linear-archive-done.jsonl BEFORE the
 * mutation is applied, mirroring scripts/linear-import.js's logMutation()
 * convention — archiving is reversible in Linear's UI, but there's otherwise
 * no local record of what was archived or when.
 *
 * All Linear API access goes through scripts/lib/linear-client.js — a raw
 * GraphQL mutation call or a direct reference to Linear's API host anywhere
 * outside that file's small allowlist fails the CI gate at
 * scripts/audit-linear-issuecreate-chokepoint.js.
 *
 * Usage:
 *   node scripts/linear-archive-done.js             # archives eligible issues
 *   node scripts/linear-archive-done.js --dry-run    # lists eligible issues only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const linear = require('./lib/linear-client');
const { ARCHIVE_AGE_HOURS, isArchivableIssue } = require('./lib/linear-cap-policy');

const REPO_ROOT = path.join(__dirname, '..');
const ARCHIVE_LOG_PATH = path.join(REPO_ROOT, 'data/audit/linear-archive-done.jsonl');

function logArchive(entry) {
  fs.mkdirSync(path.dirname(ARCHIVE_LOG_PATH), { recursive: true });
  fs.appendFileSync(ARCHIVE_LOG_PATH, JSON.stringify(entry) + '\n');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const team = await linear.getTeam();
  const issues = await linear.listIssues(team.id);
  const now = Date.now();
  const candidates = issues.filter((issue) => isArchivableIssue(issue, now, ARCHIVE_AGE_HOURS));

  if (candidates.length === 0) {
    console.log(`linear-archive-done: no issues completed/canceled >= ${ARCHIVE_AGE_HOURS}h ago.`);
    return;
  }

  console.log(
    `linear-archive-done: ${candidates.length} issue(s) eligible for archive ` +
    `(completed/canceled >= ${ARCHIVE_AGE_HOURS}h ago):`
  );
  for (const issue of candidates) {
    console.log(`  ${issue.identifier} — ${issue.title}`);
  }

  if (dryRun) {
    console.log('linear-archive-done: --dry-run, not archiving.');
    return;
  }

  let archived = 0;
  for (const issue of candidates) {
    logArchive({
      identifier: issue.identifier,
      id: issue.id,
      title: issue.title,
      stateType: issue.stateType,
      closedAt: issue.completedAt || issue.canceledAt,
      archivedAt: new Date(now).toISOString(),
    });
    await linear.archiveIssue(issue.id);
    archived += 1;
  }
  console.log(`linear-archive-done: archived ${archived} issue(s). Log: ${ARCHIVE_LOG_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`linear-archive-done: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
