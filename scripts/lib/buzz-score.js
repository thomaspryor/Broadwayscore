/**
 * Reddit buzz score computation (pure).
 *
 * Extracted from scrape-reddit-sentiment.js so it can be required WITHOUT the
 * scraper's module-scope data reads (shows.json / audience-buzz.json). The A/B
 * harness's deterministic --fixture mode depends on that: it must run in a
 * checkout with no data setup.
 */

const SENTIMENT_SCORES = {
  enthusiastic: 98,
  positive: 88,
  mixed: 68,
  negative: 40,
  neutral: 60,
};

/**
 * @param {Array} classifications  [{ is_relevant, sentiment }]
 * @param {number} [totalPosts]
 * @param {number} [totalComments]
 * @returns {null | { score, reviewCount, totalPosts, totalComments, sentiment, positiveRate, lastUpdated }}
 */
function calculateBuzzScore(classifications, totalPosts = 0, totalComments = 0) {
  const relevant = classifications.filter(c => c.is_relevant);
  if (relevant.length === 0) return null;

  const sentimentCounts = {
    enthusiastic: 0,
    positive: 0,
    mixed: 0,
    negative: 0,
    neutral: 0,
  };

  for (const item of relevant) {
    const sentiment = item.sentiment || 'neutral';
    if (sentimentCounts[sentiment] !== undefined) {
      sentimentCounts[sentiment]++;
    }
  }

  // Weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [sentiment, count] of Object.entries(sentimentCounts)) {
    if (count > 0) {
      weightedSum += SENTIMENT_SCORES[sentiment] * count;
      totalWeight += count;
    }
  }

  const baseScore = totalWeight > 0 ? weightedSum / totalWeight : 50;

  // Enthusiasm bonus (up to +5 points)
  const enthusiasmRate = sentimentCounts.enthusiastic / relevant.length;
  const enthusiasmBonus = Math.min(5, enthusiasmRate * 15);

  const finalScore = Math.min(99, Math.round(baseScore + enthusiasmBonus));

  return {
    score: finalScore,
    reviewCount: relevant.length,
    totalPosts,
    totalComments,
    sentiment: {
      enthusiastic: Math.round(sentimentCounts.enthusiastic / relevant.length * 100) / 100,
      positive: Math.round(sentimentCounts.positive / relevant.length * 100) / 100,
      mixed: Math.round(sentimentCounts.mixed / relevant.length * 100) / 100,
      negative: Math.round(sentimentCounts.negative / relevant.length * 100) / 100,
      neutral: Math.round(sentimentCounts.neutral / relevant.length * 100) / 100,
    },
    positiveRate: (sentimentCounts.enthusiastic + sentimentCounts.positive) / relevant.length,
    lastUpdated: new Date().toISOString(),
  };
}

module.exports = { calculateBuzzScore, SENTIMENT_SCORES };
