/**
 * Predicate for BRO-2740: a review file that carries wrongProduction
 * provenance (the detector ran and stamped its trail) while the
 * `wrongProduction` flag itself is gone, with no recorded human/automated
 * clear. Such a file reads as a clean, scoreable review.
 *
 * Complements scripts/lint-wrongproduction-provenance.js, which only checks
 * the write side (source code), never corpus files whose flag was dropped
 * after the write.
 *
 * An explicit `wrongProduction: false` is a recorded decision (clear paths
 * keep provenance on purpose) and is NOT an orphan; only a missing/null flag is.
 */

const PROVENANCE_FIELDS = [
  'wrongProductionDetectedBy',
  'wrongProductionProvenance',
  'wrongProductionDetail',
];

function hasProvenance(d) {
  return PROVENANCE_FIELDS.some(k => d[k] !== undefined && d[k] !== null && d[k] !== '');
}

function hasManualClear(d) {
  const v = d.wrongProductionManualClear;
  return v === true || (typeof v === 'string' && v.length > 0);
}

/** @param {object} d parsed review-text file */
function isOrphanedWrongProdProvenance(d) {
  if (!d || typeof d !== 'object') return false;
  if (!hasProvenance(d)) return false;
  if (d.wrongProduction === true || d.wrongProduction === false) return false;
  if (hasManualClear(d)) return false;
  return true;
}

module.exports = { PROVENANCE_FIELDS, isOrphanedWrongProdProvenance };
