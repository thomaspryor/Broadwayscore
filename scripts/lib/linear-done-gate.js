/**
 * linear-done-gate.js — the enforcement point for BRO-457: may THIS
 * `linear-brain.js update --state <name>` call actually land a
 * completed-type state?
 *
 * Pure glue, no I/O. scripts/linear-brain.js's update command supplies the
 * target state's `type` (from Linear's own team.states, already fetched
 * during resolveState) plus the issue's description and any --comment text
 * being posted in the same call, and this file wires them through
 * done-semantics-gate.js's evaluateDoneTransition() — the module BRO-379
 * built and unit-tested but never called from anywhere (that's the drift
 * risk this ticket exists to close).
 *
 * Only gates a transition INTO a `type: 'completed'` state. Linear's state
 * types are per-team but stable across renames (linear-cap-policy.js and
 * linear-dispatch.js already key on `stateType === 'completed'` for the same
 * reason) — matching on the literal name "Done" would silently stop gating
 * the moment a team renamed that column, same trap linear-state-resolve.js's
 * header explains for the state-name lookup itself.
 *
 * commentText is folded in because the established close flow (both
 * notion-brain.js and this file's own caller) posts the closing comment and
 * THEN moves the state, in the same CLI invocation — a closer recording
 * `--comment "PR-EVIDENCE: merged deployed checked (url)"` together with
 * `--state Done` must have that comment count as evidence in the same call,
 * not require a second round-trip that reads it back from Linear first.
 *
 * existingComments is separate from commentText for the same reason: evidence
 * recorded on the issue in an EARLIER call (e.g. an operator posts
 * "PR-EVIDENCE: ..." today, comes back tomorrow to move the state with no
 * --comment at all) must still count. linear-client.js's getIssue() already
 * fetches `comments(first: 50) { nodes { body } }` on every call (20 before
 * BRO-2543 widened the shared query; note this gate got slightly MORE
 * permissive as a side effect, since it now scans 30 more comments of the
 * same issue for the evidence it is looking for) (ship-check
 * finding on the first version of this gate, which read description +
 * in-flight commentText only and would silently re-refuse a close whose
 * evidence was sitting right there in issue history) — the caller MUST pass
 * those bodies pre-sorted OLDEST FIRST by createdAt (e.g. via
 * linear-dispatch.js's sortedCommentBodies(issue) — Linear's comments
 * connection is not createdAt-ascending by default, same gotcha
 * sortedCommentBodies's own header documents), this file does no I/O of its
 * own.
 *
 * BRO-3155: description+comments used to be flattened into one string and
 * handed to evaluateDoneTransition as `notes`, which pooled every acceptance
 * candidate from every document instead of letting a later comment supersede
 * an earlier broken one. Kept separate now (`notes` vs `comments`) so
 * evaluateDoneTransition can apply evaluateVerifiability's newest-first
 * precedence — the same one the dispatch gate (linear-next.js) already gets.
 * extractPrRef still scans the flattened, chronologically-ordered text: its
 * own "last marker wins" rule already gives newest-wins semantics as long as
 * the documents it sees are in true chronological order, which they are now
 * that existingComments is contractually sorted.
 */

'use strict';

const { evaluateDoneTransition, isMergedDeployedChecked } = require('./done-semantics-gate.js');
const { extractPrRef } = require('./linear-pr-evidence.js');

/**
 * @param {{targetStateType:string, description?:string, commentText?:string, existingComments?:string[],
 *          verifyEvidence?: (prRef:object) => {verified:boolean|null, reason:string}}} args
 *   existingComments must be oldest-first (see file header).
 *   verifyEvidence: does the cited commit/PR actually sit on origin/main?
 *   Built by done-evidence-verify.js makeVerifyEvidence() and wired in by
 *   BOTH CLIs (linear-brain.js update, linear-session.js report). This file
 *   stays pure: with no verifier injected, a full PR-EVIDENCE claim is
 *   UNVERIFIED and refused — never silently trusted. Before this existed the
 *   three words "merged deployed checked" closed an issue on their own, and
 *   dozens of Done cards whose work never landed were found by hand (2026-09).
 * @returns {{gated:false}|({gated:true}&ReturnType<typeof evaluateDoneTransition>&{verification?:object})}
 *   gated:false means this call is not moving into a completed-type state at
 *   all, so the gate has nothing to say — evaluateDoneTransition is not even
 *   called. When gated:true, the rest of the object is exactly
 *   evaluateDoneTransition's return shape (allowed/verdict/cmd/reason), plus
 *   `verification` (the verifier's own result) when PR evidence was checked.
 */
function checkLinearDoneTransition({ targetStateType, description = '', commentText = '', existingComments = [], verifyEvidence } = {}) {
  if (targetStateType !== 'completed') return { gated: false };

  const comments = [...(Array.isArray(existingComments) ? existingComments : []), commentText].filter(Boolean);
  const combinedText = [description, ...comments].filter(Boolean).join('\n');
  const prRef = extractPrRef(combinedText);

  if (isMergedDeployedChecked(prRef)) {
    const verification = typeof verifyEvidence === 'function'
      ? verifyEvidence(prRef)
      : { verified: null, reason: 'no evidence verifier wired into this call, so the cited commit/PR cannot be checked against origin/main' };
    if (!verification || verification.verified !== true) {
      // The PR claim is out. A runnable acceptance command is still real
      // evidence in its own right (the nightly recheck re-runs it against a
      // fresh main), so evaluate that path with the rejected claim EXCLUDED —
      // otherwise the refusal below would tell the operator to add a VERIFY:
      // line that this same branch would then never look at.
      const viaCmd = evaluateDoneTransition({ prRef: null, notes: description, comments });
      if (viaCmd.allowed) {
        // Allowed on the command's strength — but a PROVEN-false PR claim
        // sitting next to it is worth saying out loud, not swallowing.
        // Warn on ANY ref proven not-on-main, not only when the overall verdict
        // is false — one unresolvable sibling token would otherwise turn a
        // proven-false claim into a silent unknown.
        const provenFalse = verification && (verification.verified === false
          || (Array.isArray(verification.checked) && verification.checked.some(c => c && c.onMain === false)));
        const warning = provenFalse
          ? `PR-EVIDENCE on this issue cites a commit/PR that is NOT on origin/main (${verification.reason}); Done is allowed only because a VERIFY: command is recorded (${viaCmd.cmd}).`
          : null;
        return { gated: true, ...viaCmd, verification, ...(warning ? { warning } : {}) };
      }
      const definite = verification && verification.verified === false;
      return {
        gated: true,
        allowed: false,
        verdict: definite ? 'pr-evidence-not-on-main' : 'pr-evidence-unverified',
        cmd: null,
        reason:
          `PR-EVIDENCE was not confirmed on origin/main: ${verification ? verification.reason : 'verifier returned nothing'}. ` +
          'Post a new comment citing the commit that is actually on origin/main, exactly like this: ' +
          'PR-EVIDENCE: merged deployed checked (https://github.com/<owner>/<repo>/commit/<sha>) ' +
          '— a bare SHA of at least 11 hex characters (`git log --abbrev=11`) or a merged PR URL also works; 7-char SHAs are not accepted bare. ' +
          'Or add a line `VERIFY: node --test <the test file this work added>`. ' +
          'Or, as the owner, --force "<reason>".',
        verification,
      };
    }
    const result = evaluateDoneTransition({ prRef, notes: description, comments });
    return { gated: true, ...result, verification };
  }

  const result = evaluateDoneTransition({ prRef, notes: description, comments });
  return { gated: true, ...result };
}

module.exports = { checkLinearDoneTransition };
