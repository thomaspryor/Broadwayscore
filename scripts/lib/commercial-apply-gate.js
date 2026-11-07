// Pure decision functions for apply-commercial-pending.js.
// Tested by tests/unit/commercial-apply-gate.test.mjs.

const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');
const { VALID_DESIGNATIONS, canonicalDesignation, DESIGNATION_BASES, VALID_DESIGNATION_BASES, isLossDesignation, isUnrecoupedDesignation, lossDesignationFor, returnedEstimatePct, REPORTED_WIN_DESIGNATIONS } = require('./commercial-designations');
const { refuseClearedField } = require('./cleared-field-guard');
const { checkRecoupmentProduction } = require('./recoupment-production-guard');
const { addedPlaceholderSources } = require('./commercial-sources');
const { capitalizationBasisFromText, retagCapitalizationBasis } = require('./public-source-text');

const { carryOurRecoupEstimate, ourRecoupRangePct } = require('./our-recoup-estimate');

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
// BRO-4990: a backfill pass that found nothing (noData) is the same: a
// record of the attempt with no figures, never appliable.
function isReviewHold(entry) {
  return entry._reviewHold === true || entry.noData === true;
}

// BRO-4990: backfilled research (older closed shows the event triggers never
// queued) is unreviewed LLM output about shows that never had a record. It
// must not reach live /biz in bulk (launch freeze, owner plan 2026-10-10), so
// it applies only one show at a time via --show=SLUG, after a human checks it.
function requiresHumanReview(entry) {
  return entry.requiresHumanReview === true;
}

const BACKFILL_TAG = 'BRO-4990';

// BRO-5041: a held row is released by name (--release-held). Refuse when the
// record already carries something a person or a verified pass put there: a
// human-reviewed or non-TBD label, or a recoupment on file. Also refuse a row
// whose own label says the show recouped (Easy Winner/Windfall/Miracle): the
// release drops the row's recoupment claim, and validation requires
// recouped:true for those labels. Also refuse a row the BRO-5020 truth
// review stamped anything but "released" (held, cap-released, rejected): its
// figures or label were not stated on a fetched page, and releasing it anyway
// published a tax-credit back-solve and unsourced Flop/Fizzle labels
// (run 38126158629). An owner approval (ownerApproved: true on the row) is the
// only override. Null = may release.
const RECOUPED_LABELS = REPORTED_WIN_DESIGNATIONS;
function heldReleaseRefusal(existing, row) {
  const verdict = row && row.truthReview && row.truthReview.verdict;
  if (verdict && verdict !== 'released' && row.ownerApproved !== true) return `truth review verdict is "${verdict}", not "released"`;
  const rowLabel = row && (canonicalDesignation(cleanNullish(row.designation)) || cleanNullish(row.designation));
  if (rowLabel && RECOUPED_LABELS.includes(rowLabel)) return `row says "${rowLabel}", which needs a recoupment a person confirms`;
  if (!existing) return null;
  if (existing.humanReviewedDesignation === true) return 'designation was set by a human review';
  const designation = canonicalDesignation(cleanNullish(existing.designation)) || cleanNullish(existing.designation);
  if (designation && designation !== 'TBD') return `record already has designation "${designation}"`;
  if (existing.recouped === true || existing.humanReviewedRecouped === true) return 'record already has a recoupment on file';
  return null;
}

// A released row never publishes a "recouped" claim: research recoupment
// calls cited to forums or other shows are settled by a person (BRO-5041).
// A cited "did not recoup" stays, because a Flop/Fizzle label needs
// recouped:false (commercial-record-checks.js loss-designation policy).
// _recoupedClaim (the research's own "it recouped" flag) goes too, or the
// recouped-claim gate would still hold the row.
function withoutRecoupmentClaim(entry) {
  const { _recoupedClaim, ...row } = entry;
  if (row.recouped !== true) return row;
  const { recouped, recoupedDate, recoupedSource, ...rest } = row;
  return rest;
}

// A released row fills gaps; the record's own notes stay, and so does its
// recoupment citation while the recoupment answer is unchanged (BRO-5041).
function keepExistingPublicText(entry, existing) {
  if (!existing) return entry;
  if (typeof existing.notes === 'string' && existing.notes.trim()) entry.notes = existing.notes;
  if (existing.recoupedSource && existing.recouped === entry.recouped) entry.recoupedSource = existing.recoupedSource;
  return entry;
}

// Mark a fresh research result as held backfill and count the attempt on the
// pending row (backfill shows have no commercial.json record to count on).
// `reset` mirrors --force, which restarts the count like the non-backfill path.
function holdForBackfill(entry, prior, { reset = false } = {}) {
  entry.requiresHumanReview = true;
  entry.backfill = BACKFILL_TAG;
  entry.researchAttempts = reset ? 1 : ((prior && prior.researchAttempts) || 0) + 1;
  return entry;
}

// Every writer that REPLACES a pending row (instead of spreading the old one)
// must pass it through here, so a re-research never silently drops the hold
// and lets the weekly bulk apply publish unreviewed backfill.
// tests/unit/backfill-hold-coverage.test.mjs enforces this.
function carryHumanReviewHold(prev, next) {
  if (prev && prev.requiresHumanReview === true && next.requiresHumanReview !== true) {
    next.requiresHumanReview = true;
    if (prev.backfill && !next.backfill) next.backfill = prev.backfill;
    if (prev.researchAttempts && !next.researchAttempts) next.researchAttempts = prev.researchAttempts;
  }
  return next;
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

/**
 * What a verified recoupment claim may do to the existing designation
 * (BRO-4623 item 5). classify-stale-closures.js auto-labels a closed show
 * "Fizzle" 30 days after closing when it finds no recoupment news; Purpose
 * then recouped ~9 months after closing via the revived NY State tax credit.
 *   'keep'  - no loss designation in the way; the claim overlays as before
 *   'reset' - an INFERRED loss label (classifiedBy classify-stale-closures,
 *             or designationBasis 'no-recoupment-announced', no human lock):
 *             the silence it was inferred from is gone, so the designation
 *             goes back to TBD for research/model to set (owner policy B,
 *             BRO-5020: a silence-based label must flip on recoupment news)
 *   'block' - a human-locked (humanReviewedDesignation) or otherwise
 *             non-inferred loss designation: a human decides, never auto
 */
function recoupClaimDesignationAction(existing) {
  if (!existing) return 'keep';
  const designation = canonicalDesignation(existing.designation) || existing.designation;
  // A verified recoupment contradicts every loss label (validate-data.js
  // rejects one with recouped:true).
  // Our estimate gives way to a verified recoupment, on any tier (BRO-6158).
  if (existing.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE && existing.humanReviewedDesignation !== true
    && designation && designation !== 'TBD') return 'reset';
  if (!isUnrecoupedDesignation(designation)) return 'keep';
  if (existing.humanReviewedDesignation === true) return 'block';
  if (existing.classifiedBy === 'classify-stale-closures') return 'reset';
  if (existing.designationBasis === DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED) return 'reset';
  return 'block';
}

/**
 * Decide, per figure, whether it prints as fact. A capitalization or weekly running cost is fact only when a
 * cited page was read and states it (figureEvidence[field].found), in which case the quote becomes its
 * source text; otherwise isEstimate is set and the AI-written source text is dropped. Mutates `result`.
 * Shared by apply-commercial-pending (verified evidence) and batch-commercial-research --apply (no verifier,
 * so every figure lands as an estimate): there is exactly one place that decides what may print as fact.
 */
const isSecFilingUrl = (url) => { try { const u = new URL(url); return /(^|\.)sec\.gov$/i.test(u.hostname) && /^\/Archives\/edgar\/data\//i.test(u.pathname); } catch { return false; } };

// Merged records start from the existing row, so a stale 'wayback' mark is cleared when the figure is re-read live or lost.
function setFigureVerifiedVia(result, field, via) {
  const next = { ...result.figureVerifiedVia };
  if (via) next[field] = via; else delete next[field];
  if (Object.keys(next).length) result.figureVerifiedVia = next; else delete result.figureVerifiedVia;
}

function applyFigureEvidence(result, entry, figureEvidence = {}, existing = null) {
  for (const field of ['capitalization', 'weeklyRunningCost']) {
    if (entry[field] == null) continue;
    const evidence = figureEvidence[field];
    // BRO-6191: a figure a person cleared is not refilled by an uncited answer.
    if (refuseClearedField(existing, entry, field, evidence)) continue;
    const verified = evidence?.found === true && Boolean(evidence.quote && evidence.source?.url);
    result.isEstimate = { ...result.isEstimate, [field]: !verified || entry.isEstimate?.[field] === true };
    const sourceField = field === 'capitalization' ? 'capitalizationSource' : 'weeklyRunningCostSource';
    if (verified) {
      const host = new URL(evidence.source.url).hostname.replace(/^www\./, '');
      result[sourceField] = `${host}: "${evidence.quote}"`;
      result.sources = [evidence.source, ...(result.sources || []).filter(s => s.url !== evidence.source.url)];
      if (field === 'weeklyRunningCost') result.costMethodology = 'trade-reported';
      // BRO-6392: the figure was read from an archive copy because the live page blocks every fetcher.
      setFigureVerifiedVia(result, field, evidence.verifiedVia);
    } else {
      delete result[sourceField];
      setFigureVerifiedVia(result, field, undefined);
      if (field === 'weeklyRunningCost') result.costMethodology = 'deep-research';
    }
    // A Form D maximum or "up to" quote prints "up to $X" (BRO-5660). A
    // restated, unchanged figure whose new wording says neither keeps the
    // basis set for it (othello-2025's maximum has no "up to" in its source).
    if (field === 'capitalization') {
      const keep = existing && existing.capitalizationBasis && existing.capitalization === entry.capitalization
        && !capitalizationBasisFromText(result.capitalizationSource);
      if (keep) result.capitalizationBasis = existing.capitalizationBasis;
      else retagCapitalizationBasis(result);
      // BRO-5732: a Form D's headline figure is the offering MAXIMUM. When the
      // verified quote is a bare Form D number (neither "sold" nor "up to"
      // wording), default to the ceiling instead of printing it as the raise.
      if (verified && !result.capitalizationBasis && isSecFilingUrl(evidence.source.url)) result.capitalizationBasis = 'maximum';
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
  const { isClaimAutoApply = false, mergeExisting = false, normalizeSources = (x) => x, figureEvidence = {} } = opts;
  // mergeExisting (held-row release, BRO-5041) also starts from the record so
  // its sources, model* fields and figure sources survive the overlay.
  const overlay = (isClaimAutoApply || mergeExisting) && existing;
  const result = overlay ? { ...existing } : {};
  carryOurRecoupEstimate(result, existing);
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
    // A brand-new record from a recoupment claim carries no label; TBD until
    // one is set (BRO-5824: Farinelli and Sunday in the Park were written with
    // no designation and failed validation).
    if (!result.designation) result.designation = 'TBD';
  }
  const costRefused = entry.weeklyRunningCost != null && refuseClearedField(existing, entry, 'weeklyRunningCost', figureEvidence.weeklyRunningCost);
  if (entry.capitalization != null) result.capitalization = entry.capitalization;
  if (capitalizationSource) result.capitalizationSource = capitalizationSource;
  if (entry.weeklyRunningCost != null && !costRefused) result.weeklyRunningCost = entry.weeklyRunningCost;
  if (costMethodology && !costRefused) result.costMethodology = costMethodology;
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
  // The overlay keeps the old record's recoupment evidence; a research row that
  // says it did not recoup must not leave a recoupment date or lock behind
  // (BRO-5639 review).
  if (overlay && !isClaimAutoApply && entry.recouped != null && entry.recouped !== true) {
    delete result.recoupedDate;
    delete result.recoupedSource;
    delete result.humanReviewedRecouped;
    if (result.isEstimate) { result.isEstimate = { ...result.isEstimate }; delete result.isEstimate.recoupedDate; }
  }
  // A research label replaces an inferred classify-stale-closures label, so the
  // overlay must not keep that inference's attribution (BRO-5639).
  if (overlay && !isClaimAutoApply && designation && existing.classifiedBy === 'classify-stale-closures') {
    delete result.classifiedBy;
    delete result.classifiedAt;
    delete result.classifiedReason;
  }
  if (isClaimAutoApply && entry.recouped === true && recoupClaimDesignationAction(existing) === 'reset') {
    // The inferred "closed, no recoupment found" Fizzle is contradicted by a
    // verified recoupment: drop it and its inference stamps.
    result.designation = designation || 'TBD';
    delete result.designationBasis;
    delete result.needsLossEvidence;
    delete result.classifiedBy;
    delete result.classifiedAt;
    delete result.classifiedReason;
  }
  if (Array.isArray(entry.sources) && entry.sources.length > 0) {
    // A placeholder link (homepage, Wikipedia, this site) cites nothing; the
    // automated writers drop any they would ADD, the same rule the plan runner
    // and tip writers refuse on (commercial-record-checks.js, BRO-5264).
    const existingSources = Array.isArray(existing?.sources) ? existing.sources : [];
    const incoming = normalizeSources(entry.sources);
    const dropped = addedPlaceholderSources(incoming, existingSources);
    for (const d of dropped) console.warn(`  ⚠️  Dropped ${d.kind} source link ${d.url} (cites nothing; link the article or filing)`);
    const droppedIdx = new Set(dropped.map(d => d.idx));
    const normalized = incoming.filter((s, i) => s && !droppedIdx.has(i));
    // Every new link was a placeholder: keep the record's own sources rather
    // than writing it with none.
    if (normalized.length === 0 && existingSources.length > 0 && !overlay) result.sources = existingSources;
    if (normalized.length > 0) {
      if (overlay && existingSources.length) {
        const existingUrls = new Set(existingSources.map(s => s.url).filter(Boolean));
        result.sources = [...existing.sources, ...normalized.filter(s => !existingUrls.has(s.url))];
      } else {
        result.sources = normalized;
      }
    }
  }
  // A loss label from research takes the size the record being written can
  // support, not the one the research named (owner 2026-10-18, BRO-5636): a
  // from-scratch write carries no estimate, so it is Did Not Recoup until one
  // is recorded. An owner's approved or locked label is a person's verdict.
  const locked = entry.ownerApproved === true || existing?.humanReviewedDesignation === true || result.humanReviewedDesignation === true;
  if (designation && isLossDesignation(result.designation) && !locked) {
    result.designation = lossDesignationFor(returnedEstimatePct(result));
  }
  if (ourRecoupRangePct(result) && result.recouped !== true && existing?.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE) {
    result.designation = existing.designation;
    result.recouped = existing.recouped;
  }
  stampDesignationBasis(result, entry, existing);
  if (ourRecoupRangePct(result) && result.recouped !== true && existing?.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE) {
    result.designationBasis = DESIGNATION_BASES.MODEL_ESTIMATE;
  }
  // A later automated research refresh must not erase a verdict waiting for
  // the closure window. A verified recoupment still supersedes the loss.
  if (result.recouped === true) {
    delete result.ownerDesignationAfterWindow;
    delete result.ownerDesignationReviewedAt;
  } else if (existing && isLossDesignation(existing.ownerDesignationAfterWindow)) {
    result.ownerDesignationAfterWindow = existing.ownerDesignationAfterWindow;
    result.ownerDesignationReviewedAt = existing.ownerDesignationReviewedAt;
    if (existing.designation === 'TBD' && entry.ownerApproved !== true) {
      result.designation = 'TBD';
      delete result.designationBasis;
      if (result.recouped === false) result.recouped = null;
      result.needsLossEvidence = true;
    }
  }
  applyFigureEvidence(result, entry, figureEvidence, existing);
  return result;
}

/**
 * Every loss label carries a designationBasis (owner policy B, BRO-5020).
 * Order: the pending entry's own valid basis, then the existing record's basis
 * when the label is unchanged, else 'no-recoupment-announced' (the cautious
 * default: the page then says the label rests on silence). Any other label
 * drops the basis; a label other than TBD also settles needsLossEvidence.
 */
function stampDesignationBasis(result, entry, existing) {
  const d = result.designation;
  // A model estimate (BRO-6158) rests on our figures, not on a source, and may
  // sit on a recouped-side tier too; it keeps its basis wherever it is stamped.
  if (d && d !== 'TBD' && result.recouped !== true && (
    (entry && entry.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE)
    || (existing && existing.designation === d && existing.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE
      && !(entry && entry.designationBasis))
  ) && (isLossDesignation(d) || d === 'Trickle' || d === 'Windfall')) {
    result.designationBasis = DESIGNATION_BASES.MODEL_ESTIMATE;
    delete result.needsLossEvidence;
    return;
  }
  if (isLossDesignation(d)) {
    if (VALID_DESIGNATION_BASES.includes(entry && entry.designationBasis)) {
      result.designationBasis = entry.designationBasis;
    } else if (existing && existing.designation === d && VALID_DESIGNATION_BASES.includes(existing.designationBasis)) {
      result.designationBasis = existing.designationBasis;
    } else {
      result.designationBasis = DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED;
    }
    delete result.needsLossEvidence;
  } else {
    delete result.designationBasis;
    if (d && d !== 'TBD') delete result.needsLossEvidence;
  }
}

module.exports = {
  requiresHumanReview,
  BACKFILL_TAG,
  heldReleaseRefusal,
  withoutRecoupmentClaim,
  keepExistingPublicText,
  holdForBackfill,
  carryHumanReviewHold,
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
  stampDesignationBasis,
};
