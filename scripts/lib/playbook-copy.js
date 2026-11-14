'use strict';
// BRO-5543: a health-check AUTO_FIX_PLAYBOOK row speaks to two readers.
//   ownerText          what broke and what the automation is doing, in plain
//                      English, for the owner's email/digest. Names an owner
//                      action only for a login, a payment or a decision.
//   workerInstruction  what a fix worker should do; becomes the filed card's
//                      "Suggested approach" hint. Never rendered to the owner.
// Older rows carry only `humanAction` (one text for both readers) or only
// `humanFallback` (workflow rows). These PURE helpers pick the right text for
// each reader with that backward compatibility, so no consumer reads the raw
// fields directly (owner-copy-no-claude.test.mjs pins the choice).

/** Text the owner sees for a playbook row; `fallback` when the row has none. */
function playbookOwnerText(entry, fallback = '') {
  if (!entry) return fallback;
  return entry.ownerText || entry.humanAction || entry.humanFallback || fallback;
}

/** Text a fix worker gets as the card hint; '' when the row has none. */
function playbookWorkerHint(entry) {
  if (!entry) return '';
  return entry.workerInstruction || entry.humanAction || entry.ownerText || '';
}

/**
 * True when the row is routed to a person or worker (not a workflow
 * auto-fix): the rows health-check.js files cards for. Replaces the old
 * `entry.humanAction` truthiness test, which split rows no longer pass.
 */
function hasPlaybookAction(entry) {
  return !!(entry && (entry.ownerText || entry.workerInstruction || entry.humanAction));
}

/** Joins an owner text and a tracker-status sentence with no em dash. */
function appendOwnerStatus(text, status) {
  const t = String(text || '').trim();
  if (!t) return status;
  return `${/[.!?)"']$/.test(t) ? t : `${t}.`} ${status}`;
}

/**
 * PURE. The line the owner's health digest shows for one actionable row:
 * the row's owner text plus what happened to its tracker card this run.
 * `dispatch` is the routeAlert() result for the row, or undefined when no
 * card was attempted (frozen ledger, per-run cap, workflow row, no entry).
 */
function ownerDigestInstruction(entry, row, dispatch) {
  const ownerText = playbookOwnerText(entry, (row && row.message) || '');
  if (!dispatch) return ownerText;
  // BRO-4487: plain 'auto' alerts wait out their incident age before a card
  // is filed; say so instead of claiming a tracker.
  if (dispatch.deferred) return appendOwnerStatus(ownerText, 'Being watched; a card is filed if this is still happening after 3 days.');
  // Rail 2 (task #1341): a Linear-deduped condition filed nothing new; say
  // where the tracker actually lives.
  if (dispatch.action === 'silent') {
    return appendOwnerStatus(ownerText, dispatch.linearIdentifier
      ? `Already tracked as ${dispatch.linearIdentifier} in Linear (still open).`
      : 'Already dispatched to the Action Queue (still open).');
  }
  // Surface the REAL captured error, not a guess (2026-07-24 npm-ci incident).
  if (dispatch.dispatchOk === false) {
    return appendOwnerStatus(ownerText, `Tracker filing failed, will retry next run. Error: ${(dispatch.dispatchError || '(no error captured)').slice(0, 200)}`);
  }
  // BRO-286 honesty: name the filed issue; never claim hands-free work.
  return appendOwnerStatus(ownerText, dispatch.linearIdentifier
    ? `Filed as ${dispatch.linearIdentifier} in Linear for triage.`
    : 'Tracker filed in Linear for triage.');
}

module.exports = { playbookOwnerText, playbookWorkerHint, hasPlaybookAction, appendOwnerStatus, ownerDigestInstruction };
