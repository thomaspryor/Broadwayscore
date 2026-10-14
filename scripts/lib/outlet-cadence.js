'use strict';

/**
 * S4-T1 — Per-outlet review cadence + heartbeat.
 *
 * "Is this outlet dead?" needs a market-activity-aware answer, not a raw
 * calendar-day silence check: Broadway goes through genuine lulls (weeks with
 * zero new openings) where EVERY outlet, including NYT, is silent — that's
 * not an outlet failure. So silence is measured against the market's own
 * pulse (the most recent scored T1 review in that market), not wall-clock
 * "now". An outlet whose last review sits close to the market pulse is
 * healthy even if the pulse itself is old; an outlet that trails the pulse by
 * more than 2x its own historical cadence (floored at 45 days, to avoid
 * flapping on naturally low-cadence outlets like out-of-town critics) is red.
 */

const SEASONAL_FLOOR_DAYS = 45;
const RED_MULTIPLIER = 2;

function toMs(d) {
  const ms = Date.parse(d);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Median gap (days) between consecutive dates. Needs >=2 dates to return a
 * number; fewer means "not enough history to judge cadence."
 * @param {string[]} sortedIsoDates ascending
 * @returns {number|null}
 */
function medianGapDays(sortedIsoDates) {
  const gaps = [];
  for (let i = 1; i < sortedIsoDates.length; i++) {
    const a = toMs(sortedIsoDates[i - 1]);
    const b = toMs(sortedIsoDates[i]);
    if (a == null || b == null) continue;
    const d = (b - a) / 86400000;
    if (d >= 0) gaps.push(d);
  }
  if (!gaps.length) return null;
  gaps.sort((x, y) => x - y);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * The market's activity pulse: the most recent scored-review date among
 * tier-1 outlets in that market. Used as the "now" an individual outlet's
 * silence is measured against, so a market-wide lull doesn't false-flag
 * every outlet simultaneously.
 * @param {string[]} tier1IsoDatesInMarket unsorted scored-review dates from
 *   ALL tier-1 outlets in one market
 * @returns {string|null} the latest ISO date, or null if no tier-1 history
 */
function marketPulseDate(tier1IsoDatesInMarket) {
  let latest = null;
  for (const d of tier1IsoDatesInMarket) {
    const ms = toMs(d);
    if (ms == null) continue;
    if (latest == null || ms > toMs(latest)) latest = d;
  }
  return latest;
}

/**
 * Classify one (outlet, market) cadence row.
 * @param {object} opts
 * @param {string[]} opts.outletDates scored-review ISO dates for this outlet+market (any order)
 * @param {string|null} opts.marketPulseIso market pulse date (see marketPulseDate); null falls back to nowMs
 * @param {number} opts.nowMs
 * @returns {{status:'red'|'green'|'unknown', reason?:string, medianGapDays?:number,
 *            thresholdDays?:number, silentDays?:number, lastReviewDate?:string}}
 */
function classifyOutletCadence({ outletDates, marketPulseIso, nowMs }) {
  if (!outletDates || !outletDates.length) return { status: 'unknown', reason: 'no-history' };
  const sorted = [...outletDates].filter((d) => toMs(d) != null).sort();
  if (!sorted.length) return { status: 'unknown', reason: 'no-history' };
  const lastReviewDate = sorted[sorted.length - 1];
  const median = medianGapDays(sorted);
  const referenceMs = marketPulseIso ? toMs(marketPulseIso) : nowMs;
  const silentDays = ((referenceMs != null ? referenceMs : nowMs) - toMs(lastReviewDate)) / 86400000;
  if (median == null) {
    return { status: 'unknown', reason: 'insufficient-history', lastReviewDate, silentDays };
  }
  const thresholdDays = Math.max(RED_MULTIPLIER * median, SEASONAL_FLOOR_DAYS);
  return {
    status: silentDays > thresholdDays ? 'red' : 'green',
    medianGapDays: Math.round(median * 10) / 10,
    thresholdDays: Math.round(thresholdDays * 10) / 10,
    silentDays: Math.round(silentDays * 10) / 10,
    lastReviewDate,
  };
}

/**
 * Full report: every (outlet, market) row with >=1 scored review ever, for
 * outlets at or below `maxTier` (default T1+T2 — the plan's "outlet
 * heartbeat" explicitly covers Newsday, a T2 outlet, per card #280).
 *
 * @param {Array<object>} reviews reviews.json reviews array/values (raw records)
 * @param {object} outlets registry.outlets map
 * @param {object} [opts]
 * @param {(showId:string)=>string} [opts.marketOf] showId -> market key; defaults to a
 *   passthrough expecting reviews already carry a `.market` field
 * @param {number} [opts.maxTier=2]
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {Array<{outletId, market, status, ...}>}
 */
function buildCadenceReport(reviews, outlets, opts = {}) {
  const { marketOf, maxTier = 2, nowMs = Date.now() } = opts;
  const withMarket = reviews
    .filter((r) => r.assignedScore != null && r.publishDate && r.outletId)
    .map((r) => ({ ...r, market: marketOf ? marketOf(r.showId) : r.market }))
    .filter((r) => r.market);

  // Market pulse per market, from tier-1 outlets only.
  const pulseByMarket = {};
  const t1DatesByMarket = {};
  for (const r of withMarket) {
    const o = outlets[r.outletId];
    if (!o || o.tier !== 1) continue;
    (t1DatesByMarket[r.market] = t1DatesByMarket[r.market] || []).push(r.publishDate);
  }
  for (const [market, dates] of Object.entries(t1DatesByMarket)) {
    pulseByMarket[market] = marketPulseDate(dates);
  }

  // Group dates by (outletId, market) for outlets within the tier ceiling.
  const groups = new Map(); // key `${outletId}::${market}` -> dates[]
  for (const r of withMarket) {
    const o = outlets[r.outletId];
    if (!o || !o.tier || o.tier > maxTier) continue;
    const key = `${r.outletId}::${r.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.publishDate);
  }

  const rows = [];
  for (const [key, dates] of groups) {
    const [outletId, market] = key.split('::');
    const cls = classifyOutletCadence({
      outletDates: dates,
      marketPulseIso: pulseByMarket[market] || null,
      nowMs,
    });
    rows.push({ outletId, market, tier: outlets[outletId].tier, reviewCount: dates.length, ...cls });
  }
  return rows;
}

module.exports = {
  medianGapDays,
  marketPulseDate,
  classifyOutletCadence,
  buildCadenceReport,
  SEASONAL_FLOOR_DAYS,
  RED_MULTIPLIER,
};
