'use strict';
// scripts/lib/mac-applied-heartbeat.js — tell the cloud which origin/main sha
// the Mac checkout last applied (BRO-5085; BRO-4638 step 4).
//
// com.broadwayscore.checkout-sync fast-forwards ~/Broadwayscore every 30 min,
// but when it wedges (an untracked file at a path origin adds blocks ff-only,
// scripts/lib/sync-audit-decision.js) only the Mac's own morning digest knew.
// Cloud sessions could not tell. After each successful sync this posts a
// commit status on the applied origin/main sha (not HEAD, which can be a
// local-only ledger commit):
//   context     mac/checkout-sync-applied
//   state       success
//   description applied <ISO timestamp>
// Readable from the cloud with the GitHub commit-status API, needs no land and
// triggers no workflow. Read it as two rules:
//   stuck: origin/main's head is over ~1h old and has no such status while an
//          older commit does (sync can't apply new commits);
//   dead:  the newest such status is over ~7h old (REPOST_MS + one tick), even
//          on a quiet day with no new commits.
// Retirements done by the reconciler post their own context,
// mac/launchd-retire (failure = a partial retirement to fix by hand).
//
// Posted only when the applied sha changed or the last post is older than
// REPOST_MS, so a quiet day costs a handful of API calls, not 48.

const STATUS_CONTEXT = 'mac/checkout-sync-applied';
const REPOST_MS = 6 * 3600e3;

function shouldPost({ sha, last, now = new Date() }) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return false;
  if (!last || last.sha !== sha) return true;
  const at = Date.parse(last.at);
  return !Number.isFinite(at) || now.getTime() - at >= REPOST_MS;
}

function statusArgs({ repo, sha, now = new Date() }) {
  return [
    'api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', 'state=success',
    '-f', `context=${STATUS_CONTEXT}`,
    '-f', `description=applied ${now.toISOString()}`,
  ];
}

module.exports = { STATUS_CONTEXT, REPOST_MS, shouldPost, statusArgs };
