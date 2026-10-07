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
 * @param {string[]} [comments] - the card's comment bodies, OLDEST FIRST
 *   (untrusted content, same as notes). Optional and backward-compatible:
 *   omitted or empty, this behaves exactly as the single-arg form always has.
 *
 *   BRO-2796: a Linear card's description cannot be edited by
 *   linear-brain.js's update command (--state/--comment only), so the ONLY
 *   way to correct a broken or wrong VERIFY command after dispatch is a
 *   comment — and this gate used to read only `notes`, making every such
 *   correction inert (confirmed dead on BRO-2413, BRO-2370, BRO-2795: a
 *   corrected command posted by comment never changed the gate's answer).
 *   Each document (notes, then each comment, oldest to newest) is evaluated
 *   independently and NEWEST-FIRST: the first one that arms (a safe-form
 *   command or an owner-judgment marker) wins, so a later comment supersedes
 *   an earlier broken command instead of being merged with it. A comment
 *   that fails safe-form validation does not win and falls through to
 *   whatever armed before it — same fail-closed contract as extractVerifyCmd
 *   itself, just applied per-document instead of per-candidate.
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
function evaluateVerifiability(notes, comments) {
  const description = String(notes || '');
  const commentTexts = Array.isArray(comments) ? comments.map((c) => String(c || '')) : [];
  const documents = [description, ...commentTexts];

  // Newest first: the last document that arms wins outright, without being
  // merged against earlier ones.
  for (let i = documents.length - 1; i >= 0; i--) {
    const text = documents[i];
    const { cmd } = extractVerifyCmd(text, isSafeCheckCommand, explainUnsafeCheckCommand);
    const ownerJudgment = OWNER_JUDGMENT_RE.test(text);
    if (cmd || ownerJudgment) {
      return { armed: true, cmd, reason: null, ownerJudgment, kind: null };
    }
  }

  // Nothing armed anywhere — report on the description alone, matching this
  // function's original (pre-comments) refusal shape exactly.
  const { cmd, reason, kind } = extractVerifyCmd(description, isSafeCheckCommand, explainUnsafeCheckCommand);
  const ownerJudgment = OWNER_JUDGMENT_RE.test(description);
  return { armed: false, cmd, reason, ownerJudgment, kind: kind || null };
}

module.exports = { evaluateVerifiability, isSafeCheckCommand, explainUnsafeCheckCommand, extractVerifyCmd, candidatesFrom, OWNER_JUDGMENT_RE };
