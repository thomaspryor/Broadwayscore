/**
 * BRO-4385 — an AUTOMATED wrongProduction clear must never be stored as a
 * HUMAN clear.
 *
 * Every later wrongProduction guard honors `wrongProductionManualClear`
 * (collector-wp-release, flagged-recovery, cluster-canonical, merge-review-
 * fields, ...), so a script that writes ManualClear=true with a machine reason
 * ("Auto-cleared: single production, review within 14d of opening (Fix O)")
 * silently exempts that file from all of them. 104 such files sat in the
 * corpus, ~60 of them other-production reviews (London reviews on Broadway
 * King Charles III). Automated writers must use `wrongProductionAutoCleared`
 * (a breadcrumb the guards can still override), never ManualClear.
 *
 * Predicate = ManualClear===true AND wrongProductionClearReason starts with
 * "Auto" (case-insensitive, after whitespace). Human reasons ("manual:...",
 * "Genuine 2016 Broadway review...", "publishDate ...") do not match.
 */

'use strict';

const AUTOMATED_REASON_RE = /^\s*auto/i;

function isAutomatedClearStoredAsManual(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.wrongProductionManualClear !== true) return false;
  const reason = data.wrongProductionClearReason;
  return typeof reason === 'string' && AUTOMATED_REASON_RE.test(reason);
}

/**
 * Move the automated clear off ManualClear: drop the human-clear flag, keep the
 * reason as the wrongProductionAutoCleared breadcrumb (+At if known).
 * Returns true when it changed the record. Does NOT touch wrongProduction.
 */
function demoteAutomatedManualClear(data, { at } = {}) {
  if (!isAutomatedClearStoredAsManual(data)) return false;
  data.wrongProductionAutoCleared = data.wrongProductionClearReason;
  if (at && !data.wrongProductionAutoClearedAt) data.wrongProductionAutoClearedAt = at;
  delete data.wrongProductionManualClear;
  delete data.wrongProductionClearReason;
  return true;
}

module.exports = { isAutomatedClearStoredAsManual, demoteAutomatedManualClear, AUTOMATED_REASON_RE };
