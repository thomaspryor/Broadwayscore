'use strict';
/**
 * recheck-handoff.js (BRO-6853). A due RECHECK-AFTER card the nightly recheck
 * cannot close on its own (its test failed, there is no runnable test, the test
 * is not a real one, or a person commented after the stamp) used to sit Paused
 * forever. This hands it to a worker: ONE idempotent comment with the reason and
 * the card moves Paused/Backlog -> Todo, so the worker queue picks it up and
 * writes a real VERIFY or closes it with evidence.
 *
 * Idempotent: only a card still in Paused/Backlog is handed off, and one that
 * already carries the marker after its stamp is left alone. Once in Todo it is
 * no longer a handoff candidate. This is not a reopen of a Done card (Paused
 * is not Done), so the shadow-mode rule "failures are only reported" for Done
 * cards is untouched.
 *
 * decideHandoff is pure. handoffCard is the I/O half, shaped like
 * recheck-autoclose.js closeCardAfterPass (linear-brain update, exit trapped).
 */

const { RECHECK_HANDOFF_MARKER, parseRecheckAfter } = require('./autonomous-recheck-core.js');
const { ExitTrap } = require('./recheck-autoclose.js');

const HANDOFF_STATE_NAMES = Object.freeze(['Paused', 'Backlog']);

function lastStampIndex(comments) {
  for (let i = comments.length - 1; i >= 0; i--) if (parseRecheckAfter(comments[i]) != null) return i;
  return -1;
}

/**
 * @param {{card?:object, target?:object, result?:object, closeVerdict?:{close:boolean,reason:string}|null}} o
 * @returns {{handoff:boolean, reason:string, why?:string}} reason is a ledger-safe code; why is the plain sentence for the comment
 */
function decideHandoff({ card, target, result, closeVerdict = null, closeRefused = null } = {}) {
  const no = (reason) => ({ handoff: false, reason });
  if (!card || !target) return no('missing card or target');
  if (target.skip) return no('skipped: someone is working it');
  if (!HANDOFF_STATE_NAMES.includes(card.status)) return no(`card is ${card.status || 'unknown'}, not Paused/Backlog`);
  // A card parked on a real block or waiting on the owner is not a worker's to take.
  if (/^\s*PARKED\s*:/im.test(String(card.notes || '')) || /DECISION NEEDED/.test(String(card.notes || ''))) return no('parked or waiting on the owner');
  const comments = Array.isArray(card.comments) ? card.comments : [];
  const stamp = lastStampIndex(comments);
  if (comments.slice(stamp + 1).some((c) => String(c || '').trimStart().startsWith(RECHECK_HANDOFF_MARKER))) return no('already handed off');
  if (closeRefused) return { handoff: true, reason: 'close-refused', why: `Its test passed (\`${target.verifyCmd}\`) but the automatic close was refused (${closeRefused}).` };
  if (!target.verifyCmd) return { handoff: true, reason: 'no-runnable-test', why: `The RECHECK-AFTER date has passed and the card has no runnable test (${target.reason || 'no safe-form VERIFY command'}).` };
  const status = result && result.status;
  if (status === 'fail') return { handoff: true, reason: 'test-failed', why: `The RECHECK-AFTER date has passed and its test failed on fresh main: \`${target.verifyCmd}\`.` };
  if (status === 'pass' && closeVerdict && !closeVerdict.close) {
    if (/not a real test/.test(closeVerdict.reason)) return { handoff: true, reason: 'weak-test', why: `Its test passed but is not a real test (file-exists or generic): \`${target.verifyCmd}\`.` };
    if (/comments were added after/.test(closeVerdict.reason)) return { handoff: true, reason: 'human-comment-after-stamp', why: `Its test passed (\`${target.verifyCmd}\`) but someone commented after the stamp, so the nightly run will not close it on its own.` };
  }
  return no('nothing to hand off');
}

function buildHandoffComment({ why, now = new Date() } = {}) {
  return [
    `${RECHECK_HANDOFF_MARKER}`,
    `Handed to a worker by the nightly acceptance re-check (BRO-6853) on ${now.toISOString().slice(0, 10)}.`,
    why,
    'Worker: write a real VERIFY command (a test, not a file-exists check) that proves the work held, or close the card with evidence that it did.',
  ].join('\n');
}

async function handoffCard({ identifier, why, linearBrainMain, now, getIssue } = {}) {
  const comment = buildHandoffComment({ why, now });
  const main = linearBrainMain || require('../linear-brain.js').main;
  const realExit = process.exit;
  let firstCode = null;
  process.exit = (code) => {
    if (firstCode === null) firstCode = code == null ? 0 : code;
    throw new ExitTrap(firstCode);
  };
  try {
    // The run can take minutes after the fetch: do not move a card someone has since started or a parallel run already moved.
    if (getIssue !== null) {
      const issue = await (getIssue || require('./linear-client').getIssue)(identifier);
      const name = issue && issue.state && issue.state.name;
      if (!HANDOFF_STATE_NAMES.includes(name)) return { handedOff: false, error: `card is ${name || 'unknown'} now, not Paused/Backlog`, comment };
    }
    // Bounded: a stalled Linear call must not hold the CI step until the hard kill drops the summary row.
    await Promise.race([
      main(['update', identifier, '--state', 'Todo', '--comment', comment]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('handoff timed out after 30s')), 30000).unref()),
    ]);
    return { handedOff: true, error: null, comment };
  } catch (err) {
    if (err instanceof ExitTrap) return { handedOff: err.exitCode === 0, error: err.exitCode === 0 ? null : `linear-brain update exited ${err.exitCode}`, comment };
    return { handedOff: false, error: String((err && err.message) || err).slice(0, 200), comment };
  } finally {
    process.exit = realExit;
  }
}

module.exports = { HANDOFF_STATE_NAMES, decideHandoff, buildHandoffComment, handoffCard };
