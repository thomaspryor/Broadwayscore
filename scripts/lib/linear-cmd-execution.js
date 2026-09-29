/**
 * linear-cmd-execution.js — actually RUN a Linear issue's recorded VERIFY
 * command against a fresh origin/main checkout, for linear-done-gate.js.
 *
 * BRO-3885: the Notion Done path never closed a card on a VERIFY: command's
 * shape alone — scripts/lib/close-time-verify.js (notion-brain.js's
 * `enforceCloseTimeVerify`) re-runs the command against origin/main before
 * the write. The Notion→Linear migration carried done-semantics-gate.js's
 * SHAPE check (evaluateVerifiability via evaluateDoneTransition) but never
 * wired up the execution half — linear-done-gate.js accepted a runnable-
 * looking command as done-evidence without ever running it. BRO-3471 closed
 * Done twice through exactly that hole: its own stated acceptance command
 * (`node --test scripts/lib/show-score-url-map.test.mjs`) named a file that
 * was never created.
 *
 * This module is the I/O half of that fix, mirroring done-evidence-verify.js's
 * makeVerifyEvidence() shape: a make*() factory that lazy-requires its exec
 * helpers and returns a pure-signature function
 * `(cmd) => {allowed, verdict, reason, ...}`, so linear-done-gate.js itself
 * stays a pure module that only calls what it's handed (tests inject a stub;
 * the CLIs wire in the real thing built here).
 *
 * Reused, not reinvented (CLAUDE.md §15): the checkout + run is
 * acceptance-check-core.js's makeFreshCheckout/runVerify — the exact
 * function notion-brain.js's close-time check and the nightly recheck both
 * already use, including its exit-3/timeout/missingPath fail-open semantics.
 * The pass/fail/unverifiable INTERPRETATION is close-time-verify.js's
 * decideClose() — the same decision Notion cards get. Only the final
 * allow/refuse mapping below is deliberately STRICTER than decideClose's own
 * default posture: decideClose fails OPEN on 'unverifiable' (a command that
 * cannot run yet, closes anyway with a warning) because for a Notion card
 * that command may never have existed at all and ~90 cards in flight would
 * deadlock on ambiguity. Here the card has ALREADY claimed a runnable
 * command as its Done evidence — an unrunnable command at execution time is
 * not "nothing to check", it is the exact "shape without substance" gap this
 * ticket exists to close, so only a confirmed PASS counts.
 */

'use strict';

const path = require('path');
const { makeFreshCheckout, removeCheckout, runVerify } = require('./acceptance-check-core.js');
const { decideClose, VERDICTS } = require('./close-time-verify.js');

// Matches notion-brain.js's CLOSE_VERIFY_TIMEOUT_MS default: a person or a
// sync loop is synchronously waiting on this, so it must answer in bounded
// time rather than hold a close hostage.
const DEFAULT_TIMEOUT_MS = 90000;

/**
 * @param {{repo?:string, timeoutMs?:number, log?:Function}} [opts]
 * @returns {(cmd:string) => {allowed:boolean, verdict:string, reason:string, notOnMain:boolean, sha:string|null}}
 *   allowed:true means the command was actually executed against a fresh
 *   origin/main checkout and passed. Anything else (fail, unverifiable,
 *   missing path, a checkout/exec error) is allowed:false — a claimed
 *   command that cannot be confirmed to pass is not done-evidence.
 */
function makeVerifyCmdEvidence({ repo = path.join(__dirname, '..', '..'), timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  return function verifyCmdEvidence(cmd) {
    let checkout = null;
    try {
      checkout = makeFreshCheckout({ repo, prefix: 'linear-done-verify-' });
      log(`[linear-cmd-execution] running \`${cmd}\` against origin/main @ ${checkout.sha ? checkout.sha.slice(0, 9) : 'unknown'}…`);
      const verifyResult = runVerify(checkout.wt, cmd, { timeoutMs, prepared: checkout.prepared });
      // A synthetic dispatch record — this call has no dispatch-ledger entry
      // to look up (findCardDispatch is Notion's launch-ledger lookup; the
      // command here comes straight from evaluateDoneTransition's own
      // extraction), but decideClose only reads dispatch.verifyCmd and
      // dispatch.entry's truthiness, both satisfied here.
      const dispatch = {
        verifyCmd: cmd,
        allowUnverifiable: false,
        verifyReason: null,
        taskId: null,
        matchedBy: null,
        entry: { source: 'linear-done-gate' },
      };
      const decision = decideClose({ dispatch, verifyResult });
      const allowed = decision.verdict === VERDICTS.PASS;
      // decideClose's own message is written for ITS fail-open policy — e.g.
      // "`cmd` could not be verified (...) — closing without a verdict" when
      // decision.allowed is true. This caller is stricter (BRO-3885: only a
      // confirmed PASS is done-evidence), so whenever that policy diverges
      // from ours (decision.allowed true but ours is false), decideClose's
      // own wording — the literal word "closing" — would tell the operator
      // the opposite of what just happened, a refusal captioned "closing"
      // (ship-check finding). Built from verifyResult.detail directly rather
      // than decision.message, so that word never leaks through. Every
      // verdict where decideClose ALSO refuses (FAIL, including the
      // missingPath case) already reads correctly as a refusal either way.
      const reason = (!allowed && decision.allowed === true)
        ? `recorded command \`${cmd}\` was not confirmed to pass (${decision.verdict}): ${(verifyResult && verifyResult.detail) || 'no further detail'}`
        : decision.message;
      return {
        allowed,
        verdict: decision.verdict,
        reason,
        notOnMain: decision.notOnMain === true,
        sha: checkout.sha || null,
      };
    } catch (err) {
      const message = String((err && err.message) || err).slice(0, 200);
      log(`[linear-cmd-execution] could not execute \`${cmd}\` against origin/main: ${message}`);
      return {
        allowed: false,
        verdict: 'execution-error',
        reason: `could not execute the recorded command against a fresh origin/main checkout: ${message}`,
        notOnMain: false,
        sha: null,
      };
    } finally {
      removeCheckout(checkout);
    }
  };
}

module.exports = { makeVerifyCmdEvidence };
