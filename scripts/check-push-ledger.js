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
 * appends {sha, branch, ts, workflow} to the ledger after every successful
 * push-with-retry.sh push, and check-push-ledger.yml runs this script every
 * ~20 min, which is more than enough time for the #668/#619 revert class (a
 * push verified, then silently reverted by a concurrent operation) to have
 * already happened.
 *
 * STORAGE (2026-08-02 commit-churn rewrite, Notion 3b0637c5): the ledger
 * lives on the dedicated single-commit `push-ledger` branch, read/written
 * via scripts/lib/push-ledger-store.js — NOT as a file committed to main
 * (the old data/audit/recent-pushes.jsonl design added ~1,000 bookkeeping
 * commits/day to main). Pruning here rewrites that branch through the same
 * compare-and-swap the recorder uses; a lost CAS race just means the next
 * 20-min run prunes instead, so it retries only briefly and never fails the
 * job over rotation.
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

const { repoOwnerName, checkReachable } = require('./lib/gh-compare-check');
const { parseLedgerLines, serializeEntries, selectEntriesInWindow, pruneToWindow } = require('./lib/push-ledger');
const { readLedger, writeLedger } = require('./lib/push-ledger-store');

// Pruning is best-effort: a lost CAS race just means the next 20-min run
// prunes instead, so a short retry budget is plenty.
const PRUNE_ATTEMPTS = 3;

// push-retry-failures branch: NO revert-detection needed here (unlike the
// push-ledger success stream above) — a failure record has no "did it land"
// question to re-verify, it's just diagnostic history. This reuses this
// SAME script/cron (task: push-retry-failure telemetry, 2026-08-23,
// plan-review finding: 3 independent reviewers flagged that a durable
// branch with a write path and no prune path grows forever) rather than
// standing up a second scheduled workflow for one prune call.
// FAILURE_MAX_AGE_MS: assessPushRetryDeadman() (scripts/lib/push-retry-
// deadman.js) only ever reads the trailing 7 days; keep a wider buffer (30d)
// so a brief digest-consumer outage doesn't lose entries it would have
// wanted, without growing the branch unboundedly.
const FAILURE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function pruneFailureLedger() {
  const cwd = process.cwd();
  let read;
  try {
    read = readLedger(cwd, { branch: 'push-retry-failures', file: 'failures.jsonl' });
  } catch (err) {
    console.error(`check-push-ledger: push-retry-failures read failed, skipping prune this run: ${err.message}`);
    return;
  }
  if (read.fetchFailed || !read.content) {
    // Absent (nothing has ever failed and been recorded yet) or a transient
    // fetch error — either way, nothing to prune this run.
    return;
  }
  const entries = parseLedgerLines(read.content, ['reason', 'ts']);
  const nowMs = Date.now();
  const kept = pruneToWindow(entries, { nowMs, maxAgeMs: FAILURE_MAX_AGE_MS });
  if (kept.length === entries.length) return; // nothing aged out
  let state = { tip: read.tip, entries: kept, before: entries.length };
  for (let attempt = 1; attempt <= PRUNE_ATTEMPTS; attempt++) {
    try {
      writeLedger(cwd, serializeEntries(state.entries), state.tip, { branch: 'push-retry-failures', file: 'failures.jsonl' });
      console.log(`check-push-ledger: pruned push-retry-failures from ${state.before} to ${state.entries.length} entries`);
      return;
    } catch (err) {
      console.error(`check-push-ledger: push-retry-failures prune attempt ${attempt} failed (${err.message.split('\n')[0]})`);
      if (attempt === PRUNE_ATTEMPTS) {
        console.error('check-push-ledger: leaving push-retry-failures prune to the next scheduled run');
        return;
      }
      const reread = readLedger(cwd, { branch: 'push-retry-failures', file: 'failures.jsonl' });
      const rereadEntries = parseLedgerLines(reread.content, ['reason', 'ts']);
      state = {
        tip: reread.tip,
        entries: pruneToWindow(rereadEntries, { nowMs: Date.now(), maxAgeMs: FAILURE_MAX_AGE_MS }),
        before: rereadEntries.length,
      };
    }
  }
}

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

  const cwd = process.cwd();
  const { tip, content, fetchFailed } = readLedger(cwd);
  if (fetchFailed) {
    // NOT the branch-absent case — a network/auth/timeout failure fetching
    // the ledger branch. Exiting 0 here would silently disable the sole
    // CI-side revert-detection arm (this script's own header contract), so
    // fail the run and let the workflow's notify-failure surface it.
    console.error('check-push-ledger: fetching the push-ledger branch FAILED (not branch-absent) — failing the run so the outage is visible');
    process.exit(1);
  }
  if (!content) {
    console.log('check-push-ledger: no ledger on the push-ledger branch yet — nothing to check');
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
  // Written back through the store's CAS: if a concurrent recorder wins the
  // race, re-read (picking up its new entry) and re-prune; give up quietly
  // after a few tries — the next scheduled run prunes instead.
  // Outage guard (ship-check adversarial finding): if every due entry's
  // compare-API check failed this run, don't rotate anything out — pruning
  // during an API outage would permanently discard entries that were never
  // successfully checked even once. The next run (20 min later) prunes.
  const apiOutage = dueEntries.length > 0 && checkedCount === 0 && skippedCount > 0;
  if (apiOutage) {
    console.error('check-push-ledger: every due compare check failed this run — skipping prune to preserve unchecked evidence for the next run');
  }
  const keptEntries = pruneToWindow(allEntries, { nowMs, maxAgeMs: MAX_AGE_MS });
  if (!apiOutage && keptEntries.length !== allEntries.length) {
    let pruneState = { tip, entries: keptEntries, before: allEntries.length };
    for (let attempt = 1; attempt <= PRUNE_ATTEMPTS; attempt++) {
      try {
        writeLedger(cwd, serializeEntries(pruneState.entries), pruneState.tip);
        console.log(`check-push-ledger: pruned ledger from ${pruneState.before} to ${pruneState.entries.length} entries`);
        break;
      } catch (err) {
        console.error(`check-push-ledger: prune attempt ${attempt} failed (${err.message.split('\n')[0]})`);
        if (attempt === PRUNE_ATTEMPTS) {
          console.error('check-push-ledger: leaving prune to the next scheduled run');
          break;
        }
        const reread = readLedger(cwd);
        const rereadEntries = parseLedgerLines(reread.content);
        pruneState = {
          tip: reread.tip,
          entries: pruneToWindow(rereadEntries, { nowMs: Date.now(), maxAgeMs: MAX_AGE_MS }),
          before: rereadEntries.length,
        };
      }
    }
  }

  console.log(`check-push-ledger: done — checked ${checkedCount}, flagged ${flaggedCount}, skipped ${skippedCount}`);

  // Unrelated branch, same cron slot (task: push-retry-failure telemetry) —
  // see pruneFailureLedger()'s own header for why this rides here rather
  // than a dedicated workflow. Never allowed to fail this job: a prune miss
  // just means the branch stays one entry bigger until the next run.
  try {
    await pruneFailureLedger();
  } catch (err) {
    console.error(`check-push-ledger: push-retry-failures prune crashed (non-fatal): ${err.message}`);
  }
}

main().catch(err => {
  console.error(`check-push-ledger: fatal: ${err.message}`);
  process.exit(1); // NOT fail-open — this is the sole CI-side mitigation for the #668/#619 revert class
});
