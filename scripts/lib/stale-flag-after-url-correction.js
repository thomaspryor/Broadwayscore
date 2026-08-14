/**
 * Pure detector for the #483 corpus signature: a review file carrying an
 * exclusion flag (wrongProduction/wrongShow), an `_urlChangedClear` breadcrumb
 * proving a URL correction already happened, an empty body, and no human
 * override — the state a maybeUpgradeUrl escape left on 112 corpus files
 * (2026-07-26 sweep).
 *
 * READ THE SIGNATURE CAREFULLY. It says "some writer produced this state". It
 * does NOT say "this flag is stale", and an earlier version of this docblock
 * claiming otherwise was wrong (corrected 2026-08-14). A URL "correction" can
 * replace a CORRECT article with a different production's, in which case the
 * surviving flag is right. Two independent hand adjudications found 20/20 and
 * 8/8 matching files correctly flagged, 0 stale. Details and the specific
 * counter-example are in isAwaitingUrlCorrectionRefetch's docblock below —
 * read it before acting on any match.
 *
 * Not scoped to maybeUpgradeUrl specifically — any write chokepoint that
 * clears some URL-derived fields but not wrongProduction/wrongShow produces
 * this signature, so the sweep is chokepoint-agnostic by design.
 */

const MANUAL_CLEAR_FIELDS = [
  'wrongProductionManualClear',
  'wrongShowManualClear',
  'wrongProductionOverride',
  'urlManualOverride',
];

function _hasManualClear(data) {
  if (MANUAL_CLEAR_FIELDS.some((f) => data[f] === true)) return true;
  if (data.humanReviewedWrongProduction === false) return true;
  return false;
}

/**
 * @param {object} data - a parsed review-text record
 * @returns {string[]} matching flags — 'wrongProduction' and/or 'wrongShow'
 *   (both, if the record carries both stale flags); empty if no match.
 */
/**
 * A record that carries a URL-correction breadcrumb and still has no body.
 *
 * WHAT THIS DOES **NOT** MEAN (corrected 2026-08-14 — the original docblock
 * asserted the opposite and it was false): this is NOT proof that the record's
 * exclusion flag is stale. A URL "correction" can REPLACE A CORRECT URL WITH A
 * DIFFERENT PRODUCTION'S, in which case the flag is correct and the record
 * really is evidence of the wrong article. Verified on
 * equus-west-end-2026/guardian--unknown.json, whose breadcrumb moved from the
 * 2026 Menier Chocolate Factory review to a 2019 Stratford East one; an
 * independent review of 8 such files found 8/8 correctly flagged. Acting on
 * the old reading drained 121 files and immediately reddened two independent
 * CI gates (59 [wrong-production-by-date] errors, 5 class-A cross-market
 * leaks), 100% of the hits being drained files. See
 * ~/Documents/claude-outputs/handoff-483-predicate-narrowing-2026-08-14.md
 * and the URL-downgrade card for the real defect.
 *
 * What it DOES mean: a producer wrote (or would write) an exclusion flag onto
 * a record in this state. Because the 12 live producer sites consult
 * shouldWithholdStaleExclusionFlag, a NEW match indicates a writer that did
 * not — which is the escape class the sweep exists to catch.
 *
 * Exported so producers skip the same state the detector matches — the two
 * must agree by construction, not by a comment asking them to.
 *
 * @param {object} data - a parsed review-text record
 * @returns {boolean}
 */
function isAwaitingUrlCorrectionRefetch(data) {
  if (!data || typeof data !== 'object') return false;
  if (!data._urlChangedClear || typeof data._urlChangedClear !== 'object') return false;
  return !data.fullText; // body present — refetch already landed
}

/**
 * Producer-side twin of detectStaleFlagAfterUrlCorrection — the same predicate
 * minus the "is a flag ALREADY set" half. TRUE when persisting a NEW exclusion
 * flag on this record would create the state --gate fails on.
 *
 * Producers must call THIS, not isAwaitingUrlCorrectionRefetch directly. The
 * bare predicate omits the manual-clear check, so a producer keyed on it
 * withholds flags on operator-cleared records that the gate never matches —
 * a silent, invisible divergence between what the gate forbids and what the
 * producers refuse to write. That divergence is a new form of the defect that
 * got the 2026-08-13 write-guard attempt reverted (its override allowlist was
 * semantically inverted), and it is what "the two must agree by construction,
 * not by a comment asking them to" means in this file's docblock.
 *
 * Operator-cleared records are deliberately NOT withheld here: whether a
 * producer may re-flag them is review-guards.js's shouldSkipWrongProductionAudit
 * decision, not this module's.
 *
 * @param {object} data - a parsed review-text record
 * @returns {boolean}
 */
function shouldWithholdStaleExclusionFlag(data) {
  if (!isAwaitingUrlCorrectionRefetch(data)) return false;
  if (_hasManualClear(data)) return false;
  return true;
}

function detectStaleFlagAfterUrlCorrection(data) {
  if (!data || typeof data !== 'object') return [];
  if (!isAwaitingUrlCorrectionRefetch(data)) return [];
  if (_hasManualClear(data)) return [];

  const flags = [];
  if (data.wrongProduction === true) flags.push('wrongProduction');
  if (data.wrongShow === true) flags.push('wrongShow');
  return flags;
}

// NOTE: this module deliberately has NO auto-remediation. A
// remediateStaleFlagAfterUrlCorrection() existed until 2026-08-14 and cleared
// the exclusion-flag families on every detector match. It was removed, not
// refactored: the detector's matches are overwhelmingly CORRECT flags (see
// isAwaitingUrlCorrectionRefetch's docblock), so an auto-drain built on it is
// a contamination tool — 17 of the current matches carry aggregatorStars and
// are scoreable WITHOUT fullText, so clearing their flag puts a wrong-
// production review straight into live scoring. Nothing in CI ever called it.
// The right remedy for these records is a refetch, not a flag-clear; 107 of
// them already carry needsRefetch: true. Do not reintroduce it.

module.exports = {
  detectStaleFlagAfterUrlCorrection,
  isAwaitingUrlCorrectionRefetch,
  shouldWithholdStaleExclusionFlag,
};
