// Pure decision functions for apply-commercial-pending.js.
// Tested by tests/unit/commercial-apply-gate.test.mjs.

const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');

const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 };

// recoupedDate must be YYYY or YYYY-MM (mirrors validate-data.js:2688). A claim
// without a parseable date is not auto-appliable — it produces recouped=true
// with no date, which validate-data.js rejects (line 2633), aborting the whole
// hourly RSS-poll run. Such claims fall through to manual review instead.
const RECOUPED_DATE_RE = /^\d{4}(-\d{2})?$/;

// LLM verdicts frequently emit the literal strings "null"/"undefined"/"" instead
// of JSON null. Left untouched, `entry.recoupedDate || null` keeps "null" (a
// truthy string) and writes it into commercial.json, which then fails the
// YYYY/YYYY-MM format check. Treat these sentinels as absent everywhere.
function cleanNullish(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '' || t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') return undefined;
    return t;
  }
  return v;
}

function meetsConfidenceThreshold(entry, minConfidence) {
  if (!minConfidence || minConfidence === 'all') return true;
  const entryLevel = CONFIDENCE_ORDER[entry.confidence] || 0;
  const threshold = CONFIDENCE_ORDER[minConfidence] || 0;
  return entryLevel >= threshold;
}

function hasRecoupedClaim(entry) {
  return entry.recouped === true || entry._recoupedClaim === true;
}

// Review holds are review REQUESTS about data already in commercial.json —
// never appliable, even via --show. Applying one would clobber the rich
// existing entry with the hold's sparse placeholder fields. The reviewer
// verifies per entry.notes, edits commercial.json directly, then deletes
// the hold. (Sprint 2 ship-check, 2026-07-13.)
function isReviewHold(entry) {
  return entry._reviewHold === true;
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
  // A recoupment claim with no parseable date can't be applied without producing
  // invalid data (recouped=true + missing/garbage recoupedDate). Require a clean
  // YYYY/YYYY-MM date; otherwise route to manual review.
  const date = cleanNullish(entry.recoupedDate);
  if (!date || !RECOUPED_DATE_RE.test(date)) return false;
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
  // cleanNullish() collapses "null"/"undefined"/"" sentinels to undefined so a
  // bad LLM field never overwrites an existing value or writes invalid data.
  const designation = cleanNullish(entry.designation);
  const capitalizationSource = cleanNullish(entry.capitalizationSource);
  const costMethodology = cleanNullish(entry.costMethodology);
  const recoupedDate = cleanNullish(entry.recoupedDate);
  const recoupedSource = cleanNullish(entry.recoupedSource);
  const notes = cleanNullish(entry.notes);
  if (designation) result.designation = designation;
  if (entry.capitalization != null) result.capitalization = entry.capitalization;
  if (capitalizationSource) result.capitalizationSource = capitalizationSource;
  if (entry.weeklyRunningCost != null) result.weeklyRunningCost = entry.weeklyRunningCost;
  if (costMethodology) result.costMethodology = costMethodology;
  if (entry.recouped != null) result.recouped = entry.recouped;
  if (recoupedDate) result.recoupedDate = recoupedDate;
  if (recoupedSource) result.recoupedSource = recoupedSource;
  if (notes) result.notes = notes;
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
  cleanNullish,
  meetsConfidenceThreshold,
  hasRecoupedClaim,
  isReviewHold,
  isAutoApplyableClaim,
  buildCommercialEntry,
};
