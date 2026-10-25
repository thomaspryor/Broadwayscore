'use strict';

// Shared by the CI ledger and local delayed merge verifier. Fetches must stay
// isolated from the caller's checkout, including its refs and shallow boundary.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkReachable } = require('./gh-compare-check');

// BRO-2304: checkReachable() only answers "is entry.sha still an ancestor of
// origin/<branch>'s tip" — the right question for a genuine revert, but blind
// to a different, benign shape push-with-retry.sh's OWN push-time check
// already models (scripts/lib/push-content-survival.js, task #619): a
// conflict-resolution/rebase step can recreate a commit's exact intended
// content under a brand-new SHA ('superseded'). That's expected, not a loss —
// but checkReachable() only ever sees the OLD sha, which is unreachable by
// definition once superseded, so it filed a false alert.
//
// Live case (BRO-2304): commit c10b785d0b4587af0f1d6942ea8b74b5e53ed2b1 was
// verified-pushed, then reported unreachable. Manual investigation found its
// content (a wrap-up-ran Stop-hook gate + test) was never actually lost — the
// identical logical change landed on main under two OTHER shas, both via PRs
// (#692/#708) already merged. But the *literal lines* were NOT a clean
// superset by the time of that later landing — an in-session redesign commit
// had already rewritten the same block, so this exact classifier (verified
// live against the real BRO-2304 shas) still reports 'reverted' for that
// specific case. It's included anyway because it correctly, conservatively
// suppresses the SIMPLER and more common shape — a conflict-resolution/rebase
// step that recreates a commit's content verbatim (or as a pure superset)
// under a brand-new sha — without any risk of masking a genuine revert
// elsewhere: any ambiguity still falls through to the ordinary alert path.
// BRO-2304 itself is closed by deleting the dead source branch (both its PRs
// already merged, no open PR depends on it) — see the Linear card — not by
// this classifier reclassifying that specific historical case.
//
// Rather than reimplement push-content-survival.js's classifier (it already
// has the exemption list, the cheap/deep-check split, and the
// ambiguous-vs-reverted judgment push-with-retry.sh trusts at push time),
// this fetches just enough of the entry's own commit + the branch's current
// tip to hand the SAME CLI the identical question in the delayed context,
// and trusts its verdict. Any fetch/parse failure returns false (the safe
// default) — an unconfirmed case still alerts, never silently suppressed.
//
// Runs in a throwaway scratch clone, NEVER the live job checkout (adversarial
// review finding): check-push-ledger.yml's checkout is shallow (depth-1,
// main-only) and its own LATER "Commit alert state" step runs `git add` /
// `git commit` / push-with-retry.sh against that SAME checkout. This repo has
// a documented history of shallow-fetch fragility exactly there
// (push-with-retry.sh's own incidents #466, #1489, #1723, #394) — fetching
// arbitrary historical shas/branches by depth into that checkout would leave
// extra `.git/shallow` grafts no existing test or incident covers, ahead of a
// step that's already proven sensitive to shallow-boundary state. A fresh
// `git init` + `remote add origin` scratch dir costs one extra `mkdtemp` and
// is torn down in a `finally`, at the price of re-resolving the origin URL
// once per entry — worth it to keep this guard's own footprint at zero risk
// to the checkout the rest of the job depends on.
const PUSH_CONTENT_SURVIVAL_CLI = path.join(__dirname, 'push-content-survival.js');

// Both callers (fetchShaWithParent, fetchBranchTip) always pass a literal
// --depth=N as args[0] — this asserts it at runtime rather than trusting
// that invariant silently, since a future third caller forgetting it would
// otherwise pull this repo's full ~165k-commit history into a job whose
// OWN checkout is fetch-depth:1 (audit-unbounded-fetch.js's own incident
// class; the depth bound lives in the caller's args array, not literally on
// this line, so the static guard can't verify it — unbounded-fetch-ok: depth
// is enforced here at runtime instead).
function gitFetchOrNull(cwd, args) {
  if (!args.some((a) => typeof a === 'string' && a.startsWith('--depth='))) {
    throw new Error(`gitFetchOrNull: refusing an unbounded fetch (no --depth= in ${JSON.stringify(args)})`);
  }
  try {
    // unbounded-fetch-ok: both callers (fetchShaWithParent, fetchBranchTip)
    // pass a literal --depth=N as args[0] — the guard above this line also
    // enforces it at runtime, so this line can never actually run unbounded.
    execFileSync('git', ['fetch', ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
    return execFileSync('git', ['rev-parse', 'FETCH_HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// depth=2: the commit itself plus its immediate parent — enough to diff what
// THIS commit changed without pulling the branch's full history. A root
// commit (no parent) can't be diffed this way; caught below, not thrown.
function fetchShaWithParent(cwd, sha) {
  if (!gitFetchOrNull(cwd, ['--depth=2', 'origin', sha])) return null;
  try {
    return execFileSync('git', ['rev-parse', `${sha}^`], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function fetchBranchTip(cwd, branch) {
  return gitFetchOrNull(cwd, ['--depth=1', 'origin', branch]);
}

/**
 * @param {string} liveRepoCwd the job's own checkout — read-only, used ONLY
 *   to resolve `origin`'s URL. Never fetched into.
 * @param {{sha: string, branch: string}} entry the ledger entry under re-check
 * @returns {boolean} true only when push-content-survival.js's own classifier
 *   finds no genuine revert (survived/unchanged/ambiguous/superseded) between
 *   entry.sha's intended content and origin/<branch>'s current tip. Never
 *   throws — any failure (fetch, parse, classifier crash) is treated as "not
 *   confirmed", so the caller falls through to its ordinary alert path.
 */
function checkContentSurvived(liveRepoCwd, entry) {
  let scratchDir = null;
  try {
    const originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: liveRepoCwd, encoding: 'utf8' }).trim();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-content-survival-'));
    execFileSync('git', ['init', '-q'], { cwd: scratchDir, timeout: 30_000 });
    execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: scratchDir, timeout: 30_000 });

    const parentSha = fetchShaWithParent(scratchDir, entry.sha);
    if (!parentSha) return false;
    const branchTip = fetchBranchTip(scratchDir, entry.branch);
    if (!branchTip) return false;
    execFileSync(process.execPath, [
      PUSH_CONTENT_SURVIVAL_CLI,
      `--before-sha=${entry.sha}`,
      `--base-sha=${parentSha}`,
      `--check-ref=${branchTip}`,
      // ACMT not MT (BRO-2304): no sibling check-post-rebase-survival.js runs
      // at this delayed checkpoint, so Added files must be in scope here too
      // — see push-content-survival.js's own --diff-filter comment.
      '--diff-filter=ACMT',
    ], { cwd: scratchDir, timeout: 30_000 });
    return true; // exit 0 => not a genuine revert (survived/unchanged/ambiguous/superseded/SKIP)
  } catch (err) {
    // Logged for observability (adversarial review finding): without this, a
    // broken fetch mechanism (e.g. GitHub restricting direct-sha fetch, or
    // the object having aged out of dangling-object retention) silently
    // degrades to pre-BRO-2304 behavior — always alerts — with no trail
    // distinguishing that from a genuine revert. classifier exit 1 (reverted)
    // also lands here; its own stdout above already explains itself.
    console.error(`delayed-content-survival: content-survival check inconclusive for ${entry.sha.slice(0, 12)}: ${err.message.split('\n')[0]}`);
    return false; // don't suppress — an unconfirmed case still alerts
  } finally {
    if (scratchDir) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup — a leftover scratch dir in the runner's own
        // /tmp doesn't survive past job end anyway
      }
    }
  }
}

// Preserve unknown compare results so callers keep their existing retry/fail-open
// policy. Only a definitive ancestry failure warrants the two extra fetches.
function checkReachableWithContentFallback(owner, repo, sha, branch, {
  cwd = process.cwd(),
  compare = checkReachable,
  contentCheck = checkContentSurvived,
} = {}) {
  const result = compare(owner, repo, sha, branch);
  if (result.ok !== false) return result;
  if (!contentCheck(cwd, { sha, branch })) return result;
  return { ...result, ok: true, contentSurvived: true };
}

module.exports = {
  checkContentSurvived, fetchShaWithParent, fetchBranchTip,
  checkReachableWithContentFallback,
};
