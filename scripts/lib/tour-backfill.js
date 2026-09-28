'use strict';

/**
 * Tour backfill decisions (BRO-4211): which archived review files, flagged
 * wrongProduction on a Broadway show because they review the national tour,
 * move to that tour's own entry, and how each file is rewritten on the way.
 *
 * Pure functions so the rules are testable; scripts/sweep-tour-reviews.js does
 * the file moves.
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

// A tour closes; later reviews of the same title belong to a later tour (Shucked
// has a second one from 2026). Reviews trail the last stop by a few weeks.
const AFTER_CLOSE_SLACK_MS = 60 * 86400000;

/** Earliest time the pipeline saw this file: the stand-in date for an undated review. */
function firstSeen(data) {
  const ts = [data.firstSeenAt, data.urlDiscoveredAt, data.textFetchedAt].map(toDate).filter(Boolean);
  return ts.length ? new Date(Math.min(...ts.map(d => d.getTime()))) : null;
}

/**
 * Decide whether one file moves from a Broadway show to its tour.
 * Returns { action: 'move' | 'skip', reason }.
 * ctx: { broadwayOpeningDate?, tourLaunchDate?, tourClosingDate?, otherToursOfTitle? }
 * (ISO strings, either may be null; otherToursOfTitle = how many OTHER tours share the title).
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
  const close = toDate(ctx.tourClosingDate);
  if (pub && close && pub.getTime() > close.getTime() + AFTER_CLOSE_SLACK_MS) return { action: 'skip', reason: 'after-tour-close' };
  if (!pub) {
    // With two tours of one title an undated review can't be placed.
    if ((ctx.otherToursOfTitle || 0) > 0) return { action: 'skip', reason: 'ambiguous-tour' };
    // A closed tour only takes an undated review the pipeline saw before it closed;
    // one first seen later is more likely a review of the next production.
    if (close) {
      const seen = firstSeen(data);
      if (!seen || seen.getTime() > close.getTime() + AFTER_CLOSE_SLACK_MS) return { action: 'skip', reason: 'undated-after-close' };
    }
  }

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

const normTitle = (t) => String(t || '').trim().toLowerCase();

/**
 * One entry per tour: which Broadway show folders to sweep and the date context.
 * Every BROADWAY production sharing the tourOf parent's title is a source
 * (Beetlejuice tour reviews landed on beetlejuice-2022 and -2025, not only the
 * parent 2019); other markets never are (beetlejuice-west-end-2026 is a
 * different production, and the UK filter only catches files that say so).
 */
function planTourSweep(shows) {
  const byId = new Map(shows.map(s => [s.id, s]));
  const tours = shows.filter(s => s.category === 'tour' && s.tourOf && byId.has(s.tourOf));
  return tours.map(tour => {
    const parent = byId.get(tour.tourOf);
    const title = normTitle(parent.title);
    const fromIds = shows
      .filter(s => (s.category || 'broadway') === 'broadway' && normTitle(s.title) === title)
      .map(s => s.id)
      .sort();
    const otherToursOfTitle = tours.filter(t => t.id !== tour.id && normTitle(byId.get(t.tourOf).title) === title).length;
    return {
      tourId: tour.id,
      fromIds,
      ctx: {
        broadwayOpeningDate: parent.openingDate || null,
        tourLaunchDate: tour.openingDate || null,
        tourClosingDate: tour.status === 'closed' ? (tour.closingDate || null) : null,
        otherToursOfTitle,
      },
    };
  });
}

/**
 * Decide every file for one plan from planTourSweep. listFiles(showId) returns
 * [{ file, data }] for that show folder ([] when missing). Returns one row per
 * tour-flagged file: { fromId, file, data, key }, where key 'tour-review' means
 * move it. Duplicates are caught by URL, not filename: the same review can sit
 * on two Broadway folders under different bylines (denverpost--unknown vs
 * denverpost--john-moore). Shared by scripts/sweep-tour-reviews.js (which moves
 * the 'tour-review' rows in order) and validate-data's pending-sweep warning.
 */
function decideTourSweep(plan, listFiles) {
  const { normalizeUrl } = require('./review-normalization');
  const onTour = new Set();
  const tourFiles = new Set();
  for (const { file, data } of listFiles(plan.tourId)) {
    tourFiles.add(file);
    if (data && data.url) onTour.add(normalizeUrl(data.url));
  }
  const rows = [];
  for (const fromId of plan.fromIds) {
    for (const { file, data } of listFiles(fromId)) {
      if (!data || file.startsWith('_')) continue;
      const d = classifyTourBackfill(data, plan.ctx);
      if (d.reason === 'not-flagged' || d.reason === 'flag-not-tour') continue;
      let key = d.reason;
      if (d.action === 'move') {
        const u = data.url ? normalizeUrl(data.url) : null;
        if (u && onTour.has(u)) key = 'duplicate-on-tour';
        else if (tourFiles.has(file)) key = 'target-collision';
      }
      if (key === 'tour-review') {
        if (data.url) onTour.add(normalizeUrl(data.url));
        tourFiles.add(file);
      }
      rows.push({ fromId, file, data, key });
    }
  }
  return rows;
}

module.exports = { classifyTourBackfill, prepareTourMove, planTourSweep, decideTourSweep, BROADWAY_RELATIVE_FIELDS };
