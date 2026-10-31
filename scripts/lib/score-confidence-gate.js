/**
 * Score confidence gate: is a show's Critic Score settled enough to announce?
 *
 * One definition shared by the opening-night email broadcast
 * (send-opening-night-broadcast.js) and the social autopost
 * (scripts/social-autopost/). Before BRO-6242 the thresholds lived inline in
 * the broadcast script; a second copy would drift.
 *
 * West End has ~15 reliable outlets vs Broadway's 40+ (median WE show gets
 * ~10 scored reviews), so London markets use lower floors. Callers with their
 * own policy (the social autopost's Off-Broadway and Off-West End floors) pass
 * `floors`; this module holds only the email's two sets.
 */

const { isLondonMarket } = require('./venue-classification');

const BROADWAY_FLOORS = { total: 12, t1: 3, t2: 3, highConfidence: 8 };
const LONDON_FLOORS = { total: 8, t1: 3, t2: 2, highConfidence: 6 };

function getConfidenceFloors(category) {
  return isLondonMarket(category) ? { ...LONDON_FLOORS } : { ...BROADWAY_FLOORS };
}

/**
 * @param {object} args
 * @param {Array<{outletId:string, assignedScore:number|null, scoreConfidence?:string}>} args.showReviews
 * @param {string} args.category  show category or market ('broadway', 'west-end', ...)
 * @param {(outletId:string)=>number} args.getOutletTier
 * @param {number|null} [args.newReviewCount]  reviews of THIS run for a returning
 *   production (BRO-4954); null when the show has no prior run.
 * @param {{total:number,t1:number,t2:number,highConfidence:number}} [args.floors]
 *   overrides getConfidenceFloors(category).
 * @returns {{ok:boolean, reasons:string[], counts:{total:number,t1:number,t2:number,t3:number,highConfidence:number}, floors:object}}
 */
// A rebuilt row carries scoreConfidence (from llmScore.confidence). A raw opening-night lane row in reviews.json
// before the next rebuild carries only llmScore.confidence (BRO-6623); read it the same way the rebuild does.
// A top-level value (e.g. the lane's paywall-fallback 'low') wins.
function rowConfidence(r) {
  if (r.scoreConfidence != null) return r.scoreConfidence;
  return (r.llmScore && r.llmScore.confidence) || null;
}

function evaluateScoreConfidence({ showReviews, category, getOutletTier, newReviewCount = null, floors: override = null }) {
  const floors = override ? { ...override } : getConfidenceFloors(category);
  // BRO-4954: a transfer/return carries its earlier run's reviews, so it can clear
  // the floors before anyone has reviewed THIS run. Require half the total floor.
  const minNewReturning = Math.ceil(floors.total / 2);
  const scored = (showReviews || []).filter(r => r && Number.isFinite(r.assignedScore));
  const tierOf = r => getOutletTier(r.outletId);
  const counts = {
    total: scored.length,
    t1: scored.filter(r => tierOf(r) === 1).length,
    t2: scored.filter(r => tierOf(r) === 2).length,
    t3: scored.filter(r => tierOf(r) === 3).length,
    // full-text scored, not excerpt-only
    highConfidence: scored.filter(r => ['high', 'medium'].includes(rowConfidence(r))).length,
  };
  const reasons = [];
  if (counts.total < floors.total) reasons.push(`${counts.total}/${floors.total} total`);
  if (counts.t1 < floors.t1) reasons.push(`T1:${counts.t1}/${floors.t1}`);
  if (counts.t2 < floors.t2) reasons.push(`T2:${counts.t2}/${floors.t2}`);
  if (counts.highConfidence < floors.highConfidence) reasons.push(`hi-conf:${counts.highConfidence}/${floors.highConfidence}`);
  if (newReviewCount != null && newReviewCount < minNewReturning) reasons.push(`this-run:${newReviewCount}/${minNewReturning}`);
  return { ok: reasons.length === 0, reasons, counts, floors: { ...floors, newReturning: minNewReturning } };
}

module.exports = { evaluateScoreConfidence, getConfidenceFloors, rowConfidence, BROADWAY_FLOORS, LONDON_FLOORS };
