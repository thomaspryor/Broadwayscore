const { countReviewSentiments } = require('./review-breakdown');
const { getTier } = require('./outlet-tiers');
const { computeCriticScore } = require('./compute-critic-score');

/** Summarize the published mobile payload without using its legacy score-band bd. */
function getSiteReviewStats(data) {
  if (!data || data.cs == null) return null;
  return {
    score: data.cs,
    reviewCount: data.rc,
    ...countReviewSentiments((data.rv || []).map(r => ({ reviewScore: r.s, verdict: r.v })), data.cat),
  };
}

/**
 * Get review stats for a show from reviews.json (live data, may be ahead of site).
 * Uses assignedScore > 0 to match checkReadiness() in the poller.
 */
function getShowReviewStats(reviewsArr, showId, outletRegistry, showCategory, siteData = null) {
  const showRevs = reviewsArr.filter(r => r.showId === showId && r.assignedScore > 0);
  const outlets = outletRegistry.outlets || outletRegistry;

  let t1 = 0, t2 = 0, t3 = 0;
  const { positive, mixed, negative } = countReviewSentiments(
    showRevs.map(r => ({ reviewScore: r.assignedScore, verdict: r.verdict })), showCategory);
  const outletsSeen = new Set();

  for (const r of showRevs) {
    const tier = getTier(r.outletId);
    if (tier === 1) t1++;
    else if (tier === 2) t2++;
    else t3++;

    outletsSeen.add(r.outletId);
  }

  // Live-computed score (may differ from site if rebuild hasn't run)
  const scoreResult = computeCriticScore(showRevs, outlets, showCategory);

  const liveScore = scoreResult ? Math.round(scoreResult.s) : null;
  const siteScore = siteData?.score ?? null;

  return {
    total: showRevs.length,
    t1, t2, t3,
    positive, mixed, negative,
    score: siteScore ?? liveScore, // Prefer site score — that's what users see
    liveScore,                      // Live-computed from reviews.json
    siteScore,                      // From pre-built file (matches site)
    scoreDrift: (siteScore != null && liveScore != null) ? liveScore - siteScore : null,
    outletsSeen: [...outletsSeen],
  };
}

module.exports = { getSiteReviewStats, getShowReviewStats };
