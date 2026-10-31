/**
 * Page-level sibling-misfile detection (BRO-363, extended BRO-2121).
 *
 * An archived aggregator page saved under showId X may really be a same-title
 * SIBLING's page (a historical revival id holding the current production's
 * page, a regional tryout id holding its Broadway transfer's page). Detected
 * by the same date-proximity vote classifyMarketRouting applies at write time:
 * when >=50% (min 3) of the page's dated reviews reroute to ONE sibling, the
 * page belongs to that sibling.
 *
 * Shared by extract-show-score-reviews.js, extract-dtli-reviews.js and
 * audit-sibling-misfile-archive.js so all three agree by construction.
 */
const { classifyMarketRouting } = require('./market-routing');

const MIN_COUNT = 3;
const MIN_RATIO = 0.5;

/**
 * @param {string} showId
 * @param {Array<{url?:string, publishDate?:string}>} reviews  normalised: publishDate holds the page's date text
 * @param {{category?:string, siblingIndex:object}} ctx
 * @returns {{misfiled:boolean, targetId:string|null, count:number, total:number}}
 */
function detectSiblingMisfile(showId, reviews, { category, siblingIndex }) {
  const total = reviews.length;
  const none = { misfiled: false, targetId: null, count: 0, total };
  if (total === 0) return none;
  const counts = new Map();
  for (const r of reviews) {
    const decision = classifyMarketRouting({
      showId,
      url: r.url,
      outletId: null,
      publishDate: r.publishDate,
      category,
      siblingIndex,
    });
    if (decision.action === 'reroute') {
      counts.set(decision.targetShowId, (counts.get(decision.targetShowId) || 0) + 1);
    }
  }
  for (const [targetId, count] of counts) {
    if (count >= MIN_COUNT && count / total >= MIN_RATIO) {
      return { misfiled: true, targetId, count, total };
    }
  }
  return none;
}

module.exports = { detectSiblingMisfile, MIN_COUNT, MIN_RATIO };
