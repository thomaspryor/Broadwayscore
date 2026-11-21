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
const { isLongRunningProduction } = require('./long-runner-registry');

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
 * Clear the marker (the flagger calls this when it stamps wrongProduction,
 * so a resolved file does not carry a stale hold). Returns true if removed.
 */
function clearDateGuardHold(data) {
  // Set null, never delete: safeWriteReview's merge pass copies any key that
  // is undefined on the incoming record back from disk, so a deleted marker
  // would survive the write.
  if (data && data[MARKER_FIELD]) {
    data[MARKER_FIELD] = null;
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
  if (!shouldHoldDateGuardFlag({ corrob, implausible: implausible !== false })) return false;
  return rebuildExcludesHeld({ review, show, corrob });
}

/**
 * A hold only earns the warning when rebuild-all-reviews.js really EXCLUDES the
 * file from scores (its [PRE-OPENING-HELD] branch). Rebuild instead INCLUDES a
 * pre-window file when contentVerification affirms the production
 * ([PRE-OPENING-CV-OVERRIDE]), and skips its pre-window guard entirely for
 * allowEarlyDate, routedFromShowId and long-running WE productions. A scored
 * file dated far outside the run must stay a CHECK 0 error, marker or not.
 */
function rebuildExcludesHeld({ review, show, corrob }) {
  if (review.allowEarlyDate || review.routedFromShowId) return false;
  if (show && isLongRunningProduction(show)) return false;
  const signals = (corrob && corrob.signals) || [];
  return !signals.includes('cv-affirms-production');
}

/**
 * rebuild-all-reviews.js pre-window guard: should a review dated before the
 * window be HELD (not flagged / CV-included) on current-run corroboration?
 * One rule for the rebuild's flag pass and inclusion pass, the same one
 * flag-wrong-production-by-date.js applies (shouldHoldDateGuardFlag, BRO-4884):
 * cv-affirms-production alone holds only inside the 180-day plausibility line.
 * Before BRO-5877 the rebuild held on any 'strong' verdict, so a 2018 review
 * 3084d early on Cursed Child WE 2026 was never re-flagged after a hold
 * release, and its inclusion pass scored it.
 * Like the flagger, an 'llm-scoring' date is never implausible here
 * (date-plausibility.js), so cv-affirms still holds it at any gap.
 *
 * @returns {{hold: boolean, corrob: {strength: string|null, signals: string[]}}}
 */
function rebuildPreWindowHold({ review, show }) {
  const corrob = evaluateCurrentRunCorroboration({ review, show });
  if (corrob.strength !== 'strong') return { hold: false, corrob };
  const implausible = evaluateDatePlausibility({ review, show }).implausible;
  return { hold: shouldHoldDateGuardFlag({ corrob, implausible }), corrob };
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
  rebuildExcludesHeld,
  rebuildPreWindowHold,
  classifyDateGuardBackstop,
};

// ---------------------------------------------------------------------------
// Automatic resolution of a hold (BRO-5032). Pure decision, no I/O: the script
// scripts/resolve-date-guard-holds.js feeds it the refetch + CV results and
// applies the verdict.
// ---------------------------------------------------------------------------

const { isArticleOutsideProductionWindow } = require('./date-guard');
const { detectPriorRunRepublish } = require('./prior-run-republish-guard');

const RESOLVE_ATTEMPTS_FIELD = 'dateGuardResolveAttempts';
const RESOLVE_EXHAUSTED_FIELD = 'dateGuardResolveExhausted';
const MAX_RESOLVE_ATTEMPTS = 3;

/**
 * Decide what to do with one held review.
 *
 * @param {object} args
 * @param {object} args.review - review-text record (carries the marker)
 * @param {object} args.show - shows.json record
 * @param {{ok: boolean, date?: string|null, text?: string|null}|null} args.refetch
 *   result of refetching the live page (date from extractPublishDate, never dateModified)
 * @param {{isValid?: boolean, wrongProduction?: boolean, wrongArticle?: boolean, confidence?: string}|null} args.cv
 *   fresh content-verification verdict; null when it has not been run yet
 * @param {number} [args.attempts] - dateGuardResolveAttempts already spent
 * @returns {{action: 'refuse'|'retry'|'need-cv'|'correct-date'|'wrong-production'|'cv-affirm'|'exhausted',
 *            reason: string, date?: string, countAttempt: boolean}}
 */
function resolveHoldDecision({ review, show, refetch, cv, attempts = 0 }) {
  const out = (action, reason, extra = {}) => ({ action, reason, countAttempt: false, ...extra });
  if (!review || review[RESOLVE_EXHAUSTED_FIELD]) return out('refuse', 'already-exhausted-or-missing');
  // A person's score exempts the file from the date check; never touch it.
  if (review._locked === true || review.wrongProductionOverride || review.wrongProductionManualClear
      || review.humanReviewedWrongProduction === false || review.publishDateVerified === true) {
    return out('refuse', 'operator-decision-on-file');
  }
  if (review.humanReviewScore !== undefined && review.humanReviewScore !== null) return out('refuse', 'human-review-score-set');

  if (!refetch || refetch.ok === false) return out('retry', 'fetch-failed');

  const stored = review.publishDate || null;
  const live = refetch.date || null;
  if (live && live !== stored && !isArticleOutsideProductionWindow(show, live)) {
    const republish = detectPriorRunRepublish({ text: refetch.text || review.fullText, show });
    if (republish.flag) {
      return out('wrong-production', `in-run date ${live} but prior-run republish (${republish.reason})`, { countAttempt: true });
    }
    return out('correct-date', `live page date ${live} is inside the run`, { date: live, countAttempt: true });
  }

  // Same old date, or another out-of-run date: let the content decide.
  if (!cv) return out('need-cv', live ? `live date ${live} not in run` : 'no date on live page');
  const confident = cv.confidence === 'high';
  if (confident && (cv.wrongProduction === true || cv.wrongArticle === true)) {
    return out('wrong-production', 'content verification rejects this production', { countAttempt: true });
  }
  // A date past validate-data's 180-day backstop stays a CHECK 0 error even when
  // CV affirms (rebuild includes it, the backstop still refuses it), so an affirm
  // only resolves a hold whose date is not implausible.
  const stillImplausible = evaluateDatePlausibility({ review, show }).implausible;
  if (confident && cv.isValid === true && cv.wrongProduction !== true && cv.wrongArticle !== true && !stillImplausible) {
    return out('cv-affirm', 'content verification affirms this production', { countAttempt: true });
  }
  if (attempts + 1 >= MAX_RESOLVE_ATTEMPTS) {
    return out('exhausted', 'inconclusive after max attempts: staying excluded', { countAttempt: true });
  }
  return out('retry', 'content verification inconclusive', { countAttempt: true });
}

module.exports.resolveHoldDecision = resolveHoldDecision;
module.exports.RESOLVE_ATTEMPTS_FIELD = RESOLVE_ATTEMPTS_FIELD;
module.exports.RESOLVE_EXHAUSTED_FIELD = RESOLVE_EXHAUSTED_FIELD;
module.exports.MAX_RESOLVE_ATTEMPTS = MAX_RESOLVE_ATTEMPTS;
