#!/usr/bin/env node
/**
 * check-push-ledger.js — delayed re-verification for CI-side pushes (task
 * #677, the CI counterpart to scripts/verify-merge-landed.js's task #668
 * mitigation).
 *
 * push-with-retry.sh's content-survival check (task #619) only proves a
 * push landed AT THE INSTANT it ran, inside the same CI job. Because a
 * GitHub Actions runner terminates the moment its job ends, it cannot spawn
 * a background process to re-check minutes later the way a local Claude
 * Code session can (scripts/verify-merge-landed.js). The delay instead
 * comes from THIS script's own schedule: scripts/record-push-ledger.js
 * appends {sha, branch, ts, workflow} to data/audit/recent-pushes.jsonl
 * after every successful push-with-retry.sh push, and check-push-ledger.yml
 * runs this script every ~20 min, which is more than enough time for the
 * #668/#619 revert class (a push verified, then silently reverted by a
 * concurrent operation) to have already happened.
 *
 * For every ledger entry old enough to have had time to reveal a revert
 * (and not so old it's no longer actionable), re-checks reachability via
 * the GitHub compare API (scripts/lib/gh-compare-check.js — same
 * ground-truth method task #668 validated live) and files an 'auto'
 * alert-router card for anything no longer reachable from its branch tip.
 * Then prunes the ledger down to the check window — this hot-path-adjacent
 * rotation keeps scripts/record-push-ledger.js's own writes a cheap append,
 * per that script's header.
 *
 * Usage: node scripts/check-push-ledger.js
 * Exits non-zero only on a genuine script crash (this IS the sole CI-side
 * mitigation for the #668/#619 revert class, unlike verify-merge-landed.js
 * which is defense-in-depth atop other local-session checks — a silent
 * failure here has no other safety net to catch it). Per-entry gh API
 * failures are non-fatal: skip that entry, don't file a false alert, don't
 * crash the run — a single flaky compare call must not block checking
 * every other entry in the ledger.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { repoOwnerName, checkReachable } = require('./lib/gh-compare-check');
const { parseLedgerLines, serializeEntries, selectEntriesInWindow, pruneToWindow } = require('./lib/push-ledger');

const REPO_ROOT = path.join(__dirname, '..');
const LEDGER_REL_PATH = 'data/audit/recent-pushes.jsonl';
const LEDGER_ABS_PATH = path.join(REPO_ROOT, LEDGER_REL_PATH);

// A push needs time for a concurrent-operation revert to actually happen
// before checking it is meaningful — MIN_AGE_MS mirrors the first delayed
// checkpoint in verify-merge-landed.js's default (120s), rounded up since
// this script's own cron cadence (not an in-process timer) provides the
// wait. MAX_AGE_MS bounds how long an entry stays worth checking/keeping —
// past that, either it's long since confirmed fine or the incident window
// has closed; also doubles as the ledger's rotation horizon (see main()).
const MIN_AGE_MS = 3 * 60 * 1000;
const MAX_AGE_MS = 90 * 60 * 1000;

async function fileRevertAlert(repoInfo, entry, status) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router');
    await routeAlert({
      conditionKey: `push-ledger-revert:${entry.branch}:${entry.sha.slice(0, 12)}`,
      title: `origin/${entry.branch} lost a CI-pushed commit (${entry.workflow || 'unknown workflow'})`,
      disposition: 'auto',
      severity: 'error',
      category: 'Infra',
      description: `push-with-retry.sh pushed and verified ${entry.sha} on origin/${entry.branch} at ${entry.ts} (workflow: ${entry.workflow || 'unknown'}, run ${entry.runId || 'unknown'}), but this delayed re-check via the GitHub compare API found it no longer reachable (status: ${status}). This is the task #619/#668 failure class — some concurrent git operation moved origin/${entry.branch}'s tip backward after push-with-retry.sh's own push-time verify passed. Unlike a local Claude Code session, the CI job that pushed this has already terminated and cannot self-recover; the fix must be applied by a fresh run.`,
      hint: `Confirm with: gh api repos/${repoInfo.owner}/${repoInfo.repo}/compare/${entry.sha}...${entry.branch}. If still behind/diverged, recover the commit content via 'git show ${entry.sha}' and re-run the workflow that produced it (${entry.workflow || 'unknown — see runId'}, run ${entry.runId || 'unknown'}).`,
      fields: [
        { name: 'sha', value: entry.sha },
        { name: 'branch', value: entry.branch },
        { name: 'compare status', value: status },
        { name: 'workflow', value: entry.workflow || 'unknown' },
        { name: 'runId', value: entry.runId || 'unknown' },
        { name: 'pushed at', value: entry.ts },
      ],
    });
    return true;
  } catch (err) {
    console.error(`check-push-ledger: alert dispatch failed for ${entry.sha}: ${err.message}`);
    return false;
  }
}

async function main() {
  const repoInfo = repoOwnerName();
  if (!repoInfo) {
    console.error('check-push-ledger: could not resolve owner/repo from origin remote — nothing to check');
    process.exit(0);
  }

  let content = '';
  try {
    content = fs.readFileSync(LEDGER_ABS_PATH, 'utf8');
  } catch {
    console.log('check-push-ledger: no ledger file yet — nothing to check');
    process.exit(0);
  }

  const allEntries = parseLedgerLines(content);
  const nowMs = Date.now();
  const dueEntries = selectEntriesInWindow(allEntries, { nowMs, minAgeMs: MIN_AGE_MS, maxAgeMs: MAX_AGE_MS });

  console.log(`check-push-ledger: ${allEntries.length} entries in ledger, ${dueEntries.length} due for checking`);

  let checkedCount = 0;
  let flaggedCount = 0;
  let skippedCount = 0;

  for (const entry of dueEntries) {
    const result = checkReachable(repoInfo.owner, repoInfo.repo, entry.sha, entry.branch);
    if (result.ok === null) {
      console.error(`check-push-ledger: skipping ${entry.sha.slice(0, 12)} — check failed (${result.error})`);
      skippedCount++;
      continue;
    }
    checkedCount++;
    if (result.ok) {
      console.log(`check-push-ledger: ${entry.sha.slice(0, 12)} still reachable from origin/${entry.branch} (${result.status})`);
      continue;
    }
    console.error(`check-push-ledger: ${entry.sha.slice(0, 12)} NO LONGER reachable from origin/${entry.branch} (${result.status}) — filing alert`);
    if (await fileRevertAlert(repoInfo, entry, result.status)) flaggedCount++;
  }

  // Rotate the ledger down to the check window — entries older than
  // MAX_AGE_MS are done being useful (already checked repeatedly across
  // prior runs, or past the window where a revert would still be
  // actionable). Keeps record-push-ledger.js's hot-path writes cheap.
  const keptEntries = pruneToWindow(allEntries, { nowMs, maxAgeMs: MAX_AGE_MS });
  if (keptEntries.length !== allEntries.length) {
    fs.writeFileSync(LEDGER_ABS_PATH, serializeEntries(keptEntries));
    console.log(`check-push-ledger: pruned ledger from ${allEntries.length} to ${keptEntries.length} entries`);
  }

  console.log(`check-push-ledger: done — checked ${checkedCount}, flagged ${flaggedCount}, skipped ${skippedCount}`);
}

main().catch(err => {
  console.error(`check-push-ledger: fatal: ${err.message}`);
  process.exit(1); // NOT fail-open — this is the sole CI-side mitigation for the #668/#619 revert class
});
