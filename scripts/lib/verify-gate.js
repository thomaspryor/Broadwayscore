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
const { isSafeCheckCommand, explainUnsafeCheckCommand } = require('./autonomous-triage-core.js');
// Leaf module, deliberately: autonomous-eligibility.js needs the same marker
// and cannot require THIS file without closing a cycle (task #1154 — see the
// header of owner-judgment-marker.js). Still re-exported below so existing
// importers of verify-gate's OWNER_JUDGMENT_RE are unchanged.
const { OWNER_JUDGMENT_RE } = require('./owner-judgment-marker.js');

/**
 * @param {string} notes - the card's full notes/body (untrusted content)
 * @returns {{armed: boolean, cmd: string|null, reason: string|null, ownerJudgment: boolean, kind: string|null}}
 *   armed=true means bsc-next.js would dispatch this card without
 *   --allow-unverifiable. cmd is the extracted safe-form command, populated
 *   whenever one is present even alongside an ownerJudgment marker (ship-check
 *   finding: an earlier version short-circuited on the marker and always
 *   returned cmd:null for such cards, silently dropping a real command the
 *   dispatch ledger used to record). reason is null whenever armed. kind is
 *   the machine-readable refusal cause (BRO-2570): 'no-section' | 'no-command'
 *   | 'shape' | 'path-prefix' | 'traversal' | 'mutating-script' | 'basename',
 *   also null whenever armed — see autonomous-triage-core.js's
 *   explainUnsafeCheckCommand for what each SAFE_CHECK_FORMS kind means.
 */
function evaluateVerifiability(notes) {
  const text = String(notes || '');
  const { cmd, reason, kind } = extractVerifyCmd(text, isSafeCheckCommand, explainUnsafeCheckCommand);
  const ownerJudgment = OWNER_JUDGMENT_RE.test(text);
  const armed = !!cmd || ownerJudgment;
  return { armed, cmd, reason: armed ? null : reason, ownerJudgment, kind: armed ? null : (kind || null) };
}

module.exports = { evaluateVerifiability, isSafeCheckCommand, explainUnsafeCheckCommand, extractVerifyCmd, candidatesFrom, OWNER_JUDGMENT_RE };
