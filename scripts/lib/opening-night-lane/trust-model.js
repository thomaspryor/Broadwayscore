'use strict';
/**
 * Trust model for the opening-night lane's review files (BRO-4782, epic BRO-4210; design:
 * docs/opening-night-autonomy-review-2026-09-28.md section 6, "Trust model for the night").
 *
 * Why it exists: on an opening night the corpus guards (wrong-production classifier, non-review classifier,
 * headline backstop, scraper-garbage reject, tour and cross-market guard, roundup-URL swap) hid correct reviews
 * 12+ times, because each one is tuned for the slow, noisy, whole-corpus pipeline. A URL that an aggregator
 * cites for THIS show on THIS night, or that appears on an outlet's own index dated opening night +/- 1 day, is
 * already production-verified by a source the guards cannot beat. Those reviews carry provenance and a
 * `productionVerified: "aggregator"` stamp, and the guards stand down for them (and only for them).
 *
 * This module is the contract and nothing else: pure functions, no I/O, no guard code touched. Wiring each
 * guard to call laneBypasses() is separate work (it edits the write guard, the rebuild inclusion path and the
 * classifiers, and the inclusion edits need scoring-delta checks), tracked as its own cards.
 *
 * Deliberately narrow: a review is a lane review only when BOTH the provenance block and the stamp are present
 * and well formed. A half-stamped file is an ordinary review and every guard applies to it.
 */
const { generateReviewFilename } = require('../review-normalization');
const { versionedReviewFilename, normalizeReviewUrl } = require('../ingest-collision');
const { THUMB_SCORES, starsToNumeric } = require('../score-extractors');

const PROVENANCE_KEY = 'openingNightLane';
const PRODUCTION_VERIFIED = 'aggregator';
const SOURCES = Object.freeze(['aggregator', 'outlet-index']);
// The guards that stand down for a lane review. laneBypasses() refuses any other name so a typo can never
// silently read as "not bypassed" or, worse, widen the bypass.
const LANE_BYPASSED_GUARDS = Object.freeze([
  'wrongProduction', 'nonReview', 'headlineBackstop', 'scraperGarbage', 'tourCrossMarket', 'roundupUrlSwap',
]);
const DAY_MS = 86400000;
// Below this many characters of article text a review counts as paywalled for scoring (a thumb or stars and an
// excerpt are all that exist); it is written and queued for re-collection, never rejected.
const MIN_FULL_TEXT_CHARS = 200;

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** The provenance block written into a lane review. Throws on anything that would make it ambiguous. */
function buildLaneProvenance({ show, night, source, seenAt } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(show || ''))) throw new Error(`lane provenance: bad show id "${show}"`);
  if (!isDay(night)) throw new Error(`lane provenance: bad night "${night}" (want YYYY-MM-DD)`);
  if (!SOURCES.includes(source)) throw new Error(`lane provenance: source must be one of ${SOURCES.join(', ')}, got "${source}"`);
  if (!isIso(seenAt)) throw new Error(`lane provenance: bad seenAt "${seenAt}"`);
  return { show, night, source, seenAt: new Date(seenAt).toISOString() };
}

// seenAt must fall close to the night it claims: from a day before to a few days after. A stamp saying night
// 2026-10-18 seen in 1999 is junk, not provenance.
const SEEN_BEFORE_DAYS = 1;
const SEEN_AFTER_DAYS = 3;

/**
 * True only for a review carrying a well-formed provenance block AND the aggregator production stamp, for the show
 * the file belongs to (showId is required: a file with no showId cannot prove the stamp is for it).
 * ctx.openingDate (the show's openingDate from shows.json, YYYY-MM-DD) is optional but the guard-wiring callers
 * should always pass it: when given, the stamped night must be that opening night.
 *
 * Nothing here can prove the stamp was written by the lane (that is the write side's job: only the lane writer may
 * emit productionVerified:"aggregator" or the provenance block, and every other writer must strip them). This
 * function makes a forged or copied stamp as hard to pass as a pure check can.
 */
function isLaneReview(review, ctx = {}) {
  if (!review || typeof review !== 'object') return false;
  if (review.laneRevoked === true) return false; // BRO-4807: a human or audit revoked the stamp; every guard applies again
  if (review.productionVerified !== PRODUCTION_VERIFIED) return false;
  const p = review[PROVENANCE_KEY];
  if (!p || typeof p !== 'object') return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(p.show || '')) || !isDay(p.night) || !SOURCES.includes(p.source) || !isIso(p.seenAt)) return false;
  if (!review.showId || review.showId !== p.show) return false;
  const nightMs = Date.parse(`${p.night}T00:00:00Z`);
  const seenMs = Date.parse(p.seenAt);
  if (seenMs < nightMs - SEEN_BEFORE_DAYS * DAY_MS || seenMs >= nightMs + (SEEN_AFTER_DAYS + 1) * DAY_MS) return false;
  if (ctx.openingDate != null && String(ctx.openingDate).slice(0, 10) !== p.night) return false;
  return true;
}

/** Whether `guard` must stand down for `review`. Unknown guard names throw. `ctx` is forwarded to isLaneReview. */
function laneBypasses(review, guard, ctx = {}) {
  if (!LANE_BYPASSED_GUARDS.includes(guard)) {
    throw new Error(`laneBypasses: unknown guard "${guard}" (known: ${LANE_BYPASSED_GUARDS.join(', ')})`);
  }
  return isLaneReview(review, ctx);
}

const DEFAULT_TIME_ZONE = 'America/New_York';

/**
 * The calendar date (YYYY-MM-DD) a publish date falls on in `timeZone`. A date-only string IS that calendar date.
 * A date-time must carry a zone or offset: one without is parsed in the SERVER's zone, which makes the answer depend
 * on where the lane happens to run, so it is refused (null).
 */
function calendarDateIn(publishDate, timeZone = DEFAULT_TIME_ZONE) {
  const fmt = (t) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  // A Date object is one unambiguous instant (the shared feed parser returns pubDate as a Date).
  if (publishDate instanceof Date) return Number.isNaN(publishDate.getTime()) ? null : fmt(publishDate.getTime());
  const raw = String(publishDate || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return isDay(raw) ? raw : null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return fmt(t);
}

/**
 * Should the lane take this candidate at all? Aggregator-cited URLs are admitted without a date check (the aggregator
 * already tied them to the show); an outlet-index find needs a publish date within opening night +/- 1 CALENDAR day
 * in the market's time zone (America/New_York for Broadway and Off-Broadway, Europe/London for the West End).
 * @returns {{admit: boolean, reason: string}}
 */
function admitLaneCandidate({ source, aggregatorCited = false, publishDate = null, night, timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (!isDay(night)) throw new Error(`admitLaneCandidate: bad night "${night}"`);
  if (source === 'aggregator') {
    return aggregatorCited === true ? { admit: true, reason: 'aggregator-cited' } : { admit: false, reason: 'not-cited-by-an-aggregator' };
  }
  if (source === 'outlet-index') {
    const date = calendarDateIn(publishDate, timeZone);
    if (!date) return { admit: false, reason: 'no-publish-date' };
    const day = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${night}T00:00:00Z`)) / DAY_MS);
    return day >= -1 && day <= 1 ? { admit: true, reason: 'outlet-index-on-night' } : { admit: false, reason: 'outside-night-window' };
  }
  return { admit: false, reason: 'unknown-source' };
}

/**
 * The file a lane review is written to. Never the plain `outlet--critic.json` slot (that file may be an older,
 * flagged review of another production): a slot collision creates a NEW file keyed by outlet + critic + night.
 * Re-running for the same URL reuses its file (idempotent); a different URL on the same name gets a URL-hash suffix.
 * @param {Map<string,string>|Object} existing filename -> review url for the show's directory
 * @returns {{filename: string, reuse: boolean}}
 */
function laneReviewFilename({ outletId, criticName, night, url, existing = new Map() } = {}) {
  if (!isDay(night)) throw new Error(`laneReviewFilename: bad night "${night}"`);
  if (!url) throw new Error('laneReviewFilename: url is required');
  const map = existing instanceof Map ? existing : new Map(Object.entries(existing || {}));
  // Values may be the review url or a record carrying one.
  const urlOf = (v) => (typeof v === 'string' ? v : (v && typeof v.url === 'string' ? v.url : null));
  const sameUrl = (v) => { const u = urlOf(v); return !!u && normalizeReviewUrl(u) === normalizeReviewUrl(url); };
  const base = generateReviewFilename(outletId, criticName || 'unknown').replace(/\.json$/, '');
  const filename = `${base}--on-${night}.json`;
  if (!map.has(filename)) return { filename, reuse: false };
  if (sameUrl(map.get(filename))) return { filename, reuse: true };
  // The base slot holds a different review: this URL gets its own URL-hash file, and a re-run finds that file again.
  const versioned = versionedReviewFilename(filename, url);
  if (map.has(versioned) && sameUrl(map.get(versioned))) return { filename: versioned, reuse: true };
  return { filename: versioned, reuse: false };
}

/**
 * A score for a review whose text could not be fetched (paywalled T1): the aggregator's thumb or stars, at low
 * confidence, queued for re-collection. Never a rejection. Returns null when the aggregator gave neither.
 */
function paywallFallbackScore({ thumb, stars } = {}) {
  if (thumb != null && Object.prototype.hasOwnProperty.call(THUMB_SCORES, thumb)) {
    return { assignedScore: THUMB_SCORES[thumb], scoreSource: 'lane-aggregator-thumb' };
  }
  // A number or a numeric string only: Number('') and Number(false) are 0 and would publish a 0 for a blank field.
  // 0 stars means unrated, not a score.
  const isNum = typeof stars === 'number' || (typeof stars === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(stars));
  const n = isNum ? Number(stars) : NaN;
  if (Number.isFinite(n) && n > 0 && n <= 5) {
    return { assignedScore: starsToNumeric(n, 5), scoreSource: 'lane-aggregator-stars' };
  }
  return null;
}

/**
 * Assemble the review record the lane writes. Text-bearing reviews carry no score here (the inline scorer sets it);
 * a paywalled one gets the aggregator fallback score at low confidence and needsRecollection.
 */
function buildLaneReview({
  showId, night, source, seenAt, outletId, outlet, criticName, url, publishDate = null, fullText = '',
  aggregator = {},
} = {}) {
  if (!url) throw new Error('buildLaneReview: url is required');
  if (!outletId) throw new Error('buildLaneReview: outletId is required');
  const provenance = buildLaneProvenance({ show: showId, night, source, seenAt });
  const text = typeof fullText === 'string' ? fullText.trim() : '';
  const review = {
    showId, outletId, outlet: outlet || outletId, criticName: criticName || null, url, publishDate,
    fullText: text, source: 'opening-night-lane',
    [PROVENANCE_KEY]: provenance, productionVerified: PRODUCTION_VERIFIED,
  };
  if (aggregator.excerpt) review.showScoreExcerpt = String(aggregator.excerpt);
  if (text.length >= MIN_FULL_TEXT_CHARS) {
    review.isFullReview = true;
    review.needsRecollection = false;
    return review;
  }
  review.isFullReview = false;
  review.needsRecollection = true;
  review.textStatus = 'paywalled-awaiting-recollection';
  const fallback = paywallFallbackScore(aggregator);
  if (fallback) {
    review.assignedScore = fallback.assignedScore;
    review.scoreSource = fallback.scoreSource;
    review.scoreConfidence = 'low';
  }
  return review;
}

module.exports = {
  PROVENANCE_KEY, PRODUCTION_VERIFIED, SOURCES, LANE_BYPASSED_GUARDS, MIN_FULL_TEXT_CHARS,
  buildLaneProvenance, isLaneReview, laneBypasses, calendarDateIn, admitLaneCandidate, laneReviewFilename, paywallFallbackScore, buildLaneReview,
};
