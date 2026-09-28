'use strict';

/**
 * Tour backfill decisions (BRO-4211): which archived review files, flagged
 * wrongProduction on a Broadway show because they review the national tour,
 * move to that tour's own entry, and how each file is rewritten on the way.
 *
 * Pure functions so the rules are testable; scripts/audit-we-market-misroutes.js
 * --scope=tour does the file moves.
 *
 * Pilot lessons encoded here (Beetlejuice, 2026-09-28):
 * - The tour text sits in wrongFullText, not fullText.
 * - Verdicts judged against the Broadway run (contentVerification*, verifiedBy,
 *   possibleTourReview, tourSignal) must not travel with the file: the rebuild
 *   CV-promoted one straight back into wrongProduction.
 * - Most files carry no publishDate, so a launch-date cut cannot be the main rule.
 */

const TOUR_REASON_RE = /\btour(?:ing)?\b|national-tour|BWW regional\/tour/i;
// Pre-Broadway tryouts are their own production (regional), not the post-Broadway tour.
const TRYOUT_RE = /pre-Broadway|\btryout\b|out-of-town|world premiere/i;
// UK / West End tours are a different production from the North American tour.
const UK_RE = /\bUK tour\b|\bUK & Ireland\b|\.co\.uk\b|\bWest End\b/i;

function reasonText(data) {
  return [data.wrongProductionReason, data.wrongProductionNote, data.wrongProductionDetail]
    .filter(Boolean).join(' | ');
}

function toDate(s) {
  if (!s) return null;
  // "April 29th, 2019" is Invalid Date as written; drop the ordinal suffix.
  const d = new Date(String(s).replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Decide whether one file moves from a Broadway show to its tour.
 * Returns { action: 'move' | 'skip', reason }.
 * ctx: { broadwayOpeningDate?, tourLaunchDate? } (ISO strings; either may be null).
 */
function classifyTourBackfill(data, ctx = {}) {
  if (!data || data.wrongProduction !== true) return { action: 'skip', reason: 'not-flagged' };
  if (data.routedFromShowId) return { action: 'skip', reason: 'already-routed' };
  const why = reasonText(data);
  if (!TOUR_REASON_RE.test(why)) return { action: 'skip', reason: 'flag-not-tour' };
  if (data.isNonReview === true || data.isRoundupArticle === true) return { action: 'skip', reason: 'non-review' };
  if (data.duplicateOf || data.duplicateTextOf) return { action: 'skip', reason: 'duplicate' };
  if (data.wrongShow === true) return { action: 'skip', reason: 'wrong-show' };

  const text = String(data.fullText || data.wrongFullText || '').slice(0, 3000);
  // The contamination safety net's generic label "Tour/regional/pre-Broadway production"
  // names all three possibilities at once, so it is not tryout evidence on its own
  // (4 A Beautiful Noise tour-stop reviews carried it).
  const whyForTryout = why.replace(/Tour\/regional\/pre-Broadway/gi, '');
  if (TRYOUT_RE.test(whyForTryout) || TRYOUT_RE.test(text.slice(0, 1200))) return { action: 'skip', reason: 'tryout' };
  if (UK_RE.test(`${data.url || ''} ${why}`)) return { action: 'skip', reason: 'uk-production' };

  const pub = toDate(data.publishDate);
  const bway = toDate(ctx.broadwayOpeningDate);
  const launch = toDate(ctx.tourLaunchDate);
  if (pub && bway && pub < bway) return { action: 'skip', reason: 'before-broadway-opening' };
  // Allow a week of slack: roundups and first-stop reviews can predate the official launch listing.
  if (pub && launch && pub.getTime() < launch.getTime() - 7 * 86400000) return { action: 'skip', reason: 'before-tour-launch' };

  return { action: 'move', reason: 'tour-review' };
}

const BROADWAY_RELATIVE_FIELDS = [
  'contentVerification', 'contentVerificationPrev', 'contentVerificationPromoted',
  'verifiedBy', 'possibleTourReview', 'tourSignal',
];
const WRONG_PRODUCTION_FIELDS = [
  'wrongProduction', 'wrongProductionReason', 'wrongProductionNote', 'wrongProductionDetail',
  'wrongProductionDetectedAt', 'wrongProductionDetectedBy', 'wrongProductionFlaggedAt',
  'wrongProductionFlaggedBy', 'wrongProductionProvenance', 'wrongProductionSetBy',
  'wrongProductionConfidence', 'contentTierReason', 'incompleteReason', 'incompleteDetail',
];

/**
 * Rewrite a file for its new home on the tour. Returns a new object; the input is untouched.
 * The prior flag and verdicts are kept under routedPriorVerdicts so the move is reversible.
 */
function prepareTourMove(data, { fromShowId, tourId, at = new Date().toISOString() }) {
  const out = { ...data };
  const prior = {};
  for (const k of [...WRONG_PRODUCTION_FIELDS, ...BROADWAY_RELATIVE_FIELDS]) {
    if (k in out) { prior[k] = out[k]; delete out[k]; }
  }
  // The scoreability check's 'wrong_production' rejection judged the text against the
  // Broadway run (8 of the first 113 moves); other rejections (not_a_review, garbage) stand.
  if (out.rejectionReason === 'wrong_production') {
    for (const k of ['rejectionReason', 'rejectionReasoning', 'rejectedBy', 'rejectedAt']) {
      if (k in out) { prior[k] = out[k]; delete out[k]; }
    }
  }
  if (out.wrongFullText && !out.fullText) out.fullText = out.wrongFullText;
  delete out.wrongFullText;
  if (out.contentTier === 'invalid') {
    out.contentTier = out.fullText ? (out.textQuality === 'truncated' ? 'truncated' : 'complete') : 'excerpt';
  }
  out.showId = tourId;
  out.routedFromShowId = fromShowId;
  out.routedAt = at;
  out.routedReason = 'tour-backfill (BRO-4211): national tour review re-homed from the Broadway entry';
  if (Object.keys(prior).length) out.routedPriorVerdicts = prior;
  return out;
}

module.exports = { classifyTourBackfill, prepareTourMove, BROADWAY_RELATIVE_FIELDS };
