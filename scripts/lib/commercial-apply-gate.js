// Pure decision functions for apply-commercial-pending.js.
// Tested by tests/unit/commercial-apply-gate.test.mjs.

const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');
const { VALID_DESIGNATIONS, canonicalDesignation } = require('./commercial-designations');
const { checkRecoupmentProduction } = require('./recoupment-production-guard');

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
//
// `show` (REQUIRED: the shows.json record of the commercial.json key the
// claim will be written to) runs the BRO-4623 production check on claims
// already sitting in the queue: a recoupedDate before the production's first
// preview, or a recoupedSource URL about a tour / West End / Off-Broadway run
// (playbill.com/article/beetlejuice-national-tour-recoups on
// beetlejuice-2025), is never auto-applied. A claim whose show cannot be
// resolved is refused too (manual review): the check cannot run without it,
// and every auto-apply source (Friday scan, RSS poll) scans shows.json shows.
function isAutoApplyableClaim(entry, autoApplyClaimsFrom, show) {
  if (!Array.isArray(autoApplyClaimsFrom) || autoApplyClaimsFrom.length === 0) return false;
  if (!autoApplyClaimsFrom.includes(entry.detectedBy)) return false;
  if (entry.confidence !== 'high') return false;
  if (!entry.sourceHost || !TRUSTED_RECOUPMENT_HOSTS.has(entry.sourceHost)) return false;
  // A recoupment claim with no parseable date can't be applied without producing
  // invalid data (recouped=true + missing/garbage recoupedDate). Require a clean
  // YYYY/YYYY-MM date; otherwise route to manual review.
  const date = cleanNullish(entry.recoupedDate);
  if (!date || !RECOUPED_DATE_RE.test(date)) return false;
  if (!show) return false;
  if (!checkRecoupmentProduction({ show, recoupedDate: date, url: cleanNullish(entry.recoupedSource) }).ok) return false;
  return true;
}

// Loss designations a verified recoupment contradicts (validate-data.js
// rejects Fizzle/Flop with recouped:true).
const LOSS_DESIGNATIONS = new Set(['Fizzle', 'Flop']);

/**
 * What a verified recoupment claim may do to the existing designation
 * (BRO-4623 item 5). classify-stale-closures.js auto-labels a closed show
 * "Fizzle" 30 days after closing when it finds no recoupment news; Purpose
 * then recouped ~9 months after closing via the revived NY State tax credit.
 *   'keep'  - no loss designation in the way; the claim overlays as before
 *   'reset' - an INFERRED Fizzle/Flop (classifiedBy classify-stale-closures,
 *             no human lock): the evidence it was inferred from is gone, so
 *             the designation goes back to TBD for research/model to set
 *   'block' - a human-locked (humanReviewedDesignation) or otherwise
 *             non-inferred loss designation: a human decides, never auto
 */
function recoupClaimDesignationAction(existing) {
  if (!existing) return 'keep';
  const designation = canonicalDesignation(existing.designation) || existing.designation;
  if (!LOSS_DESIGNATIONS.has(designation)) return 'keep';
  if (existing.humanReviewedDesignation === true) return 'block';
  if (existing.classifiedBy === 'classify-stale-closures') return 'reset';
  return 'block';
}

/**
 * Decide, per figure, whether it prints as fact. A capitalization or weekly running cost is fact only when a
 * cited page was read and states it (figureEvidence[field].found), in which case the quote becomes its
 * source text; otherwise isEstimate is set and the AI-written source text is dropped. Mutates `result`.
 * Shared by apply-commercial-pending (verified evidence) and batch-commercial-research --apply (no verifier,
 * so every figure lands as an estimate): there is exactly one place that decides what may print as fact.
 */
function applyFigureEvidence(result, entry, figureEvidence = {}) {
  for (const field of ['capitalization', 'weeklyRunningCost']) {
    if (entry[field] == null) continue;
    const evidence = figureEvidence[field];
    const verified = evidence?.found === true && Boolean(evidence.quote && evidence.source?.url);
    result.isEstimate = { ...result.isEstimate, [field]: !verified || entry.isEstimate?.[field] === true };
    const sourceField = field === 'capitalization' ? 'capitalizationSource' : 'weeklyRunningCostSource';
    if (verified) {
      const host = new URL(evidence.source.url).hostname.replace(/^www\./, '');
      result[sourceField] = `${host}: "${evidence.quote}"`;
      result.sources = [evidence.source, ...(result.sources || []).filter(s => s.url !== evidence.source.url)];
      if (field === 'weeklyRunningCost') result.costMethodology = 'trade-reported';
    } else {
      delete result[sourceField];
      if (field === 'weeklyRunningCost') result.costMethodology = 'deep-research';
    }
  }
  return result;
}

// Build the commercial.json entry from a pending-review entry. When applying
// an auto-apply recoupment claim (the Friday pipeline hot path), the scraper
// only carries recoupment fields — start from the existing entry and overlay,
// or every other field (designation/capitalization/weeklyRunningCost/notes/
// sources) gets clobbered. Sources merge by URL dedupe so prior Reddit/SEC
// citations survive alongside the new trade-press article.
function buildCommercialEntry(entry, existing, opts = {}) {
  const { isClaimAutoApply = false, normalizeSources = (x) => x, figureEvidence = {} } = opts;
  const result = isClaimAutoApply && existing ? { ...existing } : {};
  // cleanNullish() collapses "null"/"undefined"/"" sentinels to undefined so a
  // bad LLM field never overwrites an existing value or writes invalid data.
  const designation = canonicalDesignation(cleanNullish(entry.designation));
  const capitalizationSource = cleanNullish(entry.capitalizationSource);
  const costMethodology = cleanNullish(entry.costMethodology);
  const recoupedDate = cleanNullish(entry.recoupedDate);
  const recoupedSource = cleanNullish(entry.recoupedSource);
  const notes = cleanNullish(entry.notes);
  if (designation) {
    result.designation = designation;
  } else {
    const raw = cleanNullish(entry.designation);
    if (raw) console.warn(`  ⚠️  Rejected non-canonical designation "${raw}" (valid: ${VALID_DESIGNATIONS.join(', ')})`);
    // Never wipe a known designation on a from-scratch rebuild because the
    // pending entry's label was missing or invalid.
    if (!result.designation && existing?.designation) {
      result.designation = canonicalDesignation(existing.designation) || existing.designation;
    }
  }
  if (entry.capitalization != null) result.capitalization = entry.capitalization;
  if (capitalizationSource) result.capitalizationSource = capitalizationSource;
  if (entry.weeklyRunningCost != null) result.weeklyRunningCost = entry.weeklyRunningCost;
  if (costMethodology) result.costMethodology = costMethodology;
  // An auto-apply claim never rewrites a recoupment already on record, dated
  // or human-locked: the claim's date is usually the article's month, later
  // than the real one. Its source URL still joins `sources` below. BRO-4657:
  // The Outsiders' sourced "2025-12" became the NYT story's "2026-01". A
  // recorded date that is wrong is corrected by an approved fix plan.
  const keepRecoupment = Boolean(isClaimAutoApply && existing && existing.recouped === true &&
    (cleanNullish(existing.recoupedDate) || existing.humanReviewedRecouped === true));
  if (!keepRecoupment) {
    if (entry.recouped != null) result.recouped = entry.recouped;
    if (recoupedDate) result.recoupedDate = recoupedDate;
    if (recoupedSource) result.recoupedSource = recoupedSource;
  }
  if (notes) result.notes = notes;
  if (isClaimAutoApply && entry.recouped === true && recoupClaimDesignationAction(existing) === 'reset') {
    // The inferred "closed, no recoupment found" Fizzle is contradicted by a
    // verified recoupment: drop it and its inference stamps.
    result.designation = designation || 'TBD';
    delete result.classifiedBy;
    delete result.classifiedAt;
    delete result.classifiedReason;
  }
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
  applyFigureEvidence(result, entry, figureEvidence);
  return result;
}

module.exports = {
  applyFigureEvidence,
  CONFIDENCE_ORDER,
  cleanNullish,
  VALID_DESIGNATIONS,
  canonicalDesignation,
  meetsConfidenceThreshold,
  hasRecoupedClaim,
  isReviewHold,
  isAutoApplyableClaim,
  recoupClaimDesignationAction,
  buildCommercialEntry,
};
