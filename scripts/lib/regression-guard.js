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

// Broad CI||GITHUB_ACTIONS check, mirroring scripts/lib/push-ledger.js's
// isGithubActionsRunner()-style strict string match rather than a bare
// truthiness check — `CI=false`/`GITHUB_ACTIONS=0` are non-empty strings and
// therefore truthy in JS, which would silently misclassify a local run as CI
// and skip the hard block entirely.
function isRunningInCI(env = process.env) {
  return env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true';
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

  // Compare against the unrounded ratio so a loss like 50.04% can't round
  // down to a displayed "50.0%" and slip past the > LOCAL_HARD_BLOCK_PCT
  // check; pctLost itself stays rounded to 1dp purely for display/logging.
  const rawPctLost = (lost / existingCount) * 100;
  const pctLost = parseFloat(rawPctLost.toFixed(1));
  if (rawPctLost <= WARN_THRESHOLD_PCT) return { action: 'ok', lost, pctLost };
  if (forceWrite) return { action: 'warn-suppressed', lost, pctLost };
  if (!isCI && rawPctLost > LOCAL_HARD_BLOCK_PCT) return { action: 'block', lost, pctLost };
  return { action: 'warn', lost, pctLost };
}

module.exports = {
  evaluateReviewCountRegression,
  isRunningInCI,
  WARN_THRESHOLD_PCT,
  LOCAL_HARD_BLOCK_PCT,
};
