'use strict';

/**
 * codex-ui-hold.js — the hand-off for a Codex change held for visual approval (BRO-7639).
 *
 * BRO-7636: the Codex runner holds any UI diff (it cannot run /visual-qa or get the owner's yes),
 * bounces the card to Todo and keeps Codex's commit on an inert ref codex-ui-hold/<card>.
 * Nothing used that ref: the worker had to read prose to find it, and nothing deleted it.
 *
 *   uiHoldHandoffLine(ref)        the marker line written into the bounce note
 *   uiHoldFromComments(comments)  the newest marker on a card -> { ref, instructions } | null
 *                                 (cloud-worker-pick.js prints it as pick.uiHold)
 *   decideUiHoldRefPrune(...)     whether the daily ref prune (prune-stale-land-refs.js) deletes a hold ref
 */

const UI_HOLD_PREFIX = 'codex-ui-hold/';
const UI_HOLD_LINE_RE = /^\s*CODEX-UI-HOLD:\s*(codex-ui-hold\/[A-Za-z0-9._-]+)/m;
// Bounce notes written before the marker (BRO-7636) name the ref only in prose.
const LEGACY_HOLD_RE = /Codex's commit is on the ref (codex-ui-hold\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/;
// A hold nobody picked up in this long is stale: the change is redone from the card instead.
const UI_HOLD_MAX_AGE_DAYS = 21;
// Never delete a ref this fresh, even for a Done card (a worker may be mid-fetch).
const UI_HOLD_MIN_AGE_DAYS = 1;

function uiHoldRef(identifier) { return `${UI_HOLD_PREFIX}${String(identifier).toLowerCase()}`; }

function uiHoldInstructions(ref) {
  return `Start from Codex's commit on ${ref}: git fetch origin ${ref} && git checkout -b <your branch> FETCH_HEAD`
    + ' (if the ref is gone, redo the change from the card). Run /visual-qa on it, then ask the owner with'
    + ' node scripts/visual-approval.js request --issue=<this card> --what="<plain words>". Land only after the owner\'s yes.';
}

/** The parseable line for the bounce note: `CODEX-UI-HOLD: <ref> (<instructions>)` (one line). */
function uiHoldHandoffLine(ref) { return `CODEX-UI-HOLD: ${ref} (${uiHoldInstructions(ref)})`; }

/** Newest CODEX-UI-HOLD marker among Linear comment nodes ({ body, createdAt }) -> { ref, instructions } | null. */
function uiHoldFromComments(comments) {
  const hits = (Array.isArray(comments) ? comments : [])
    .map((c) => ({ m: UI_HOLD_LINE_RE.exec((c && c.body) || '') || LEGACY_HOLD_RE.exec((c && c.body) || ''), t: Date.parse((c && c.createdAt) || '') || 0 }))
    .filter((x) => x.m)
    .sort((a, b) => b.t - a.t);
  if (!hits.length) return null;
  const ref = hits[0].m[1];
  return { ref, instructions: uiHoldInstructions(ref) };
}

/**
 * @param {object} p
 * @param {string|null} p.tipCommittedAt  ISO date of the hold ref's tip commit
 * @param {string|null} p.cardStateType   Linear state type of the card (completed/canceled/started/unstarted/...), null if none
 * @param {boolean} p.cardLookupFailed     the card could not be read
 * @param {number} [p.now]
 * @returns {{ prune: boolean, reason: string }}
 */
function decideUiHoldRefPrune({ tipCommittedAt, cardStateType = null, cardLookupFailed = false, now = Date.now() } = {}) {
  const keep = (reason) => ({ prune: false, reason });
  if (!tipCommittedAt || Number.isNaN(Date.parse(tipCommittedAt))) return keep('tip-date-unreadable');
  const age = (now - Date.parse(tipCommittedAt)) / 86400000;
  if (age < UI_HOLD_MIN_AGE_DAYS) return keep('too-young');
  if (!cardLookupFailed && (cardStateType === 'completed' || cardStateType === 'canceled')) return { prune: true, reason: 'ui-hold-card-done' };
  if (age < UI_HOLD_MAX_AGE_DAYS) return keep(cardLookupFailed ? 'card-unreadable' : 'ui-hold-recent');
  // A worker is on it right now: its ref outlives the age limit.
  if (!cardLookupFailed && cardStateType === 'started') return keep('ui-hold-card-in-progress');
  return { prune: true, reason: 'ui-hold-stale' };
}

module.exports = { UI_HOLD_PREFIX, UI_HOLD_LINE_RE, UI_HOLD_MAX_AGE_DAYS, UI_HOLD_MIN_AGE_DAYS, uiHoldRef, uiHoldInstructions, uiHoldHandoffLine, uiHoldFromComments, decideUiHoldRefPrune };
