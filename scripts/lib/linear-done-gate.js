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
 * fetches `comments(first: 20) { nodes { body } }` on every call (ship-check
 * finding on the first version of this gate, which read description +
 * in-flight commentText only and would silently re-refuse a close whose
 * evidence was sitting right there in issue history) — the caller passes
 * those bodies through unchanged, this file does no I/O of its own.
 */

'use strict';

const { evaluateDoneTransition } = require('./done-semantics-gate.js');
const { extractPrRef } = require('./linear-pr-evidence.js');

/**
 * @param {{targetStateType:string, description?:string, commentText?:string, existingComments?:string[]}} args
 * @returns {{gated:false}|({gated:true}&ReturnType<typeof evaluateDoneTransition>)}
 *   gated:false means this call is not moving into a completed-type state at
 *   all, so the gate has nothing to say — evaluateDoneTransition is not even
 *   called. When gated:true, the rest of the object is exactly
 *   evaluateDoneTransition's return shape (allowed/verdict/cmd/reason).
 */
function checkLinearDoneTransition({ targetStateType, description = '', commentText = '', existingComments = [] } = {}) {
  if (targetStateType !== 'completed') return { gated: false };

  const combinedText = [description, ...(Array.isArray(existingComments) ? existingComments : []), commentText]
    .filter(Boolean)
    .join('\n');
  const prRef = extractPrRef(combinedText);
  const result = evaluateDoneTransition({ prRef, notes: combinedText });
  return { gated: true, ...result };
}

module.exports = { checkLinearDoneTransition };
