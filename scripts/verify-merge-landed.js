#!/usr/bin/env node
/**
 * verify-merge-landed.js — delayed re-verification that a merge pushed by
 * merge-worktree-to-main.sh is STILL reachable from origin's tip minutes
 * later (task #668). merge-worktree-to-main.sh's own verify step (card #546)
 * only proves the push landed at the INSTANT it ran — the #668 incident's
 * merge commit passed that check, then vanished from origin ~10-15 min
 * later when some other concurrent operation moved origin/main's tip
 * backward. A one-shot verify can't see a race that resolves after it exits;
 * this script re-checks on a delay, from a background process the caller
 * doesn't have to wait on.
 *
 * Uses GitHub's compare API as ground truth (server-side, not local git
 * cache) — the exact method that diagnosed the #668 incident live ("verified
 * via gh api repos/.../contents/... directly — this is the reliable
 * verification method; local git log/git merge-base state proved
 * untrustworthy mid-incident").
 *
 * Usage (fire-and-forget, right after a successful push+verify):
 *   nohup node scripts/verify-merge-landed.js --sha=<mergeSha> --branch=main \
 *     --label="worktree-X -> main" --delays=120,480,900 \
 *     >>data/audit/verify-merge-landed.log 2>&1 &
 *   disown
 *
 * On any failed check: files an 'auto' alert-router card (self-dispatchable
 * — the fix is always "re-run merge-worktree-to-main.sh for the same
 * branch/files") and exits 1. If every delayed check passes, logs success
 * and exits 0. Fails OPEN (exit 0, no alert) if `gh`/the repo remote can't
 * be resolved — this is defense-in-depth on top of the mutex + immediate
 * verify, not the primary safety net.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { repoOwnerName, checkReachable } = require('./lib/gh-compare-check');

const USAGE = `Usage: verify-merge-landed.js --sha=<sha> --branch=<branch> [--label=<label>] [--delays=<sec,sec,...>]

Delayed re-check that a merge pushed by merge-worktree-to-main.sh is still
reachable from origin's tip minutes later (task #668). Intended to be
launched fire-and-forget right after a successful push+verify; see the file
header for the full incident context.`;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function fileAlert(repoInfo, sha, branch, label, status) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router');
    await routeAlert({
      conditionKey: `merge-verify-landed:${branch}:${sha.slice(0, 12)}`,
      title: `origin/${branch} lost a verified merge commit (${label})`,
      disposition: 'auto',
      severity: 'error',
      category: 'Infra',
      description: `merge-worktree-to-main.sh pushed and immediately verified ${sha} on origin/${branch} (${label}), but a delayed re-check via the GitHub compare API found it no longer reachable (status: ${status}). This is the task #668 failure class — some concurrent git operation moved origin/${branch}'s tip backward after the one-shot verify passed.`,
      hint: `Confirm with: gh api repos/${repoInfo.owner}/${repoInfo.repo}/compare/${sha}...${branch}. If still behind/diverged, the branch's commits need to be re-landed — check if the branch ref still exists locally (git branch --list) or recover the commit content via 'git show ${sha}', then re-run scripts/merge-worktree-to-main.sh.`,
      fields: [
        { name: 'sha', value: sha },
        { name: 'branch', value: branch },
        { name: 'compare status', value: status },
        { name: 'label', value: label },
      ],
    });
  } catch (err) {
    console.error(`verify-merge-landed: alert dispatch failed: ${err.message}`);
  }
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));
  const sha = args.sha;
  const branch = args.branch || 'main';
  const label = args.label || `${branch}@${(sha || '').slice(0, 12)}`;
  const delays = (args.delays || '120,480,900')
    .split(',')
    .map(s => parseInt(s, 10) * 1000)
    .filter(n => Number.isFinite(n) && n >= 0);

  if (!sha) {
    console.error('verify-merge-landed: --sha is required — skipping (fail open)');
    process.exit(0);
  }

  const repoInfo = repoOwnerName();
  if (!repoInfo) {
    console.error('verify-merge-landed: could not resolve owner/repo from origin remote — skipping (fail open)');
    process.exit(0);
  }

  let ranAtLeastOnce = false;
  for (const delayMs of delays) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const result = checkReachable(repoInfo.owner, repoInfo.repo, sha, branch);
    if (result.ok === null) {
      console.error(`verify-merge-landed: check skipped at +${Math.round(delayMs / 1000)}s (${result.error}) — will retry at next delay`);
      continue;
    }
    ranAtLeastOnce = true;
    if (result.ok) {
      console.log(`verify-merge-landed: ${label} still reachable from origin/${branch} (compare status: ${result.status}) at +${Math.round(delayMs / 1000)}s`);
      continue;
    }
    console.error(`verify-merge-landed: ${label} — ${sha} is NO LONGER reachable from origin/${branch} (compare status: ${result.status}) at +${Math.round(delayMs / 1000)}s — filing alert`);
    await fileAlert(repoInfo, sha, branch, label, result.status);
    process.exit(1);
  }
  // Don't claim success if `gh`/network never let a single check actually run —
  // that's an unverified run, not a passed one, and logging it as "survived"
  // would mask the exact silent-failure-mode this script exists to avoid.
  if (!ranAtLeastOnce) {
    console.error(`verify-merge-landed: ${label} — every delayed check was skipped (gh/network unavailable throughout) — could NOT confirm survival, no alert filed (fail open)`);
    process.exit(0);
  }
  console.log(`verify-merge-landed: ${label} survived all ${delays.length} delayed check(s) — done`);
  process.exit(0);
}

main().catch(err => {
  console.error(`verify-merge-landed: fatal: ${err.message}`);
  process.exit(0); // fail open — best-effort background check, not the primary safety net
});
