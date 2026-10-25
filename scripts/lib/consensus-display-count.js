'use strict';

/**
 * consensus-display-count.js (BRO-6212): the review count shown beside the
 * Critics' Take ("Based on N reviews" in the app, detail.cn.rc).
 *
 * critic-consensus.json reviewCount is a generation-time INPUT count: how many
 * review-text files fed the take, including excerpt-only duplicate stubs, and it
 * only refreshes when 3+ reviews change. Benjamin Button off-Broadway showed 27
 * while the Critic Score used 23. The number next to a take must be the number
 * of reviews the show actually has on the site, so prefer the Critic Score's
 * count (scoreResult.rc, before the display gate nulls it) and keep the stored
 * count only when the show has no score at all (hidden / announced).
 *
 * @param {{rc?: number}|null|undefined} scoreResult computeCriticScore() result for the show
 * @param {number|null|undefined} storedCount critic-consensus.json reviewCount
 * @returns {number}
 */
function consensusDisplayCount(scoreResult, storedCount) {
  if (scoreResult && Number.isFinite(scoreResult.rc) && scoreResult.rc > 0) return scoreResult.rc;
  return storedCount || 0;
}

module.exports = { consensusDisplayCount };
