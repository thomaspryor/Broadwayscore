'use strict';

/**
 * Date-guard HOLD marker (BRO-5030).
 *
 * flag-wrong-production-by-date.js HOLDS a dated-outside-run review for human
 * review when current-run corroboration contradicts the date
 * (shouldHoldDateGuardFlag in ./wrong-production-corroboration). Before this
 * module the hold wrote nothing, so validate-data.js CHECK 0 reported the same
 * file as an ERROR and push-core-data refused every validate-gated core-data
 * push site-wide until a person wrote a data/pending-fixes plan (4 times in the
 * BRO-4884 backfill).
 *
 * Now the flagger stamps `dateGuardHeld` and CHECK 0 downgrades a held file to
 * a warning. A hold is a request for a human, not corrupt data.
 *
 * The marker alone never silences CHECK 0. classifyDateGuardBackstop re-runs
 * the hold decision on the file as it is now, so a marker that went stale (the
 * publishDate was edited, or the corroborating Theatre Record URL went away)
 * reverts to the error. A hand-typed marker on a file the flagger would not
 * hold fails the same way.
 */

const { evaluateCurrentRunCorroboration, shouldHoldDateGuardFlag } = require('./wrong-production-corroboration');
const { evaluateDatePlausibility } = require('./date-plausibility');

const MARKER_FIELD = 'dateGuardHeld';

/**
 * Stamp the hold marker onto a review record (mutates and returns `data`).
 * The flagger persists it with safeWriteReview.
 *
 * @param {object} data - review-text record
 * @param {{signals: string[], issue?: string, diffDays?: number, now?: Date}} args
 */
function applyDateGuardHold(data, { signals, issue, diffDays, now } = {}) {
  const sig = Array.isArray(signals) ? signals.slice() : [];
  data[MARKER_FIELD] = {
    reason: `current-run corroboration contradicts the date guard (${issue || 'before_preview'}${Number.isFinite(diffDays) ? ` ${diffDays}d` : ''}): ${sig.join(', ') || 'none'}`,
    signals: sig,
    publishDate: data.publishDate || null,
    heldAt: (now || new Date()).toISOString(),
  };
  return data;
}

/**
 * True when the flagger should (re)write the marker: none on file, or the one
 * on file names a different publishDate or signal set. Keeps reruns from
 * rewriting heldAt on every pass.
 */
function holdMarkerNeedsWrite(data, signals) {
  const m = data && data[MARKER_FIELD];
  if (!m || typeof m !== 'object') return true;
  if (m.publishDate !== (data.publishDate || null)) return true;
  const a = Array.isArray(m.signals) ? m.signals.slice().sort().join('|') : '';
  const b = Array.isArray(signals) ? signals.slice().sort().join('|') : '';
  return a !== b;
}

/**
 * Remove the marker (the flagger calls this when it stamps wrongProduction,
 * so a resolved file does not carry a stale hold). Returns true if removed.
 */
function clearDateGuardHold(data) {
  if (data && Object.prototype.hasOwnProperty.call(data, MARKER_FIELD)) {
    delete data[MARKER_FIELD];
    return true;
  }
  return false;
}

/**
 * True when `data` carries a hold marker that is still valid: it matches the
 * current publishDate AND the flagger's own hold rule still holds on the file
 * as it is now.
 */
function isDateGuardHeld({ review, show, implausible }) {
  const m = review && review[MARKER_FIELD];
  if (!m || typeof m !== 'object') return false;
  if (!review.publishDate || m.publishDate !== review.publishDate) return false;
  const corrob = evaluateCurrentRunCorroboration({ review, show });
  return shouldHoldDateGuardFlag({ corrob, implausible: implausible !== false });
}

/**
 * validate-data.js CHECK 0 decision.
 *   'ok'    — date plausible for this show (or exempt: priorRun, wrongProduction, ...)
 *   'held'  — implausible, but a valid flagger hold is on file → warning, routed to review
 *   'error' — implausible and not held → blocks the push, as before
 *
 * @returns {{kind: 'ok'|'held'|'error', verdict: object}}
 */
function classifyDateGuardBackstop({ review, show }) {
  const verdict = evaluateDatePlausibility({ review, show });
  if (!verdict.implausible) return { kind: 'ok', verdict };
  if (isDateGuardHeld({ review, show, implausible: true })) return { kind: 'held', verdict };
  return { kind: 'error', verdict };
}

module.exports = {
  MARKER_FIELD,
  applyDateGuardHold,
  holdMarkerNeedsWrite,
  clearDateGuardHold,
  isDateGuardHeld,
  classifyDateGuardBackstop,
};
