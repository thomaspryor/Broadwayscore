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

const { extractVerifyCmd } = require('./autonomous-verify-cmd.js');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');

const OWNER_JUDGMENT_RE = /VERIFY:\s*owner-judgment/i;

/**
 * @param {string} notes - the card's full notes/body (untrusted content)
 * @returns {{armed: boolean, cmd: string|null, reason: string|null, ownerJudgment: boolean}}
 *   armed=true means bsc-next.js would dispatch this card without
 *   --allow-unverifiable. cmd is the extracted safe-form command (null when
 *   ownerJudgment is true or when nothing safe was found). reason explains
 *   why cmd is null.
 */
function evaluateVerifiability(notes) {
  const text = String(notes || '');
  if (OWNER_JUDGMENT_RE.test(text)) {
    return { armed: true, cmd: null, reason: null, ownerJudgment: true };
  }
  const { cmd, reason } = extractVerifyCmd(text, isSafeCheckCommand);
  return { armed: !!cmd, cmd, reason, ownerJudgment: false };
}

module.exports = { evaluateVerifiability, isSafeCheckCommand, extractVerifyCmd, OWNER_JUDGMENT_RE };
