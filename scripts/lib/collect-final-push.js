'use strict';
/**
 * BRO-7117: whether collect-review-texts.js pushes its public-repo checkpoint
 * commit to main right now.
 *
 * A forced (end-of-run) push can run minutes past push-with-retry's deadline
 * (rebase CPU, survival fetches, API fallback), and in opening-night-poller.yml
 * it starts after the 540s soft budget inside a 12-min step: run 44998053829
 * hit the budget at 07:48:14 and was killed mid-push at 07:50:56. A caller
 * that pushes HEAD itself in a later, separately bounded step sets
 * SKIP_FINAL_MAIN_PUSH=1; the local commit stays and that step pushes it.
 * Interval pushes during the run are unchanged.
 */
function shouldPushMainCheckpoint({ forcePush, intervalDue, hasPendingCommit, env = process.env }) {
  if (!hasPendingCommit) return { push: false, reason: 'nothing-pending' };
  if (forcePush && String((env && env.SKIP_FINAL_MAIN_PUSH) || '') === '1') return { push: false, reason: 'final-push-left-to-workflow' };
  if (forcePush || intervalDue) return { push: true, reason: forcePush ? 'forced' : 'interval' };
  return { push: false, reason: 'interval-not-due' };
}

module.exports = { shouldPushMainCheckpoint };
