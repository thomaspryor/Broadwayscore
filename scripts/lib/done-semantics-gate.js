/**
 * done-semantics-gate.js — may THIS issue transition to Done right now?
 *
 * Phase 2 (BRO-379). Task #695's autonomous recheck found 56 of 143 (39%) of
 * Notion cards marked Done failed their own acceptance check the very next
 * day — "Done" was a claim by whoever closed the card, never verified.
 * Phase 1 (task #1003, scripts/lib/close-time-verify.js) RE-RUNS a recorded
 * command when one exists, but fails OPEN when nothing was recorded: a card
 * with no dispatch-ledger entry still closes unchecked. This gate flips that
 * default. A Done transition is REFUSED unless the issue carries evidence of
 * one of the two shapes "done" can take:
 *
 *   (a) code — a PR reference recorded as merged AND deployed AND with its
 *       post-deploy check passed.
 *   (b) ops  — a safe-form verification command recorded on the issue, the
 *       same shape scripts/autonomous-acceptance-recheck.js re-runs nightly
 *       against a fresh checkout of origin/main.
 *
 * The ops half is not a second implementation of "what counts as a safe,
 * re-runnable command" — it calls autonomous-verify-cmd.js's extractVerifyCmd
 * with autonomous-triage-core.js's isSafeCheckCommand, the exact pair
 * verify-gate.js and close-time-verify.js already use, so a form that widens
 * or narrows there (e.g. the SAFE_CHECK_FORMS edits history shows) changes
 * this gate too instead of drifting a fourth copy (CLAUDE.md rule 15).
 *
 * Pure module: no fs, no exec, no network, no Linear/Notion client. Callers
 * supply the PR-reference fields and/or the free-text notes to check; this
 * file only decides.
 */

'use strict';

const { isSafeCheckCommand } = require('./autonomous-triage-core.js');
const { extractVerifyCmd } = require('./autonomous-verify-cmd.js');

const VERDICTS = {
  PR_MERGED_DEPLOYED_CHECKED: 'pr-merged-deployed-checked',
  VERIFY_CMD_RECORDED: 'verify-cmd-recorded',
  BLOCKED_NO_EVIDENCE: 'no-done-evidence',
};

/**
 * @param {{merged?:boolean, deployed?:boolean, checked?:boolean}|null|undefined} prRef
 * @returns {boolean}
 */
function isMergedDeployedChecked(prRef) {
  return !!(prRef && prRef.merged === true && prRef.deployed === true && prRef.checked === true);
}

/**
 * @param {{prRef?:{merged?:boolean,deployed?:boolean,checked?:boolean}|null, notes?:string}} issue
 * @returns {{allowed:boolean, verdict:string, cmd:string|null, reason:string}}
 *   allowed=true means this issue may transition to Done right now. reason is
 *   a human-readable explanation either way — the evidence found when
 *   allowed, or why none of the two accepted shapes was present when refused.
 */
function evaluateDoneTransition({ prRef = null, notes = '' } = {}) {
  if (isMergedDeployedChecked(prRef)) {
    return {
      allowed: true,
      verdict: VERDICTS.PR_MERGED_DEPLOYED_CHECKED,
      cmd: null,
      reason: 'PR recorded as merged, deployed, and post-deploy-checked',
    };
  }

  const { cmd, reason: extractReason } = extractVerifyCmd(notes, isSafeCheckCommand);
  if (cmd) {
    return {
      allowed: true,
      verdict: VERDICTS.VERIFY_CMD_RECORDED,
      cmd,
      reason: `safe-form verification command recorded: \`${cmd}\``,
    };
  }

  const prProblem = prRef
    ? `PR reference present but not merged+deployed+checked (merged=${!!prRef.merged}, deployed=${!!prRef.deployed}, checked=${!!prRef.checked})`
    : 'no PR reference recorded';
  return {
    allowed: false,
    verdict: VERDICTS.BLOCKED_NO_EVIDENCE,
    cmd: null,
    reason: `cannot transition to Done: ${prProblem}, and no safe-form verification command recorded ` +
      `(${extractReason || 'no acceptance criteria found'})`,
  };
}

module.exports = { evaluateDoneTransition, isMergedDeployedChecked, VERDICTS };
