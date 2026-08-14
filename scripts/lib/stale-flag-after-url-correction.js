/**
 * Pure detector for the #483 corpus signature: a review file that carries an
 * exclusion flag (wrongProduction/wrongShow) describing an OLD article, an
 * `_urlChangedClear` breadcrumb proving a URL correction already happened,
 * an empty body (the correction is still waiting on refetch), and no human
 * override — i.e. the exact state a stale maybeUpgradeUrl escape left behind
 * on 112 corpus files (2026-07-26 sweep). The breadcrumb existing at all
 * means SOME fields were cleared at write time; the flag surviving anyway
 * means the write path that touched this file didn't clear the flag family.
 *
 * Not scoped to maybeUpgradeUrl specifically — any write chokepoint that
 * clears some URL-derived fields but not wrongProduction/wrongShow produces
 * this signature, so the sweep is chokepoint-agnostic by design.
 */

const { REPLACE_CLEAR_FIELDS } = require('./wrongprod-replacement-preserve');

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
 * A record whose URL was corrected but whose body has not been refetched yet.
 *
 * Its `publishDate` still belongs to the OLD article, so it is NOT evidence
 * about which production the (new) URL covers. Any date-window guard that
 * treats it as evidence will re-derive an exclusion flag from stale data —
 * which is precisely the drain→rebuild→re-flag loop that kept the #483 gate
 * red: a human cleared 157 flags in review-texts 773ebb7189d and the very
 * next Rebuild Reviews (Fast) run (a4246421ff0, ~4h later) re-added
 * `wrongProduction: true` to the same files with a "Date guard:" note.
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

// Derived from the canonical REPLACE_CLEAR_FIELDS family (not hand-rolled) so
// this stays in sync automatically when that set grows — a hardcoded subset
// is exactly how wrongProduction/contentVerification went stale in the first
// place (see wrongprod-replacement-preserve.js's own docblock).
const _clearFieldsArr = Array.from(REPLACE_CLEAR_FIELDS);
const WRONG_PRODUCTION_FIELDS = _clearFieldsArr.filter((f) => f.startsWith('wrongProduction'));
const WRONG_SHOW_FIELDS = _clearFieldsArr.filter((f) => f.startsWith('wrongShow'));
const SHARED_FIELDS = _clearFieldsArr.filter(
  (f) => !f.startsWith('wrongProduction') && !f.startsWith('wrongShow')
);

/**
 * One-time backlog remediation for files the detector matches. Clears every
 * field family for every flag the record carries (not just the first one —
 * a record with BOTH wrongProduction and wrongShow true gets both cleared in
 * a single pass) plus the shared old-URL-derived fields (contentTier,
 * contentVerification, etc.), and extends the existing `_urlChangedClear.
 * cleared` breadcrumb so the CI push-restore machinery doesn't resurrect
 * them from a committed snapshot. Never touches files the detector doesn't
 * match — no blanket flag-clearing.
 *
 * @param {object} data - a parsed review-text record (mutated in place)
 * @returns {string[]} field names actually cleared (empty if no match)
 */
function remediateStaleFlagAfterUrlCorrection(data) {
  const flags = detectStaleFlagAfterUrlCorrection(data);
  if (!flags.length) return [];

  const fields = [
    ...(flags.includes('wrongProduction') ? WRONG_PRODUCTION_FIELDS : []),
    ...(flags.includes('wrongShow') ? WRONG_SHOW_FIELDS : []),
    ...SHARED_FIELDS,
  ];
  const cleared = [];
  for (const f of fields) {
    if (data[f] !== undefined) {
      delete data[f];
      cleared.push(f);
    }
  }
  data.needsRefetch = true;

  const priorCleared = Array.isArray(data._urlChangedClear.cleared) ? data._urlChangedClear.cleared : [];
  data._urlChangedClear.cleared = Array.from(new Set([...priorCleared, ...cleared]));

  return cleared;
}

module.exports = {
  detectStaleFlagAfterUrlCorrection,
  remediateStaleFlagAfterUrlCorrection,
  isAwaitingUrlCorrectionRefetch,
  shouldWithholdStaleExclusionFlag,
};
