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

// A person or a sync loop is synchronously waiting on this, so it must answer
// in bounded time rather than hold a close hostage. 180s per run: a full-repo
// `npx tsc --noEmit` takes ~55s on an idle 4-core box, and a timeout reads as
// unverifiable, which this strict gate refuses (BRO-4757).
const DEFAULT_TIMEOUT_MS = 180000;
// One run, no flake retry: runVerify's default (2) re-runs a failing command,
// so the worst case would be 2 x 180s plus checkout, past the 300s spawn caps
// of close-stuck-verified-cards.js and linear-started-zombie-sweep-verify.js,
// which would SIGTERM linear-brain.js mid-gate. A refused close can simply be
// re-run; a killed one leaves its fresh checkout behind.
const VERIFY_ATTEMPTS = 1;

/** spawnSync/execFileSync killed by its own time box (git fetch, worktree add). */
function isCheckoutTimeout(err) {
  return !!err && (err.code === 'ETIMEDOUT' || (!!err.signal && err.status == null) || /\bETIMEDOUT\b/.test(String(err.message || '')));
}

/**
 * BRO-7632: a refusal whose cause is the machine, not the card, should say so
 * and name the way out. Keyed off runVerify's own classification (status
 * 'unverifiable'), never a second regex set. Never fires for missingPath /
 * notOnMain (the BRO-3471 hole: the card's test is not on main, merge first),
 * and a malformed command or an all-skipped test run is a VERIFY-line problem,
 * not an environment one. Advice only: `allowed` is untouched.
 * @returns {string} text to append to the refusal reason ('' when none applies)
 */
function envRefusalHint(verifyResult, decision) {
  if (!verifyResult || verifyResult.status !== 'unverifiable') return '';
  if (verifyResult.missingPath || (decision && decision.notOnMain)) return '';
  const detail = String(verifyResult.detail || '');
  if (/safe-form re-validation|ran no passing tests/.test(detail)) {
    return ' This is a problem with the recorded VERIFY line (malformed, or its tests all skipped), not the environment: write a VERIFY command that runs and passes real tests.';
  }
  const timeout = /^check killed by .*\(timeout/.test(detail);
  const cause = verifyResult.envCause ? ` (${verifyResult.envCause})` : '';
  return timeout
    ? ' The check ran out of time on this machine, which is not a verdict on the card: re-run the Done update.'
    : ` This looks like an environment problem${cause}, not a verdict on the card: re-run the Done update, or if the work is merged and deployed record \`PR-EVIDENCE: merged deployed checked (<url>)\`.`;
}

/**
 * BRO-7632: a `VERIFY:` line whose command still holds a template placeholder
 * (BRO-N, <id>, XXX, TBD, ...) can never pass, and the Done gate then refuses
 * the card for a reason that is not about the work. Call on NEW text only
 * (a create's notes or an update's own comment), never on old comments.
 * @returns {string|null} the offending VERIFY line, or null
 */
function findPlaceholderVerify(text) {
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?VERIFY(?:\*\*)?(?:[\t ]*\(correction\))?:\s*(.+)$/i);
    if (!m) continue;
    if (/<[A-Za-z][^>\s]*>|\bBRO-N\b|\bBRO-X+\b|\bX{3,}\b|\bTBD\b|\bTODO\b|\bPLACEHOLDER\b/.test(m[1])) return line.trim();
  }
  return null;
}

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
      const verifyResult = runVerify(checkout.wt, cmd, { attempts: VERIFY_ATTEMPTS, timeoutMs, prepared: checkout.prepared, unpreparedReason: checkout.unpreparedReason });
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
      const baseReason = (!allowed && decision.allowed === true)
        ? `recorded command \`${cmd}\` was not confirmed to pass (${decision.verdict}): ${(verifyResult && verifyResult.detail) || 'no further detail'}`
        : decision.message;
      const reason = allowed ? baseReason : baseReason + envRefusalHint(verifyResult, decision);
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
      // BRO-5837: a git timeout while building the checkout says nothing about
      // the card. Say so, and name the way out, instead of reading as a failed
      // command. No retry/clone here: callers cap this whole gate at 300s.
      const infraTimeout = isCheckoutTimeout(err);
      return {
        allowed: false,
        verdict: infraTimeout ? 'verify-cmd-infra-timeout' : 'execution-error',
        reason: infraTimeout
          ? `building the origin/main checkout timed out (${message}). That is infrastructure, not a verdict on \`${cmd}\`: re-run the Done update, or record \`PR-EVIDENCE: merged deployed checked (<url>)\` instead.`
          : `could not execute the recorded command against a fresh origin/main checkout: ${message}`,
        notOnMain: false,
        sha: null,
      };
    } finally {
      removeCheckout(checkout);
    }
  };
}

/**
 * BRO-7697: which of the paths a safe-form check command names are NOT on origin/main?
 * Reads git objects only (no checkout, no network): `git cat-file -e origin/main:<path>`.
 * Fails open: if origin/main cannot be resolved here, nothing is reported missing.
 * @returns {(cmd:string) => {missing:string[]}}
 */
function makePathsOnMain({ repo = path.join(__dirname, '..', '..'), ref = 'origin/main' } = {}) {
  const { execFileSync } = require('child_process');
  const { runGitOrThrow } = require('./git-proc-guard.js'); // BRO-7458: group kill on timeout
  const { extractCheckPaths } = require('./check-paths.js');
  return function pathsOnMain(cmd) {
    const paths = extractCheckPaths(cmd).filter((p) => p && !p.startsWith('-') && !/[*?]/.test(p));
    if (!paths.length) return { missing: [] };
    try { runGitOrThrow(['fetch', '-q', '--no-tags', '--depth=1', 'origin', 'main'], { cwd: repo, stdio: 'ignore', timeout: 20000 }); } catch { /* best effort: stale ref only risks an advisory warning */ }
    try { execFileSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: repo, stdio: 'ignore', timeout: 10000 }); } catch { return { missing: [] }; }
    const missing = [];
    for (const p of paths) {
      try { execFileSync('git', ['cat-file', '-e', `${ref}:${p.replace(/^\.\//, '')}`], { cwd: repo, stdio: 'ignore', timeout: 10000 }); } catch { missing.push(p); }
    }
    return { missing };
  };
}

module.exports = { makePathsOnMain, makeVerifyCmdEvidence, envRefusalHint, findPlaceholderVerify, isCheckoutTimeout, DEFAULT_TIMEOUT_MS, VERIFY_ATTEMPTS };
