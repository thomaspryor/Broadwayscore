/**
 * scoring-leftover-shows.js (BRO-7031)
 *
 * Which of these shows still hold unscored, actionable reviews? The opening-night
 * poller scores inline under one shared ~8 min deadline and index.ts only starts a
 * review with 5 min left, so the third show of a busy night got 2 reviews scored and
 * "left 2 for the next run". The next poll was cancelled by an Express takeover, so
 * New York Theatre Guide (collected 03:56Z) sat unscored until 05:20Z and missed the
 * 11:55pm ET bar. The poller dispatches llm-ensemble-score.yml for these shows instead
 * of waiting on a poll that may never come.
 *
 * Same predicate as the scorer and the cascade gates (countScoringQueues), never a
 * hand-rolled file scan.
 *
 * Usage: node scripts/lib/scoring-leftover-shows.js "show-a,show-b" -> "show-b" (CSV, empty if none)
 */
const path = require('path');
const { countScoringQueues, loadShowsById } = require('./scoring-queue-counts');

/**
 * @param {string} baseDir - review-texts root
 * @param {string[]} showIds
 * @param {Map<string,Object>} [showsById]
 * @returns {string[]} showIds (input order) with >= 1 actionable unscored review
 */
function showsWithUnscored(baseDir, showIds, showsById) {
  const byId = showsById || loadShowsById();
  const out = [];
  for (const id of showIds) {
    if (!id || !require('fs').existsSync(path.join(baseDir, id))) continue;
    const c = countScoringQueues(baseDir, { showsById: byId, onlyShowIds: new Set([id]) });
    if (c.unscored > 0) out.push(id);
  }
  return out;
}

module.exports = { showsWithUnscored };

if (require.main === module) {
  const ids = String(process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
  const base = process.env.REVIEW_TEXTS_DIR || path.join('data', 'review-texts');
  console.log(showsWithUnscored(base, ids).join(','));
}
