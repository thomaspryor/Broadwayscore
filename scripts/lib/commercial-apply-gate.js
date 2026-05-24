// Pure decision functions for apply-commercial-pending.js.
// Tested by tests/unit/commercial-apply-gate.test.mjs.

const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');

const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 };

function meetsConfidenceThreshold(entry, minConfidence) {
  if (!minConfidence || minConfidence === 'all') return true;
  const entryLevel = CONFIDENCE_ORDER[entry.confidence] || 0;
  const threshold = CONFIDENCE_ORDER[minConfidence] || 0;
  return entryLevel >= threshold;
}

function hasRecoupedClaim(entry) {
  return entry.recouped === true || entry._recoupedClaim === true;
}

// Recouped-claim entries normally require manual --show=SLUG. This bypass lets
// trusted Friday-pipeline sources auto-apply when ALL hold:
//   - autoApplyClaimsFrom (a non-empty array) contains entry.detectedBy
//   - entry.confidence === 'high'
//   - entry.sourceHost ∈ TRUSTED_RECOUPMENT_HOSTS
//
// `sourceHost` (not free-text `recoupedSource`) is the trusted-domain check
// field — recoupedSource is prose in many writers (see e.g.
// scripts/backfill-commercial-o4mini.js:57,69 which writes
// "Reddit post-mortem: did not come close…" there).
function isAutoApplyableClaim(entry, autoApplyClaimsFrom) {
  if (!Array.isArray(autoApplyClaimsFrom) || autoApplyClaimsFrom.length === 0) return false;
  if (!autoApplyClaimsFrom.includes(entry.detectedBy)) return false;
  if (entry.confidence !== 'high') return false;
  if (!entry.sourceHost || !TRUSTED_RECOUPMENT_HOSTS.has(entry.sourceHost)) return false;
  return true;
}

module.exports = {
  CONFIDENCE_ORDER,
  meetsConfidenceThreshold,
  hasRecoupedClaim,
  isAutoApplyableClaim,
};
