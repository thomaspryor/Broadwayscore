#!/usr/bin/env node
/**
 * linear-archive-done.js — archives Done/Canceled Linear issues older than
 * ARCHIVE_AGE_HOURS, to keep the workspace under the free-tier 250-unarchived
 * -issue cap (BRO-285, scripts/check-linear-cap.js is the companion monitor).
 *
 * Every archive attempt is logged to data/audit/linear-archive-done.jsonl
 * AFTER the mutation attempt resolves, recording what actually happened
 * (outcome: archived|failed) rather than what was about to be attempted —
 * archiving is reversible in Linear's UI, but there's otherwise no local
 * record of what was archived or when. A process kill between a successful
 * archiveIssue() and its logArchive() loses that one audit line (the issue
 * IS archived on Linear's side) — acceptable for a reversible mutation.
 *
 * All Linear API access goes through scripts/lib/linear-client.js — a raw
 * GraphQL mutation call or a direct reference to Linear's API host anywhere
 * outside that file's small allowlist fails the CI gate at
 * scripts/audit-linear-issuecreate-chokepoint.js.
 *
 * Note: Linear's issues() connection excludes archived issues by default, so
 * an issue archived here drops out of scripts/linear-import.js --reconcile's
 * view too. That's fine — --reconcile only ever reports a vanished issue as
 * "missing" (console.error, not a re-create) — but don't be surprised if a
 * reconcile run's missing-count ticks up right after an archive run.
 *
 * Usage:
 *   node scripts/linear-archive-done.js             # archives eligible issues
 *   node scripts/linear-archive-done.js --dry-run    # lists eligible issues only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const linear = require('./lib/linear-client');
const { ARCHIVE_AGE_HOURS, isArchivableIssue, closedAtOf } = require('./lib/linear-cap-policy');
const { TERMINAL_STATE_TYPES } = require('./lib/linear-state-types');

const TERMINAL_STATE_LABEL = TERMINAL_STATE_TYPES.join('/');

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
    console.log(`linear-archive-done: no issues ${TERMINAL_STATE_LABEL} >= ${ARCHIVE_AGE_HOURS}h ago.`);
    return;
  }

  console.log(
    `linear-archive-done: ${candidates.length} issue(s) eligible for archive ` +
    `(${TERMINAL_STATE_LABEL} >= ${ARCHIVE_AGE_HOURS}h ago):`
  );
  for (const issue of candidates) {
    console.log(`  ${issue.identifier} — ${issue.title}`);
  }

  if (dryRun) {
    console.log('linear-archive-done: --dry-run, not archiving.');
    return;
  }

  // Per-issue try/catch: one failing archiveIssue() call (network blip, an
  // issue already archived by a concurrent run) must not abort the rest of
  // the batch — and the log entry is written AFTER the mutation attempt,
  // recording what actually happened, not what was about to be attempted.
  let archived = 0;
  let failed = 0;
  for (const issue of candidates) {
    const closedAt = closedAtOf(issue);
    try {
      await linear.archiveIssue(issue.id);
      logArchive({
        identifier: issue.identifier, id: issue.id, title: issue.title,
        stateType: issue.stateType, closedAt, archivedAt: new Date(now).toISOString(), outcome: 'archived',
      });
      archived += 1;
    } catch (err) {
      logArchive({
        identifier: issue.identifier, id: issue.id, title: issue.title,
        stateType: issue.stateType, closedAt, archivedAt: new Date(now).toISOString(),
        outcome: 'failed', error: err.message,
      });
      console.error(`linear-archive-done: failed to archive ${issue.identifier}: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`linear-archive-done: archived ${archived} issue(s), ${failed} failed. Log: ${ARCHIVE_LOG_PATH}`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`linear-archive-done: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
