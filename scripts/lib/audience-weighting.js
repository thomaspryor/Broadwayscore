/**
 * Shared audience weighting module
 *
 * Calculates combined audience buzz score from Show Score, Mezzanine, Theatr,
 * Broadway.com, SeatPlan, LBO, LTD (London Theatre Direct), and Reddit sources.
 * Pure proportional weighting by reviewCount volume with an 80% single-source ceiling.
 *
 * Reddit quality gates:
 *   - Minimum 50 classified comments (below = too noisy)
 *   - Recency: excluded for shows closed >3 years ago (nostalgic mentions, not fresh reviews)
 *   - Score calibration: +8 points (capped at 95) to align Reddit's scale with SS/Mezzanine
 *
 * Used by: scrape-reddit-sentiment.js, recalculate-audience-buzz.js,
 *          scrape-mezzanine-audience.js, scrape-show-score-audience.js,
 *          scrape-broadway-com-audience.js, scrape-seatplan-audience.js,
 *          scrape-lbo-audience.js, scrape-ltd-audience.js,
 *          merge-reddit-shards.js, merge-show-score-shards.js
 */

const MIN_REDDIT_ITEMS = 50;
const REDDIT_RECENCY_YEARS = 3;
const MAX_SINGLE_SOURCE_WEIGHT = 0.80;

// Reddit sentiment scores now use a full 20-95 range (previously 40-98, compressing
// everything into the top half). With the wider range, Reddit scores naturally align
// with other sources for well-liked shows and diverge for polarizing ones — no
// artificial calibration needed.
const REDDIT_SCORE_CALIBRATION = 0;
const REDDIT_CALIBRATION_CAP = 95;

/**
 * Check if Reddit data should be included for this show
 * @param {object} reddit - { score, reviewCount }
 * @param {object} [showInfo] - { closingDate?: string, status?: string }
 * @returns {boolean}
 */
function isRedditEligible(reddit, showInfo) {
  if (!reddit || reddit.score == null) return false;
  if (reddit.reviewCount < MIN_REDDIT_ITEMS) return false;

  // Recency gate: exclude closed shows >3 years ago
  if (showInfo && showInfo.status === 'closed' && showInfo.closingDate) {
    const closed = new Date(showInfo.closingDate);
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - REDDIT_RECENCY_YEARS);
    if (closed < cutoff) return false;
  }

  return true;
}

/**
 * Calculate combined Audience Buzz score with proportional weighting
 *
 * @param {object} sources - { showScore?, mezzanine?, theatr?, broadwayCom?, reddit? } each with { score, reviewCount }
 * @param {object} [showInfo] - { closingDate?: string, status?: string } — pass to enable Reddit recency gate
 * @returns {{ score: number|null, weights: object|null }}
 */
function calculateCombinedScore(sources, showInfo) {
  const active = [];

  if (sources.showScore?.score != null && sources.showScore.reviewCount > 0) {
    active.push({ name: 'showScore', score: sources.showScore.score, volume: sources.showScore.reviewCount });
  }
  if (sources.mezzanine?.score != null && sources.mezzanine.reviewCount > 0) {
    active.push({ name: 'mezzanine', score: sources.mezzanine.score, volume: sources.mezzanine.reviewCount });
  }
  if (sources.theatr?.score != null && sources.theatr.reviewCount > 0) {
    active.push({ name: 'theatr', score: sources.theatr.score, volume: sources.theatr.reviewCount });
  }
  if (sources.broadwayCom?.score != null && sources.broadwayCom.reviewCount > 0) {
    active.push({ name: 'broadwayCom', score: sources.broadwayCom.score, volume: sources.broadwayCom.reviewCount });
  }
  if (sources.seatplan?.score != null && sources.seatplan.reviewCount > 0) {
    active.push({ name: 'seatplan', score: sources.seatplan.score, volume: sources.seatplan.reviewCount });
  }
  if (sources.lbo?.score != null && sources.lbo.reviewCount > 0) {
    active.push({ name: 'lbo', score: sources.lbo.score, volume: sources.lbo.reviewCount });
  }
  if (sources.ltd?.score != null && sources.ltd.reviewCount > 0) {
    active.push({ name: 'ltd', score: sources.ltd.score, volume: sources.ltd.reviewCount });
  }
  if (isRedditEligible(sources.reddit, showInfo)) {
    // Calibrate Reddit score to align with ShowScore/Mezzanine scale
    const calibrated = Math.min(sources.reddit.score + REDDIT_SCORE_CALIBRATION, REDDIT_CALIBRATION_CAP);
    active.push({ name: 'reddit', score: calibrated, volume: sources.reddit.reviewCount });
  }

  if (active.length === 0) {
    return { score: null, weights: null };
  }

  // Solo source — 100% weight, no ceiling needed
  if (active.length === 1) {
    const weights = { showScore: 0, mezzanine: 0, reddit: 0, theatr: 0, broadwayCom: 0, seatplan: 0, lbo: 0, ltd: 0 };
    weights[active[0].name] = 100;
    return { score: Math.round(active[0].score), weights };
  }

  // Proportional weighting by volume
  const totalVolume = active.reduce((sum, s) => sum + s.volume, 0);
  const weighted = active.map(s => ({ ...s, weight: s.volume / totalVolume }));

  // Apply weight ceiling — no single source >80%
  const max = weighted.reduce((a, b) => a.weight > b.weight ? a : b);
  if (max.weight > MAX_SINGLE_SOURCE_WEIGHT) {
    const excess = max.weight - MAX_SINGLE_SOURCE_WEIGHT;
    const others = weighted.filter(w => w.name !== max.name);
    const othersTotal = others.reduce((sum, w) => sum + w.weight, 0);
    max.weight = MAX_SINGLE_SOURCE_WEIGHT;
    for (const w of others) {
      w.weight += excess * (w.weight / othersTotal);
    }
  }

  let combinedScore = 0;
  for (const w of weighted) {
    combinedScore += w.score * w.weight;
  }

  const weights = { showScore: 0, mezzanine: 0, reddit: 0, theatr: 0, broadwayCom: 0, seatplan: 0, lbo: 0, ltd: 0 };
  for (const w of weighted) {
    weights[w.name] = Math.round(w.weight * 100);
  }

  return { score: Math.round(combinedScore), weights };
}

/**
 * Derive audience designation from combined score.
 * Thresholds match data-audience.ts getAudienceGrade().
 * Single source of truth — all scrapers should call this instead of inlining.
 */
function getDesignation(score) {
  if (score == null) return null;
  if (score >= 88) return 'Loving';
  if (score >= 78) return 'Liking';
  if (score >= 68) return 'Shrugging';
  if (score >= 53) return 'Disliking';
  return 'Loathing';
}

module.exports = { calculateCombinedScore, getDesignation, isRedditEligible, MIN_REDDIT_ITEMS, REDDIT_RECENCY_YEARS, REDDIT_SCORE_CALIBRATION, REDDIT_CALIBRATION_CAP };
