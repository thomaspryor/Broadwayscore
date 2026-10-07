/**
 * gh-compare-check.js — shared GitHub compare-API reachability check.
 *
 * Extracted from verify-merge-landed.js (task #668) so the CI-side ledger
 * checker (task #677, check-push-ledger.js) doesn't hand-roll a second copy
 * of the same "is this sha still reachable from origin's tip" logic. Both
 * mitigations exist for the same underlying failure class (a push verified
 * at push-time, then silently reverted minutes later by a concurrent
 * operation) — #668 covers local worktree-session merges, #677 covers CI
 * pushes through push-with-retry.sh. Server-side compare is ground truth;
 * local git log/merge-base state proved untrustworthy mid-incident (#668).
 */
'use strict';

const { execFileSync } = require('child_process');

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

function repoOwnerName() {
  let url;
  try {
    url = sh('git', ['remote', 'get-url', 'origin']);
  } catch {
    return null;
  }
  const m = url.match(/[/:]([^/]+)\/([^/]+?)(\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// { ok: true, status } if sha is still reachable from branch's current tip,
// { ok: false, status } if the compare says it's fallen off, or
// { ok: null, error } if the check itself couldn't run (caller fails open).
function checkReachable(owner, repo, sha, branch) {
  let status;
  try {
    // --jq .status: the compare payload includes a full commits+files diff
    // that can run into MBs for a large gap (observed ENOBUFS against
    // execFileSync's default buffer on a 50-commit-back test compare on this
    // repo) — having gh filter server-side means we only ever capture the
    // one field we need, regardless of how big the underlying diff is.
    status = sh('gh', ['api', `repos/${owner}/${repo}/compare/${sha}...${branch}`, '--jq', '.status']);
  } catch (err) {
    return { ok: null, error: err.message };
  }
  // "identical" (sha IS branch tip) or "ahead" (branch moved past sha, sha
  // still an ancestor) both mean the commit survived. "behind"/"diverged"
  // mean sha is no longer reachable from branch's tip.
  return { ok: status === 'identical' || status === 'ahead', status };
}

module.exports = { repoOwnerName, checkReachable };
