/**
 * Shared helper for scripts that clear a false-positive wrongProduction/wrongShow flag.
 *
 * Clearing only the top-level wrongProduction/wrongShow fields is not enough:
 * rebuild-all-reviews.js's CV pre-pass reads the embedded contentVerification
 * sub-object DIRECTLY and re-promotes contentVerification.wrongProduction back
 * to the top-level field on the next rebuild, silently undoing the recovery.
 * Found live via card #632 (Les Mis Arena Concert Spectacular: a rebuild between
 * recovery and the fix re-flagged 2 just-recovered reviews from the stale
 * sub-object). Reference: verify-existing-reviews.js's recover path (fixed in
 * commit 13790c5f190), extracted here so every other clearing script gets the
 * same fix instead of re-diverging.
 *
 * wrongProductionOverride (not humanReviewedWrongProduction) is the convention
 * for script-driven clears — humanReviewedWrongProduction is reserved for an
 * actual human review decision (ingest-manual-review.js). It is honored by
 * shouldSkipWrongProductionAudit() (review-guards.js) and everything built on
 * it (isIncludableForRebuild's invalid-tier gate, cross-show-URL flagging).
 * It is NOT checked by every wrongProduction-adjacent guard in the codebase —
 * e.g. rebuild-all-reviews.js's multiProdDirectorGuard checks only
 * humanReviewedWrongProduction, so a director-name text match can still
 * exclude a recovered file via a different code path (Codex adversarial
 * review, 2026-07-30). That guard predates this helper and is out of scope
 * here; a recovered file passing through it produces `skippedDirectorMismatch`
 * rather than silent wrong scoring, so it fails visibly rather than silently.
 *
 * opts.wrongShowOnly: several callers (audit-review-url-clusters.js,
 * clear-stale-wrong-show-flags.js, flag-combined-reviews.js,
 * reverify-promoted-reviews.js) only ever verify wrongShow — they never assert
 * "not wrong production" and must not grant it. The default (full) mode stamps
 * wrongProductionOverride, a blanket exemption from every wrongProduction guard
 * (manual-review-fields.js:57-62 warns automated callers must never grant this
 * casually — it re-admitted prior-production/cross-market contamination,
 * 2026-06-21, 335 reviews). wrongShowOnly:true instead leaves wrongProduction
 * and contentVerification.wrongProduction untouched (so a genuinely stale
 * wrongProduction can still be independently re-promoted by rebuild) and
 * stamps wrongShowOverride, the narrower, already-established convention
 * (flag-combined-reviews.js) checked by the same guards via an OR alongside
 * wrongProductionOverride (review-guards.js:1015/1017).
 *
 * Known scope tradeoff (Codex adversarial review, 2026-07-30): wrongShowOnly
 * STILL forces contentVerification.{isValid,wrongArticle,isFilmTv} to their
 * "valid" values, even though a caller's wrongShow-only evidence (e.g. a venue
 * match or a URL that legitimately co-occurs across show dirs) doesn't
 * technically prove the content isn't ALSO a film/TV review or a wrong
 * article for unrelated reasons. This is unavoidable, not an oversight:
 * rebuild-all-reviews.js's CV pre-pass promotes wrongShow=true from EITHER
 * cv.wrongArticle===true OR cv.isFilmTv===true (rebuild-all-reviews.js
 * ~line 2134), so leaving either field stale would silently undo the
 * recovery on the very next rebuild — the exact bug this helper exists to
 * fix. wrongProduction itself (the field the 2026-06-21 contamination
 * incident was about) is NOT touched in this mode; only the two fields that
 * directly gate wrongShow re-promotion are corrected.
 */

const { classifyContentTier } = require('./content-quality');

/**
 * Clear wrongProduction/wrongShow flags (top-level + embedded contentVerification)
 * on a review data object, in place.
 *
 * @param {object} data - Review data object (mutated in place)
 * @param {object} opts
 * @param {string} opts.source - Identifies the calling script for the audit trail,
 *   e.g. 'unflag-wrong-production-fps.js'. Required.
 * @param {string} [opts.reason] - Human-readable reason to record alongside the clear.
 * @param {boolean} [opts.wrongShowOnly] - Scope the clear to wrongShow only; leave
 *   wrongProduction (top-level and embedded CV) untouched and stamp wrongShowOverride
 *   instead of wrongProductionOverride. See module doc above.
 * @returns {object} the same data object, for chaining
 */
function clearWrongProductionFlags(data, opts = {}) {
  const { source, reason = '', wrongShowOnly = false } = opts;
  if (!source) throw new Error('clearWrongProductionFlags: opts.source is required');

  // 1. Top-level flags
  if (!wrongShowOnly) {
    delete data.wrongProduction;
    delete data.wrongProductionReason;
    delete data.wrongProductionNote;
  }
  delete data.wrongShow;
  delete data.wrongShowReason;

  // 2. Embedded contentVerification sub-object — the ORIGINAL CV verdict that
  // caused the flag. rebuild-all-reviews.js reads this directly, so it must be
  // corrected too or the next rebuild silently re-flags the review.
  if (data.contentVerification) {
    data.contentVerification.isValid = true;
    if (!wrongShowOnly) data.contentVerification.wrongProduction = false;
    data.contentVerification.wrongArticle = false;
    data.contentVerification.isFilmTv = false;
    data.contentVerification.reasoning =
      `Superseded by ${source} recovery${reason ? `: ${reason}` : ''}`.trim();
  }

  // 3. A stale contentTier:'invalid' otherwise permanently blocks
  // isIncludableForRebuild's separate invalid-tier gate (review-guards.js)
  // even after wrongProduction/wrongShow are cleared above.
  if (data.contentTier === 'invalid') {
    delete data.incompleteReason;
    const tierResult = classifyContentTier(data);
    if (tierResult && tierResult.contentTier) {
      data.contentTier = tierResult.contentTier;
    }
  }

  // 4. Record the clear so every future automated wrong-production guard
  // recognizes this file as already recovered.
  if (wrongShowOnly) {
    data.wrongShowOverride = true;
    data.wrongShowOverrideReason = `${source}${reason ? `: ${reason}` : ''}`.trim();
    data.wrongShowOverrideAt = new Date().toISOString();
  } else {
    data.wrongProductionOverride = true;
    data.wrongProductionOverrideReason = `${source}${reason ? `: ${reason}` : ''}`.trim();
    data.wrongProductionOverrideSetAt = new Date().toISOString();
    data.wrongProductionOverrideSetBy = source;
  }

  return data;
}

module.exports = { clearWrongProductionFlags };
