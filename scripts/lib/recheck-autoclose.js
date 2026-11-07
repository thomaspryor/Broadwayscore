/**
 * recheck-autoclose.js — the I/O half of the nightly re-check's auto-close
 * (BRO-6240). The decision lives in autonomous-recheck-core.js decideAutoClose;
 * this moves the card to Done through linear-brain.js `update`, so every gate
 * that path has (Done gate, comment-before-state ordering, terminal-state
 * warnings) still applies. No bypass flag, no LINEAR_DONE_GATE_DISABLED.
 *
 * Two problems it solves instead of shelling out:
 *  - the Done gate re-runs the card's VERIFY command in a second fresh
 *    checkout (up to 180s a card). The recheck just ran that exact command on
 *    that exact origin/main, so the verifier handed to the gate returns the
 *    recheck's own result for the same command and runs the real check for any
 *    other. The comment's VERIFY line is the command the recheck ran, so the
 *    gate can only ever be asked about that one.
 *  - linear-brain's main() calls process.exit on refusal, which would end the
 *    whole nightly run mid-loop. It is trapped and turned into a result.
 */

'use strict';

const { buildAutoCloseComment } = require('./autonomous-recheck-core.js');
const { makeVerifyCmdEvidence } = require('./linear-cmd-execution.js');

class ExitTrap extends Error {
  constructor(code) { super(`process.exit(${code})`); this.exitCode = code; }
}

function makeCachedVerifier({ cmd, sha, fallback }) {
  return function verifyCmdEvidence(c) {
    if (String(c).trim() === String(cmd).trim()) {
      return { allowed: true, verdict: 'pass', reason: 'the nightly recheck ran this command against fresh origin/main moments ago and it passed', notOnMain: false, sha: sha || null };
    }
    return (fallback || makeVerifyCmdEvidence())(c);
  };
}

/**
 * @param {{identifier:string, cmd:string, sha?:string|null, runUrl?:string|null,
 *          linearBrainMain?:Function, verifyFallback?:Function, now?:Date}} o
 * @returns {Promise<{closed:boolean, exitCode:number|null, error:string|null, comment:string}>}
 */
async function closeCardAfterPass({ identifier, cmd, sha = null, runUrl = null, linearBrainMain, verifyFallback, now, expectStateType, getIssue } = {}) {
  const comment = buildAutoCloseComment({ cmd, sha, runUrl, now });
  const main = linearBrainMain || require('../linear-brain.js').main;
  const realExit = process.exit;
  // First exit code wins: linear-brain wraps its update body in a catch that
  // calls process.exit(2), so a refusal (exit 5) would otherwise surface as 2.
  let firstCode = null;
  process.exit = (code) => {
    if (firstCode === null) firstCode = code == null ? 0 : code;
    throw new ExitTrap(firstCode);
  };
  try {
    const realGetIssue = getIssue || require('./linear-client').getIssue;
    // The recheck can run for 90 minutes: refuse if the card left its open
    // state (someone started it) between the fetch and this write.
    const guardedGetIssue = async (...a) => {
      const issue = await realGetIssue(...a);
      if (expectStateType && issue && issue.state && issue.state.type !== expectStateType) {
        throw new Error(`card state changed to ${issue.state.type} during the run`);
      }
      return issue;
    };
    await main(['update', identifier, '--state', 'Done', '--comment', comment], {
      verifyCmdEvidence: makeCachedVerifier({ cmd, sha, fallback: verifyFallback }),
      getIssue: guardedGetIssue,
    });
    return { closed: true, exitCode: 0, error: null, comment };
  } catch (err) {
    if (err instanceof ExitTrap) {
      return { closed: err.exitCode === 0, exitCode: err.exitCode, error: err.exitCode === 0 ? null : `linear-brain update exited ${err.exitCode}`, comment };
    }
    return { closed: false, exitCode: null, error: String((err && err.message) || err).slice(0, 200), comment };
  } finally {
    process.exit = realExit;
  }
}

module.exports = { closeCardAfterPass, makeCachedVerifier, ExitTrap };
