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
 * has accumulated enough scored reviews to display a score, it has demonstrably
 * opened and should be flipped — independent of openingDate or ShowScore.
 *
 * These thresholds MIRROR src/config/score-buckets.ts (MIN_REVIEWS_FOR_SCORE*).
 * If you change them there, change them here too — the unit test pins them.
 */

// Mirror of MIN_REVIEWS_FOR_SCORE* in src/config/score-buckets.ts.
const MIN_REVIEWS_BY_CATEGORY = {
  broadway: 5,
  'off-broadway': 3,
  'west-end': 5,
  'off-west-end': 3,
};
const MIN_REVIEWS_DEFAULT = 5;

// Statuses that should auto-flip to 'open' once the review signal fires.
const PRE_OPEN_STATUSES = new Set(['previews', 'upcoming']);

function minReviewsForScore(category) {
  return MIN_REVIEWS_BY_CATEGORY[category] ?? MIN_REVIEWS_DEFAULT;
}

/**
 * Build { showId: { count, dates: [YYYY-MM-DD,...] } } from a clean reviews.json
 * review list. reviews.json is the post-rebuild displayed set: every entry has a
 * numeric assignedScore and no wrongProduction/wrongShow/roundup flags, so a raw
 * per-showId count equals the site's displayed review count.
 */
function countByShow(reviews) {
  const map = {};
  for (const r of reviews) {
    const id = r.showId;
    if (!id) continue;
    if (!map[id]) map[id] = { count: 0, dates: [] };
    map[id].count += 1;
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
 * CLAUDE.md rule 14) won't win the mode against the press-night cluster.
 */
function estimatePressNight(dates) {
  const valid = (dates || []).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (valid.length === 0) return null;
  const freq = {};
  for (const d of valid) freq[d] = (freq[d] || 0) + 1;
  let best = null;
  let bestCount = -1;
  for (const d of Object.keys(freq).sort()) {
    // sorted ascending => first to reach a given max count is the earliest, so
    // strict > keeps the earliest on ties.
    if (freq[d] > bestCount) {
      bestCount = freq[d];
      best = d;
    }
  }
  return best;
}

/**
 * Is this show stuck in a pre-open status despite having a displayable review
 * slate? Returns true when status is previews/upcoming AND reviewCount meets the
 * category's score-display threshold.
 */
function isStuckInPreviews(show, reviewCount) {
  if (!show || !PRE_OPEN_STATUSES.has(show.status)) return false;
  return reviewCount >= minReviewsForScore(show.category);
}

/**
 * Find every stuck show. `countMap` is the output of countByShow().
 * Returns [{ id, title, category, status, reviewCount, openingDate, pressNight }].
 */
function findStuckPreviews(shows, countMap) {
  const out = [];
  for (const show of shows) {
    const entry = countMap[show.id];
    const reviewCount = entry ? entry.count : 0;
    if (!isStuckInPreviews(show, reviewCount)) continue;
    out.push({
      id: show.id,
      title: show.title,
      category: show.category,
      status: show.status,
      reviewCount,
      openingDate: show.openingDate ?? null,
      pressNight: entry ? estimatePressNight(entry.dates) : null,
    });
  }
  return out;
}

module.exports = {
  MIN_REVIEWS_BY_CATEGORY,
  MIN_REVIEWS_DEFAULT,
  PRE_OPEN_STATUSES,
  minReviewsForScore,
  countByShow,
  estimatePressNight,
  isStuckInPreviews,
  findStuckPreviews,
};
