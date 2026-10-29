// Pure decision function: should a closed show that was never reported as
// recouped be auto-classified with a loss label? Used by
// scripts/classify-stale-closures.js + tested in
// tests/unit/classify-stale-closure.test.mjs.
//
// Which loss label: Fizzle or Flop only when an estimate of how much came
// back supports one (owner 2026-10-18, BRO-5623). With none the row stays
// TBD, shown as Undisclosed, and is flagged needsLossEvidence: labelling a
// silent closure Did Not Recoup is a person's call per show. The owner
// labelled seven that way by data plan (BRO-5645) and kept The Music Man 2022
// and John Proctor Is the Villain Undisclosed, since they may have recouped
// quietly. Manual review via humanReviewedDesignation can upgrade or downgrade.
//
// Why direct-to-commercial.json (per Code Design reviewer redesign):
// Inferred-Fizzle is deterministic policy from local state — not a "claim
// awaiting review." Routing it through the pending-review queue + auto-apply
// gate would require special-casing the gate (INTERNAL_AUTO_APPLY_SOURCES),
// which is a regression from the value-driven gate's discipline.

const GRACE_DAYS_DEFAULT = 7;
const MAX_AGE_DAYS_DEFAULT = 365;
const RECENT_SIGNAL_DAYS_DEFAULT = 30;
// Owner decision 2026-10-24 (BRO-6158, superseding policy B's 183-day wait): a
// closed show gets our best-estimate designation right away from the model or
// an analyst's % returned, stamped designationBasis 'model-estimate' so the
// page shows it as our estimate. Some shows recoup after they close (The Piano
// Lesson took about 14 months); the apply gate resets an estimate when that is
// announced.
const {
  DESIGNATION_BASES, estimatedDesignationForClosed,
  UNRECOUPED_DESIGNATIONS, isLossDesignation, isUnrecoupedDesignation, RECOUPED_DESIGNATIONS,
} = require('./commercial-designations');

/**
 * Our estimated designation for a closed, unannounced show (Flop under 30%
 * returned, Fizzle 30%+, Trickle or Windfall at 100%+), from the record's own
 * estimate or our model at any data quality. null with no figure at all: the
 * row stays TBD and is flagged needsLossEvidence.
 */
function lossLabelFor(entry) {
  return estimatedDesignationForClosed(entry);
}

// Production types where auto-Fizzle is unsafe — these shows may have closed
// on Broadway but continued life elsewhere with separate recoupment economics.
// A return engagement is not one: it closes on Broadway like any run, so it
// gets the estimate label too (BRO-6218, owner rule BRO-6158: no TBD for
// closed shows).
const SKIP_PRODUCTION_TYPES = new Set([
  'tour-stop',
  'international-transfer',
  'International Transfer',
  // 'enhancement' deals (LCT etc.) — DO classify, the enhancement investors
  // really did lose money if the show closed without recoupment. But the
  // designation is delicate; surface as 'human-review' instead of auto-Fizzle.
]);

const SKIP_DESIGNATIONS = new Set([
  'Nonprofit',        // pure nonprofits — recoupment doesn't apply
  'Tour Stop',        // tour stops never measured against original cap
  ...RECOUPED_DESIGNATIONS, // already classified as recouped
  ...UNRECOUPED_DESIGNATIONS, // already classified as not recouped (loss labels, Wait & See)
]);

function daysAgo(isoString, now = Date.now()) {
  if (!isoString) return Infinity;
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / 86_400_000;
}

/**
 * Decide what to do with a single closed show.
 *
 * Inputs (caller computes once per run):
 *   show         — shows.json entry (status, closingDate, openingDate)
 *   entry        — commercial.json entry for the same slug (may be undefined)
 *   pending      — commercial-pending-review.json entries for the slug array
 *   archive      — commercial-pending-archive.json entries for the slug
 *   now          — Date.now() override for tests
 *   thresholds   — { graceDays, maxAgeDays, recentSignalDays,
 *                    requireLossEvidence }
 *
 * Returns one of:
 *   { action: 'wait',         reason }   — within grace period; do nothing
 *   { action: 'no-change',    reason }   — already classified; do nothing
 *   { action: 'skip-carve-out', reason } — special production type / designation
 *   { action: 'classify-fizzle', reason, designation: our estimated label,
 *     designationBasis: 'model-estimate' (owner verdicts keep 'no-recoupment-announced'), confidence } — auto-apply
 *   { action: 'flag-needs-loss-evidence', reason } — stays TBD, flagged
 *   { action: 'human-review',   reason } — late recoupment signal, escalate
 */
/** True when deep-research has actually tried this record. */
function hasBeenResearched(entry) {
  return Boolean(entry && (
    (typeof entry.researchAttempts === 'number' && entry.researchAttempts > 0) ||
    entry.lastResearchedAt ||
    entry.researchedAt ||
    (entry.deepResearch && entry.deepResearch.verifiedDate)
  ));
}

function classifyStaleClosure({ show, entry, pending, archive, now, thresholds }) {
  const t = thresholds || {};
  const graceDays = t.graceDays ?? GRACE_DAYS_DEFAULT;
  const maxAgeDays = t.maxAgeDays ?? MAX_AGE_DAYS_DEFAULT;
  const recentSignalDays = t.recentSignalDays ?? RECENT_SIGNAL_DAYS_DEFAULT;
  const nowMs = now ?? Date.now();
  const ownerDesignation = isLossDesignation(entry?.ownerDesignationAfterWindow)
    ? entry.ownerDesignationAfterWindow : null;

  if (!show) return { action: 'no-change', reason: 'no show data' };
  if (show.status !== 'closed') return { action: 'no-change', reason: `status=${show.status}` };

  const closingDate = show.closingDate;
  if (!closingDate) return { action: 'no-change', reason: 'no closingDate' };

  const daysClosed = daysAgo(closingDate, nowMs);
  if (!Number.isFinite(daysClosed)) return { action: 'no-change', reason: 'invalid closingDate' };
  if (daysClosed < graceDays) return { action: 'wait', reason: `grace-period (${Math.floor(daysClosed)}d < ${graceDays}d)` };
  // The age cap keeps historical shows we never researched out of the scan.
  // A TBD record that WAS deep-researched or owner-reviewed is exempt: otherwise a show that
  // aged past the cap before its research landed stays TBD forever
  // (our-town, job-2024; BRO-4985).
  const reviewedTbd = entry?.designation === 'TBD' && (hasBeenResearched(entry) || ownerDesignation);
  if (daysClosed > maxAgeDays && !reviewedTbd) return { action: 'no-change', reason: `too-old (${Math.floor(daysClosed)}d > ${maxAgeDays}d)` };

  // Honor manual review locks
  if (entry?.humanReviewedDesignation === true) {
    return { action: 'no-change', reason: 'humanReviewedDesignation:true' };
  }

  // Already recouped — no Fizzle
  if (entry?.recouped === true) return { action: 'no-change', reason: 'already-recouped' };

  // Already classified as loss / nonprofit / tour
  if (entry?.designation && SKIP_DESIGNATIONS.has(entry.designation)) {
    return { action: 'no-change', reason: `designation=${entry.designation}` };
  }

  // Production type carve-outs (tours, transfers continue elsewhere)
  if (entry?.productionType && SKIP_PRODUCTION_TYPES.has(entry.productionType)) {
    return { action: 'skip-carve-out', reason: `productionType=${entry.productionType}` };
  }

  // Enhancement deals (LCT etc.) — auto-Fizzle is sensitive because the
  // nonprofit org's reputation is on the line. Escalate.
  if (entry?.productionType === 'enhancement') {
    return { action: 'human-review', reason: 'enhancement-deal closure needs producer-list review' };
  }

  // Check for recent recoupment signal in pending/archive (in case a trade
  // article landed in the last N days but hasn't been applied yet).
  const recentSignalSources = [];
  for (const e of [pending, archive].filter(Boolean)) {
    if (e.recouped === true || e._recoupedClaim === true) {
      const sig = daysAgo(e.researchedAt || e.detectedAt, nowMs);
      if (sig <= recentSignalDays) recentSignalSources.push({ source: e.detectedBy, daysAgo: sig });
    }
  }
  if (recentSignalSources.length > 0) {
    return {
      action: 'human-review',
      reason: `late-recoupment-signal: ${recentSignalSources.map(s => s.source).join(', ')}`,
    };
  }

  // BEFORE auto-Fizzle: confirm deep-research actually TRIED this show. If
  // the show closed before our scraper coverage existed (e.g. pre-2026), our
  // "no trade-press recoupment found" is meaningless — we never looked. Only
  // auto-Fizzle when an entry exists AND has been researched (researchAttempts
  // > 0 OR a researchedAt timestamp). Otherwise escalate to human review so
  // an operator can backfill. This is the User Impact reviewer's
  // producer-reputation risk mitigation.
  // An explicitly saved owner verdict has already had that human review.
  // BRO-6158: an estimate needs no research (it claims no silence), only a figure.
  if (!hasBeenResearched(entry) && !ownerDesignation && !lossLabelFor(entry)) {
    const tbdEntry = entry?.designation === 'TBD';
    return {
      action: 'human-review',
      reason: `closed ${Math.floor(daysClosed)}d ago but deep-research never ran — needs operator backfill before any auto-classification`,
      // BRO-3490: not a judgment call. deep-research-commercial.js ranks
      // these right after the explicit queue (staleClosuresNeedingResearch), so
      // the classifier does not file a Linear card for them.
      // Only for a TBD entry: that is what the research tier selects. A show
      // with no entry stays a judgment card so it cannot fall between both.
      needsResearch: tbdEntry,
    };
  }

  // Closed >graceDays + no recoupment news + no carve-out: label our estimate
  // now (BRO-6158). requireLossEvidence is the kill switch: always flag, never
  // label (STALE_CLOSURE_REQUIRE_LOSS_EVIDENCE=1).
  const reviewEvidence = ownerDesignation ? 'owner-reviewed' : 'deep-researched';
  if (t.requireLossEvidence) {
    return {
      action: 'flag-needs-loss-evidence',
      reason: `closed ${Math.floor(daysClosed)}d ago, ${reviewEvidence}, no trade-press recoupment found; loss labels on silence are switched off`,
    };
  }
  // An unreviewed pending row saying the show recouped blocks a loss label at
  // any age: "no recoupment found" is false while our own research says it did
  // (BRO-5894 backfill: Waitress, The Humans sat pending past the signal window).
  if (!ownerDesignation && pending && (pending.recouped === true || pending._recoupedClaim === true)) {
    return {
      action: 'flag-needs-loss-evidence',
      reason: `closed ${Math.floor(daysClosed)}d ago; a pending research row says it recouped, so no loss label until it is reviewed`,
    };
  }
  const designation = ownerDesignation || lossLabelFor(entry);
  if (!designation) {
    return {
      action: 'flag-needs-loss-evidence',
      reason: `closed ${Math.floor(daysClosed)}d ago, no recoupment found, and no figure at all to estimate how much came back`,
    };
  }
  return {
    action: 'classify-fizzle',
    reason: ownerDesignation
      ? `owner-reviewed ${ownerDesignation}; closed ${Math.floor(daysClosed)}d ago`
      : `closed ${Math.floor(daysClosed)}d ago, no recoupment announced; our estimate`,
    designation,
    designationBasis: ownerDesignation ? DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED : DESIGNATION_BASES.MODEL_ESTIMATE,
    ...(ownerDesignation ? { humanReviewedDesignation: true } : {}),
    confidence: 'high',
  };
}

/** Materialize the classifier's decision without changing unrelated figures or sources. */
function buildClassifiedClosureEntry(entry, show, result, now = Date.now()) {
  const existing = entry || {};
  const { needsLossEvidence: _flag, ...rest } = existing;
  const stamp = new Date(now).toISOString();
  return {
    ...rest,
    designation: result.designation,
    designationBasis: result.designationBasis,
    ...(result.humanReviewedDesignation === true ? { humanReviewedDesignation: true } : {}),
    // An estimate never asserts "Not Recouped" (BRO-6158): recouped stays as recorded.
    recouped: existing.recouped === true ? true
      : result.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE ? (existing.recouped ?? null) : false,
    recoupedSource: existing.recoupedSource ||
      (result.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE ? null
        : `Inferred: closed ${Math.floor((now - Date.parse(show.closingDate)) / 86_400_000)} days ago, no trade-press recoupment found`),
    classifiedBy: 'classify-stale-closures',
    classifiedAt: stamp,
    classifiedReason: result.reason,
    lastUpdated: stamp,
    firstAdded: existing.firstAdded || stamp,
  };
}

/**
 * The reverse case (BRO-4623): a Fizzle this classifier wrote on a show that
 * is no longer closed (update-show-status.js reopened it, or a closing date
 * was corrected). A loss label on a running show is wrong on /biz, and
 * validate-data warns about it. Returns the entry with the classifier's own
 * outcome undone (TBD, recoupment unknown, its inferred source removed), or
 * null when there is nothing to undo. Never touches a hand-set label, nor a
 * Fizzle whose "did not recoup" now rests on a real citation (a person
 * replaced the inferred source): validate-data's warning leaves that to them.
 */
const INFERRED_SOURCE_PREFIX = 'Inferred: closed';

function undoAutoFizzleOnRunningShow(entry, show) {
  if (!entry || !show || !show.status || show.status === 'closed') return null;
  if (!isLossDesignation(entry.designation)) return null;
  if (entry.humanReviewedDesignation === true) return null;
  // A silence-based label (policy B, BRO-5020) is inferred whoever wrote it.
  const silence = entry.designationBasis === DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED
    || entry.designationBasis === DESIGNATION_BASES.MODEL_ESTIMATE;
  if (!silence && entry.classifiedBy !== 'classify-stale-closures') return null;
  const inferred = entry.recoupedSource == null || (typeof entry.recoupedSource === 'string' && entry.recoupedSource.startsWith(INFERRED_SOURCE_PREFIX));
  if (!inferred && !silence) return null;
  const out = { ...entry, designation: 'TBD', recoupedSource: inferred ? null : entry.recoupedSource };
  if (out.recouped === false) out.recouped = null;
  delete out.classifiedBy;
  delete out.classifiedAt;
  delete out.classifiedReason;
  delete out.designationBasis;
  return out;
}

/**
 * The closed-TBD sweep for writers outside the daily classifier
 * (cleanup-commercial-data.js). Returns
 *   { action: 'label', designation, designationBasis: 'model-estimate' } we have an estimate (BRO-6158),
 *   { action: 'flag' }                                  no figure at all, or the kill switch is on,
 *   null                                                nothing to do.
 * Never touches a locked, recouped, non-TBD or already-flag-ruled row. Writes
 * no prose: the site renders the caveat from designationBasis.
 */
function closedTbdLossAction(entry, show, { now = Date.now(), requireLossEvidence = false } = {}) {
  if (!entry || entry.designation !== 'TBD' || !show || show.status !== 'closed') return null;
  if (entry.humanReviewedDesignation === true || entry.recouped === true) return null;
  // The daily classifier applies the saved owner verdict and review stamp.
  // Cleanup must not preempt it with an automatic label.
  if (isLossDesignation(entry.ownerDesignationAfterWindow)) return null;
  // Tours and transfers keep earning elsewhere, same carve-out as the classifier.
  if (entry.productionType && SKIP_PRODUCTION_TYPES.has(entry.productionType)) return null;
  const days = daysAgo(show.closingDate, now);
  if (!Number.isFinite(days)) return null;
  const designation = lossLabelFor(entry);
  // A win-side estimate beside a recorded non-recoupment is contradictory: a person looks.
  if (designation && !isUnrecoupedDesignation(designation) && entry.recouped === false) return { action: 'flag' };
  if (requireLossEvidence || !designation) {
    return 'needsLossEvidence' in entry ? null : { action: 'flag' };
  }
  return { action: 'label', designation, designationBasis: DESIGNATION_BASES.MODEL_ESTIMATE };
}

module.exports = {
  hasBeenResearched,
  closedTbdLossAction,
  GRACE_DAYS_DEFAULT,
  MAX_AGE_DAYS_DEFAULT,
  RECENT_SIGNAL_DAYS_DEFAULT,
  lossLabelFor,
  SKIP_PRODUCTION_TYPES,
  SKIP_DESIGNATIONS,
  classifyStaleClosure,
  buildClassifiedClosureEntry,
  undoAutoFizzleOnRunningShow,
};
