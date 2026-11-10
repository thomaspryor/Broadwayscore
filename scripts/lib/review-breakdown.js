const { getReviewBreakdownTierId, getBreakdownTierId } = require('./score-tiers');

// BRO-6729 decision, owner-hold sweep BRO-6852 (2026-11-02): align the web
// counters with the critic verdict (badges follow the number since 2026-11-09, below). Mobile bd now uses the
// same counter (the iOS app builds its bar from review scores and ignores the
// extra rave key).
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

// Owner decision 2026-11-09 (Wanted opening night, "Option A"): each review's
// badge is colored and labeled by its own number, so two reviews with the same
// score always look the same. The breakdown bar and counters above still count
// each review by the critic's verdict (countReviewVerdicts, BRO-6686).
function getReviewBadgePresentation(score, category) {
  const tier = getBreakdownTierId(score, category);
  const labels = { rave: 'Rave', positive: 'Positive', mixed: 'Mixed', negative: 'Negative' };
  return tier ? { label: labels[tier], colorScore: score } : { label: 'Unscored', colorScore: null };
}

module.exports = { countReviewVerdicts, countReviewSentiments, getReviewBadgePresentation };
