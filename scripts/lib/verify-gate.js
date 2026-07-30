/**
 * verify-gate.js — the single canonical "is this card dispatchable" predicate.
 *
 * bsc-next.js's dispatch gate and notion-brain.js's create/update arming
 * warning both need the exact same answer to "does this card's acceptance
 * criteria name a runnable, safe-form command (or declare
 * VERIFY: owner-judgment)?" — they used to each inline their own copy
 * (extractVerifyCmd + isSafeCheckCommand + a separate owner-judgment regex),
 * which is exactly the class of drift CLAUDE.md §15 exists to prevent.
 * audit-card-verifiability.js (task #646) needed the same answer a third
 * time, which is what forced the extraction: one require()d module, three
 * callers, impossible to drift.
 */
'use strict';

const { extractVerifyCmd, candidatesFrom } = require('./autonomous-verify-cmd.js');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');

const OWNER_JUDGMENT_RE = /VERIFY:\s*owner-judgment/i;

/**
 * @param {string} notes - the card's full notes/body (untrusted content)
 * @returns {{armed: boolean, cmd: string|null, reason: string|null, ownerJudgment: boolean}}
 *   armed=true means bsc-next.js would dispatch this card without
 *   --allow-unverifiable. cmd is the extracted safe-form command, populated
 *   whenever one is present even alongside an ownerJudgment marker (ship-check
 *   finding: an earlier version short-circuited on the marker and always
 *   returned cmd:null for such cards, silently dropping a real command the
 *   dispatch ledger used to record). reason is null whenever armed.
 */
function evaluateVerifiability(notes) {
  const text = String(notes || '');
  const { cmd, reason } = extractVerifyCmd(text, isSafeCheckCommand);
  const ownerJudgment = OWNER_JUDGMENT_RE.test(text);
  const armed = !!cmd || ownerJudgment;
  return { armed, cmd, reason: armed ? null : reason, ownerJudgment };
}

module.exports = { evaluateVerifiability, isSafeCheckCommand, extractVerifyCmd, candidatesFrom, OWNER_JUDGMENT_RE };
