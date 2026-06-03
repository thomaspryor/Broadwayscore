/**
 * opening-signal.js — review-driven "this show has opened" signal.
 *
 * Root cause this addresses (rodeo / the-last-man / small, 2026-06):
 * update-show-status.js only flips previews→open when `openingDate` is set
 * (Check 2) or when ShowScore reports "open" (requires a ShowScore URL).
 * A show with `openingDate: null` and no ShowScore URL stays in `previews`
 * forever — even after a full slate of scored reviews lands — and the site's
 * `showTBD` gate (src/app/show/[slug]/page.tsx) then suppresses its score.
 *
 * The reviews themselves are ground-truth that a show opened: critics review
 * on/after press night, not during previews. So once a show in previews/upcoming
 * has accumulated ENOUGH reviews TO DISPLAY A SCORE, it has demonstrably opened
 * and should be flipped — independent of openingDate or ShowScore.
 *
 * The "enough to display a score" test MUST match the site exactly, or we flip a
 * show to `open` (labelling it "Now Playing", fabricating an openingDate) while
 * the score is still gated as TBD — the original symptom, inverted. So this file
 * ports `reviewsRemainingForScore` from src/config/score-buckets.ts verbatim,
 * including the T3-only (+2) penalty. The constants are mirrored below; the
 * colocated test pins both the constants AND the T3-only logic. If you change the
 * thresholds in score-buckets.ts, change them here too.
 */

// Mirror of the MIN_REVIEWS_FOR_SCORE* / T3_ONLY_EXTRA_REVIEWS constants in
// src/config/score-buckets.ts.
const MIN_REVIEWS_BY_CATEGORY = {
  broadway: 5,
  'off-broadway': 3,
  'west-end': 5,
  'off-west-end': 3,
};
const MIN_REVIEWS_DEFAULT = 5;
const MIN_REVIEWS_CURATED_HISTORICAL = 4;
const T3_ONLY_EXTRA_REVIEWS = 2;

// Statuses that should auto-flip to 'open' once the review signal fires.
const PRE_OPEN_STATUSES = new Set(['previews', 'upcoming']);

function minReviewsForCategory(category) {
  return MIN_REVIEWS_BY_CATEGORY[category] ?? MIN_REVIEWS_DEFAULT;
}

/**
 * Verbatim port of reviewsRemainingForScore() in src/config/score-buckets.ts.
 * Returns how many more reviews are needed before a score displays (0 = qualifies).
 */
function reviewsRemainingForScore(reviewCount, category, tier1And2Count, isCuratedHistorical) {
  let min = minReviewsForCategory(category);
  if (isCuratedHistorical && (!category || category === 'broadway') && (tier1And2Count ?? 0) >= 1) {
    min = MIN_REVIEWS_CURATED_HISTORICAL;
  }
  if (tier1And2Count !== undefined && tier1And2Count === 0) {
    min += T3_ONLY_EXTRA_REVIEWS;
  }
  return Math.max(0, min - reviewCount);
}

/**
 * Build { showId: { count, tier1And2, dates: [YYYY-MM-DD,...] } } from a clean
 * reviews.json review list. reviews.json is the post-rebuild displayed set: every
 * entry has a numeric assignedScore and no wrongProduction/wrongShow/roundup
 * flags, so a raw per-showId count equals the site's displayed review count.
 *
 * @param reviews array of reviews.json entries
 * @param getTier (review) => number|undefined — outlet tier (1/2/3/4). Used to
 *   count T1/T2 reviews, which the score-display threshold needs (T3-only shows
 *   require +2 reviews). Omit and tier1And2 is left undefined (no T3 penalty).
 */
function countByShow(reviews, getTier) {
  const map = {};
  for (const r of reviews) {
    const id = r.showId;
    if (!id) continue;
    if (!map[id]) map[id] = { count: 0, tier1And2: 0, dates: [] };
    map[id].count += 1;
    if (getTier) {
      const t = getTier(r);
      if (t === 1 || t === 2) map[id].tier1And2 += 1;
    }
    const d = r.publishDate || r.date;
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) {
      map[id].dates.push(d.slice(0, 10));
    }
  }
  return map;
}

/**
 * Estimate press night from a show's review publish dates.
 * Press night is the modal date (most critics review that day); ties break to
 * the earliest. Returns 'YYYY-MM-DD' or null when no usable dates exist.
 * Note: a single early outlet (Talkin' Broadway can publish ~24h pre-opening,
 * CLAUDE.md rule 14) won't win the mode against the press-night cluster. The
 * caller still guards against future dates before writing openingDate.
 */
function estimatePressNight(dates) {
  const valid = (dates || []).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (valid.length === 0) return null;
  const freq = {};
  for (const d of valid) freq[d] = (freq[d] || 0) + 1;
  let best = null;
  let bestCount = -1;
  for (const d of Object.keys(freq).sort()) {
    // sorted ascending + strict > keeps the earliest date on count ties.
    if (freq[d] > bestCount) {
      bestCount = freq[d];
      best = d;
    }
  }
  return best;
}

/**
 * Is this show stuck in a pre-open status despite having a displayable review
 * slate? Returns true when status is previews/upcoming AND the show has enough
 * reviews to display a score by the SAME rule the site uses (reviewsRemaining===0).
 *
 * @param counts { count, tier1And2 } from countByShow(). A bare number is also
 *   accepted for back-compat (treated as count with tier1And2 unknown).
 */
function isStuckInPreviews(show, counts) {
  if (!show || !PRE_OPEN_STATUSES.has(show.status)) return false;
  const count = typeof counts === 'number' ? counts : (counts ? counts.count : 0);
  const tier1And2 = typeof counts === 'number' ? undefined : (counts ? counts.tier1And2 : undefined);
  // A show in previews/upcoming is never a curated-historical import, so pass false.
  return reviewsRemainingForScore(count, show.category, tier1And2, false) === 0;
}

/**
 * Choose the openingDate to backfill when flipping a stuck show to open, derived
 * ONLY from the review cluster (press night = modal review date). Returns
 * { date, source } when a past/today press night is derivable, else null.
 *
 * Deliberately does NOT fabricate a date from previewsStartDate when reviews are
 * dateless: previewsStartDate is the previews start, not opening night, and
 * openingDate is surfaced verbatim as "Opened {date}" (src/.../ShowHeroRedesign)
 * and drives opening-night lookback automation. A knowably-early date there is
 * worse than null — the project rule is never fake data (CLAUDE.md). `open` with
 * a null openingDate is an already-tolerated state (validate-data does not flag
 * it; the page simply omits the "Opened" line). The status flip alone unsticks
 * the score, which is the actual fix; the caller logs the rare null case so a
 * real openingDate can be filled later.
 *
 * Only ever returns a past/today date — a future date would let Check 2c revert
 * open→previews (oscillation). `isDateReached` is injected (date <= today) so the
 * lib stays deterministic and testable without touching the clock.
 */
function chooseOpeningDateBackfill(show, dates, isDateReached) {
  if (!show || show.openingDate) return null;
  const pressNight = estimatePressNight(dates);
  if (pressNight && isDateReached(pressNight)) {
    return { date: pressNight, source: 'review-derived-press-night' };
  }
  return null;
}

/**
 * Find every stuck show. `countMap` is the output of countByShow().
 * Returns [{ id, title, category, status, reviewCount, tier1And2, openingDate, pressNight }].
 */
function findStuckPreviews(shows, countMap) {
  const out = [];
  for (const show of shows) {
    const entry = countMap[show.id];
    if (!isStuckInPreviews(show, entry)) continue;
    out.push({
      id: show.id,
      title: show.title,
      category: show.category,
      status: show.status,
      reviewCount: entry ? entry.count : 0,
      tier1And2: entry ? entry.tier1And2 : 0,
      openingDate: show.openingDate ?? null,
      pressNight: entry ? estimatePressNight(entry.dates) : null,
    });
  }
  return out;
}

module.exports = {
  MIN_REVIEWS_BY_CATEGORY,
  MIN_REVIEWS_DEFAULT,
  MIN_REVIEWS_CURATED_HISTORICAL,
  T3_ONLY_EXTRA_REVIEWS,
  PRE_OPEN_STATUSES,
  minReviewsForCategory,
  reviewsRemainingForScore,
  countByShow,
  estimatePressNight,
  isStuckInPreviews,
  chooseOpeningDateBackfill,
  findStuckPreviews,
};
