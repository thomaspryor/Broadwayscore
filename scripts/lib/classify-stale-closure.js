// Pure decision function: should a closed show that was never reported as
// recouped be auto-classified as a financial Fizzle? Used by
// scripts/classify-stale-closures.js + tested in
// tests/unit/classify-stale-closure.test.mjs.
//
// Why "Fizzle" not "Flop": Fizzle (per src/config/commercial.ts) = "modest
// loss" — softer than Flop ("catastrophic loss"). Auto-classifying as Flop on
// inferred-absent-evidence risks reputational harm to producers whose shows
// quietly recouped via tour/film rights without a trade-press announcement.
// Fizzle is the conservative default; manual review via humanReviewedDesignation
// can upgrade or downgrade.
//
// Why direct-to-commercial.json (per Code Design reviewer redesign):
// Inferred-Fizzle is deterministic policy from local state — not a "claim
// awaiting review." Routing it through the pending-review queue + auto-apply
// gate would require special-casing the gate (INTERNAL_AUTO_APPLY_SOURCES),
// which is a regression from the value-driven gate's discipline.

const GRACE_DAYS_DEFAULT = 30;
const MAX_AGE_DAYS_DEFAULT = 365;
const RECENT_SIGNAL_DAYS_DEFAULT = 30;

// Production types where auto-Fizzle is unsafe — these shows may have closed
// on Broadway but continued life elsewhere with separate recoupment economics.
const SKIP_PRODUCTION_TYPES = new Set([
  'tour-stop',
  'return-engagement',
  'international-transfer',
  'International Transfer',
  // 'enhancement' deals (LCT etc.) — DO classify, the enhancement investors
  // really did lose money if the show closed without recoupment. But the
  // designation is delicate; surface as 'human-review' instead of auto-Fizzle.
]);

const SKIP_DESIGNATIONS = new Set([
  'Nonprofit',        // pure nonprofits — recoupment doesn't apply
  'Tour Stop',        // tour stops never measured against original cap
  'Miracle', 'Windfall', 'Easy Winner', 'Trickle',  // already classified as recouped
  'Fizzle', 'Flop',   // already classified as loss
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
 *   thresholds   — { graceDays, maxAgeDays, recentSignalDays }
 *
 * Returns one of:
 *   { action: 'wait',         reason }   — within grace period; do nothing
 *   { action: 'no-change',    reason }   — already classified; do nothing
 *   { action: 'skip-carve-out', reason } — special production type / designation
 *   { action: 'classify-fizzle', reason, designation: 'Fizzle', confidence } — auto-apply
 *   { action: 'human-review',   reason } — late recoupment signal, escalate
 */
function classifyStaleClosure({ show, entry, pending, archive, now, thresholds }) {
  const t = thresholds || {};
  const graceDays = t.graceDays ?? GRACE_DAYS_DEFAULT;
  const maxAgeDays = t.maxAgeDays ?? MAX_AGE_DAYS_DEFAULT;
  const recentSignalDays = t.recentSignalDays ?? RECENT_SIGNAL_DAYS_DEFAULT;
  const nowMs = now ?? Date.now();

  if (!show) return { action: 'no-change', reason: 'no show data' };
  if (show.status !== 'closed') return { action: 'no-change', reason: `status=${show.status}` };

  const closingDate = show.closingDate;
  if (!closingDate) return { action: 'no-change', reason: 'no closingDate' };

  const daysClosed = daysAgo(closingDate, nowMs);
  if (daysClosed < graceDays) return { action: 'wait', reason: `grace-period (${Math.floor(daysClosed)}d < ${graceDays}d)` };
  if (daysClosed > maxAgeDays) return { action: 'no-change', reason: `too-old (${Math.floor(daysClosed)}d > ${maxAgeDays}d)` };

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
  const wasResearched = entry && (
    (typeof entry.researchAttempts === 'number' && entry.researchAttempts > 0) ||
    entry.lastResearchedAt ||
    entry.researchedAt ||
    (entry.deepResearch && entry.deepResearch.verifiedDate)
  );
  if (!wasResearched) {
    return {
      action: 'human-review',
      reason: `closed ${Math.floor(daysClosed)}d ago but deep-research never ran — needs operator backfill before any auto-classification`,
    };
  }

  // Researched + closed >graceDays + no recoupment news + no carve-out → Fizzle
  return {
    action: 'classify-fizzle',
    reason: `closed ${Math.floor(daysClosed)}d ago, deep-researched, no trade-press recoupment found`,
    designation: 'Fizzle',
    confidence: 'high',
  };
}

module.exports = {
  GRACE_DAYS_DEFAULT,
  MAX_AGE_DAYS_DEFAULT,
  RECENT_SIGNAL_DAYS_DEFAULT,
  SKIP_PRODUCTION_TYPES,
  SKIP_DESIGNATIONS,
  classifyStaleClosure,
};
