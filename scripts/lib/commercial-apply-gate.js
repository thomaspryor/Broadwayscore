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

// Build the commercial.json entry from a pending-review entry. When applying
// an auto-apply recoupment claim (the Friday pipeline hot path), the scraper
// only carries recoupment fields — start from the existing entry and overlay,
// or every other field (designation/capitalization/weeklyRunningCost/notes/
// sources) gets clobbered. Sources merge by URL dedupe so prior Reddit/SEC
// citations survive alongside the new trade-press article.
function buildCommercialEntry(entry, existing, opts = {}) {
  const { isClaimAutoApply = false, normalizeSources = (x) => x } = opts;
  const result = isClaimAutoApply && existing ? { ...existing } : {};
  if (entry.designation) result.designation = entry.designation;
  if (entry.capitalization != null) result.capitalization = entry.capitalization;
  if (entry.capitalizationSource) result.capitalizationSource = entry.capitalizationSource;
  if (entry.weeklyRunningCost != null) result.weeklyRunningCost = entry.weeklyRunningCost;
  if (entry.costMethodology) result.costMethodology = entry.costMethodology;
  if (entry.recouped != null) result.recouped = entry.recouped;
  if (entry.recoupedDate) result.recoupedDate = entry.recoupedDate;
  if (entry.recoupedSource) result.recoupedSource = entry.recoupedSource;
  if (entry.notes) result.notes = entry.notes;
  if (Array.isArray(entry.sources) && entry.sources.length > 0) {
    const normalized = normalizeSources(entry.sources);
    if (normalized.length > 0) {
      if (isClaimAutoApply && Array.isArray(existing?.sources)) {
        const existingUrls = new Set(existing.sources.map(s => s.url).filter(Boolean));
        result.sources = [...existing.sources, ...normalized.filter(s => !existingUrls.has(s.url))];
      } else {
        result.sources = normalized;
      }
    }
  }
  return result;
}

module.exports = {
  CONFIDENCE_ORDER,
  meetsConfidenceThreshold,
  hasRecoupedClaim,
  isAutoApplyableClaim,
  buildCommercialEntry,
};
