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
 * re-runnable command" — it calls verify-gate.js's evaluateVerifiability, the
 * exact function scripts/linear-next.js's dispatch gate uses, so a form that
 * widens or narrows there (e.g. the SAFE_CHECK_FORMS edits history shows)
 * changes this gate too instead of drifting a fourth copy (CLAUDE.md rule
 * 15).
 *
 * BRO-3155: evaluateVerifiability also carries the dispatch gate's
 * newest-first-per-document precedence — an optional `comments` array
 * (oldest first) is walked newest-to-oldest, and the first document (a
 * comment, or the description itself) that arms wins outright rather than
 * being merged into one candidate pool with the rest. Before this fix, this
 * gate joined description+comments into a single string and ran
 * extractVerifyCmd over the merged text — which pooled every candidate from
 * every document and re-ranked them by specificity, so a comment posted to
 * CORRECT a broken description command could lose to the original
 * broken-but-still-safe-form command, since both landed in the same pool
 * with no notion of which was newer. The dispatch gate (linear-next.js) got
 * this precedence in BRO-2796; this Done gate parsed the same acceptance
 * block but never got the fix, so a comment-fixed card could dispatch but
 * could never close.
 *
 * Pure module: no fs, no exec, no network, no Linear/Notion client. Callers
 * supply the PR-reference fields and/or the free-text notes/comments to
 * check; this file only decides.
 */

'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');

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
 * @param {{prRef?:{merged?:boolean,deployed?:boolean,checked?:boolean}|null, notes?:string, comments?:string[]}} issue
 *   `notes` is the issue's own description. `comments` (optional, oldest
 *   first — same contract as evaluateVerifiability/sortedCommentBodies) are
 *   evaluated newest-first ahead of `notes` for the ops-evidence command,
 *   so a corrected VERIFY line/command posted as a later comment supersedes
 *   a broken one in the description instead of being pooled with it.
 * @returns {{allowed:boolean, verdict:string, cmd:string|null, reason:string}}
 *   allowed=true means this issue may transition to Done right now. reason is
 *   a human-readable explanation either way — the evidence found when
 *   allowed, or why none of the two accepted shapes was present when refused.
 */
function evaluateDoneTransition({ prRef = null, notes = '', comments = [] } = {}) {
  if (isMergedDeployedChecked(prRef)) {
    return {
      allowed: true,
      verdict: VERDICTS.PR_MERGED_DEPLOYED_CHECKED,
      cmd: null,
      reason: 'PR recorded as merged, deployed, and post-deploy-checked',
    };
  }

  const { cmd, reason: extractReason, ownerJudgment } = evaluateVerifiability(notes, comments);
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
  // evaluateVerifiability short-circuits on an armed owner-judgment marker
  // with cmd:null, reason:null (it exists to ARM DISPATCH, which needs no
  // command for that marker) — so extractReason is null here even though a
  // marker WAS found. Left as `no acceptance criteria found`, an operator
  // who wrote "VERIFY: owner-judgment" and got refused would read that as
  // "the gate never saw my acceptance criteria at all", when the real
  // answer is narrower: it saw the marker and this gate (unlike dispatch)
  // does not accept it alone (see the "bare owner-judgment marker" test in
  // done-semantics-gate.test.mjs) — an artifact must actually be checked.
  const extractionProblem = extractReason
    ? extractReason
    : ownerJudgment
      ? 'a VERIFY: owner-judgment marker is present, but this gate (unlike dispatch) requires either a runnable command or PR evidence — an owner-judgment declaration alone is not done-evidence'
      : 'no acceptance criteria found';
  return {
    allowed: false,
    verdict: VERDICTS.BLOCKED_NO_EVIDENCE,
    cmd: null,
    reason: `cannot transition to Done: ${prProblem}, and no safe-form verification command recorded ` +
      `(${extractionProblem})`,
  };
}

module.exports = { evaluateDoneTransition, isMergedDeployedChecked, VERDICTS };
