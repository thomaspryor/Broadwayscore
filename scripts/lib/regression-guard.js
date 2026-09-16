/**
 * Pure decision logic for rebuild-all-reviews.js's review-count regression
 * guard (BRO-2276). Before this, the guard only ever warned and proceeded
 * with the write, even at 99%+ loss, with zero local-vs-CI awareness. A
 * cloud-bootstrapped worktree whose data/review-texts is a stub/partial
 * checkout (not the full private-repo clone) could silently overwrite the
 * real, symlinked reviews.json with a near-empty file (BRO-749, 2026-08-21).
 *
 * CI runs already check out a fresh, full review-texts clone every time, so
 * a large drop there is a genuine content regression worth surfacing loudly
 * but not worth hard-failing the run over (pre-deploy-check.js's 3% gate is
 * the actual publish-blocking backstop). Locally, a drop this large is far
 * more likely to mean "wrong/incomplete checkout" than "the data really
 * regressed" — so it's refused outright unless the caller opts in.
 */

const WARN_THRESHOLD_PCT = 2.0;
const LOCAL_HARD_BLOCK_PCT = 50.0;

// Broad CI||GITHUB_ACTIONS check, same idiom as scripts/lib/owner-alert-router.js's
// isCIExecution() (not exported there, so re-implemented here rather than
// reaching into an unrelated module for a one-line check).
function isRunningInCI(env = process.env) {
  return !!(env.CI || env.GITHUB_ACTIONS);
}

/**
 * @param {object} params
 * @param {number} params.existingCount - reviews.json review count before this rebuild
 * @param {number} params.newCount - review count the rebuild just produced
 * @param {boolean} params.forceWrite - --force-write flag; always overrides the block
 * @param {boolean} params.isCI - result of isRunningInCI()
 * @returns {{action: 'ok'|'warn'|'warn-suppressed'|'block', lost: number, pctLost: number}}
 */
function evaluateReviewCountRegression({ existingCount, newCount, forceWrite, isCI }) {
  if (!(existingCount > 0)) return { action: 'ok', lost: 0, pctLost: 0 };
  const lost = existingCount - newCount;
  if (!(lost > 0)) return { action: 'ok', lost, pctLost: 0 };

  const pctLost = parseFloat((lost / existingCount * 100).toFixed(1));
  if (pctLost <= WARN_THRESHOLD_PCT) return { action: 'ok', lost, pctLost };
  if (forceWrite) return { action: 'warn-suppressed', lost, pctLost };
  if (!isCI && pctLost > LOCAL_HARD_BLOCK_PCT) return { action: 'block', lost, pctLost };
  return { action: 'warn', lost, pctLost };
}

module.exports = {
  evaluateReviewCountRegression,
  isRunningInCI,
  WARN_THRESHOLD_PCT,
  LOCAL_HARD_BLOCK_PCT,
};
