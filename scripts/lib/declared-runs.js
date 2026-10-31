'use strict';

/**
 * A show's declared other engagements of THIS production — priorRuns plus
 * tourLegs — in the one shape the ensemble prompt renders as "declared earlier
 * runs/tour legs" (scripts/llm-scoring/input-builder.ts). shows.json writes
 * tour legs as startDate/endDate; priorRuns as openingDate/closingDate.
 *
 * Before 2026-09-29 tourLegs never reached the scoring prompt, so a review from
 * a declared tour stop (The Car Man at Curve Leicester) could be rejected as
 * wrong_production even though date-guard (wrong-production-autoclear.js
 * isWithinTourLeg) and the content verifier accept it.
 *
 * @param {{priorRuns?: unknown, tourLegs?: unknown}} show shows.json entry
 * @returns {Array<{openingDate?: string, closingDate?: string, venue?: string, note?: string}>|null}
 */
function declaredRunsForPrompt(show) {
  if (!show) return null;
  const runs = [];
  if (Array.isArray(show.priorRuns)) {
    for (const p of show.priorRuns) if (p && typeof p === 'object') runs.push(p);
  }
  if (Array.isArray(show.tourLegs)) {
    for (const l of show.tourLegs) {
      if (l && typeof l === 'object') {
        runs.push({ openingDate: l.startDate, closingDate: l.endDate, venue: l.venue, note: 'tour leg' });
      }
    }
  }
  return runs.length ? runs : null;
}

// venue-write-guard-ok: builds an in-memory prompt-context list; nothing here is written to shows.json or a review file
module.exports = { declaredRunsForPrompt };
