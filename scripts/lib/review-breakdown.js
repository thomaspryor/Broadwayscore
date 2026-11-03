const { getReviewBreakdownTierId, getGoldThreshold, RECOMMENDED_MIN, MIXED_MIN } = require('./score-tiers');

// BRO-6729 decision, owner-hold sweep BRO-6852 (2026-11-02): align the web
// counters and review badges with the critic verdict. Mobile bd stays parked
// until the iOS consumer can be checked in its own repository.
function countReviewVerdicts(reviews, category) {
  const counts = { rave: 0, positive: 0, mixed: 0, negative: 0 };
  for (const review of reviews) {
    const tier = getReviewBreakdownTierId(review.verdict, review.reviewScore, category);
    if (tier) counts[tier]++;
  }
  return counts;
}

// The status dashboards have three slots: Positive includes Rave.
function countReviewSentiments(reviews, category) {
  const counts = countReviewVerdicts(reviews, category);
  return { positive: counts.rave + counts.positive, mixed: counts.mixed, negative: counts.negative };
}

function getReviewBadgePresentation(verdict, score, category) {
  const tier = getReviewBreakdownTierId(verdict, score, category);
  // Representative scores select existing design-system colors only. The
  // displayed numeric score and the underlying critic score never change.
  const styles = {
    rave: { label: 'Rave', colorScore: getGoldThreshold(category) },
    positive: { label: 'Positive', colorScore: RECOMMENDED_MIN },
    mixed: { label: 'Mixed', colorScore: MIXED_MIN },
    negative: { label: 'Negative', colorScore: 0 },
  };
  return tier ? styles[tier] : { label: 'Unscored', colorScore: null };
}

module.exports = { countReviewVerdicts, countReviewSentiments, getReviewBadgePresentation };
