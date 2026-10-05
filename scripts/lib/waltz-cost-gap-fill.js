/**
 * What u/Boring_Waltz_9545's r/Broadway weekly operating cost estimates may
 * write to data/commercial.json (owner decision 2026-10-05, BRO-4666).
 *
 * His figures fill a missing weekly cost and replace our own estimates
 * (industry-estimate, deep-research): his are per-show analyses he publishes
 * and revises every week. They never replace a reported figure (trade press,
 * SEC filing, producer), and never a cost whose source the record does not
 * name. Every value he supplies is flagged as an estimate, so /biz prints it
 * with "~" and the "Estimate" source line.
 *
 * update-commercial-data.js uses isReportedWeeklyCost() for the same rule
 * on its model-proposed Reddit costs.
 *
 * Pure: no I/O.
 */

// costMethodology values that mean the weekly cost was reported, not estimated.
const REPORTED_COST_METHODOLOGIES = new Set(['trade-reported', 'sec-filing', 'producer-confirmed']);
// Our own estimates, which his per-show figures replace.
const OUR_ESTIMATE_METHODOLOGIES = new Set(['industry-estimate', 'deep-research']);
const WALTZ_METHODOLOGY = 'reddit-standard';
// His own earlier figure is refreshed only when the new one moves more than this.
const REFRESH_THRESHOLD = 0.10;
// A Broadway weekly running cost outside this range is a misread, not a
// figure ("$1 million/week" once parsed as $1).
const MIN_WEEKLY_COST = 100_000;
const MAX_WEEKLY_COST = 5_000_000;

/** True when the record's weekly cost is a reported figure an estimate must never overwrite. */
function isReportedWeeklyCost(record) {
  return record?.weeklyRunningCost != null && REPORTED_COST_METHODOLOGIES.has(record.costMethodology);
}

/**
 * @param {object|undefined} record - the commercial.json record
 * @param {number} cost - his weekly operating cost estimate, in dollars
 * @returns {{ write: boolean, reason: string }}
 */
function decideWaltzCostWrite(record, cost) {
  if (!record) return { write: false, reason: 'no commercial record' };
  if (!(Number.isFinite(cost) && cost > 0)) return { write: false, reason: 'no usable cost' };
  if (cost < MIN_WEEKLY_COST || cost > MAX_WEEKLY_COST) {
    return { write: false, reason: `implausible weekly cost $${cost.toLocaleString()}` };
  }
  const current = record.weeklyRunningCost;
  if (current == null) return { write: true, reason: 'fills a missing weekly cost' };
  const method = record.costMethodology;
  if (isReportedWeeklyCost(record)) return { write: false, reason: `keeps the reported figure (${method})` };
  if (OUR_ESTIMATE_METHODOLOGIES.has(method)) return { write: true, reason: `replaces our ${method}` };
  if (method === WALTZ_METHODOLOGY) {
    const diff = Math.abs(current - cost) / current;
    return diff > REFRESH_THRESHOLD
      ? { write: true, reason: `his newer figure moved ${(diff * 100).toFixed(1)}%` }
      : { write: false, reason: 'within 10% of his last figure' };
  }
  return { write: false, reason: `keeps a cost with no named method (${method || 'none'})` };
}

/**
 * The fields to set on a record decideWaltzCostWrite() allows.
 * @param {object} record
 * @param {{ cost: number, postTitle: string, postDate: string, permalink?: string }} post
 * @param {Date} [now]
 */
function waltzCostPatch(record, { cost, postTitle, postDate, permalink }, now = new Date()) {
  const url = permalink ? ` https://www.reddit.com${permalink}` : '';
  return {
    weeklyRunningCost: cost,
    costMethodology: WALTZ_METHODOLOGY,
    isEstimate: { ...(record.isEstimate || {}), weeklyRunningCost: true },
    weeklyRunningCostSource: `Estimate by u/Boring_Waltz_9545 on r/Broadway, "${postTitle}" (${postDate})${url}`,
    lastUpdated: now.toISOString(),
  };
}

module.exports = {
  decideWaltzCostWrite,
  waltzCostPatch,
  isReportedWeeklyCost,
  REPORTED_COST_METHODOLOGIES,
  OUR_ESTIMATE_METHODOLOGIES,
  WALTZ_METHODOLOGY,
};
