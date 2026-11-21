'use strict';

// BRO-6333: advisory only. These estimates create review holds, never labels.
const { dateBounds, returnSnapshotDate, isRunningReturn } = require('./commercial-return-snapshot');
const { isCommercialScope } = require('./commercial-scope');
const { makeGrossesLookup } = require('./grosses-lookup');
const { costForWeek } = require('./cost-for-week');
const rm = require('./recoupment-model');
const { INVESTOR_PROFIT_SHARE } = require('./investor-return-model');
const { TRICKLE_MAX_MULTIPLE, MODEST_RETURN_DESIGNATIONS } = require('./commercial-designations');

const DAY = 86400000;
const WEEK = 7 * DAY;

function estimateSinceRecoupment(entry, show, weekly, now) {
  const start = dateBounds(entry.recoupedDate)?.end;
  const cap = entry.capitalization;
  const result = { grossSinceRecoupment: 0, weeksObserved: 0, missingWeeks: 0, usesEstimatedCost: false, investorMultiple: null, possibleWindfall: null };
  if (start == null || start > Number(now)) return result;
  const category = rm.classifyShow(show);
  const fallbackCost = rm.estimateWeeklyNut(show, entry, { eraAdjust: false });
  const variableRate = rm.getBaseVariableRate(category) - (rm.AUTHOR_ROYALTY_PRE[show.type] || rm.AUTHOR_ROYALTY_PRE.musical);
  const starDeal = rm.KNOWN_STAR_DEALS[show.slug] || null;
  let profit = 0;
  let missingCost = false;
  for (const [date, row] of Object.entries(weekly || {})) {
    const end = dateBounds(date)?.end;
    // Use complete weeks after the last possible recoupment date. No future
    // grosses, fuzzy slug matches, or extrapolated missing weeks.
    if (end == null || end - start < WEEK || end > Number(now) || !Number.isFinite(row?.gross) || row.gross < 0) continue;
    result.weeksObserved++;
    result.grossSinceRecoupment += row.gross;
    const cost = costForWeek(entry, date, { show, category, fallbackCost, weekly });
    if (!cost || !(cost.cost > 0)) { missingCost = true; continue; }
    result.usesEstimatedCost ||= cost.quality === 'estimated' || cost.basis === 'category-estimate';
    // The same post-recoupment deductions as the investor-return model:
    // variable expenses, theater overage, star deal, then the royalty pool.
    let net = row.gross * (1 - variableRate) - cost.cost - rm.calcTheaterOverage(row.gross, cost.cost);
    if (starDeal) net -= starDeal.weeklyPremium + Math.max(0, row.gross - starDeal.grossThreshold) * starDeal.grossPct;
    if (net > 0) net *= 1 - rm.ROYALTY_POOL_POST_RECOUP;
    profit += net;
  }
  const firstSunday = start + ((7 - new Date(start).getUTCDay()) % 7) * DAY;
  const firstFullWeek = firstSunday - start < WEEK ? firstSunday + WEEK : firstSunday;
  const expected = Math.max(0, Math.floor((Number(now) - firstFullWeek) / WEEK) + 1);
  result.missingWeeks = Math.max(0, expected - result.weeksObserved);
  if (result.weeksObserved && !missingCost && Number.isFinite(cap) && cap > 0) {
    // Prior capital has already been returned. Losing weeks reduce the net
    // estimated additional distribution; they cannot undo that repayment.
    const multiple = 1 + Math.max(0, profit) * INVESTOR_PROFIT_SHARE / cap;
    result.investorMultiple = Math.round(multiple * 100) / 100;
    result.possibleWindfall = multiple >= TRICKLE_MAX_MULTIPLE;
  }
  return result;
}

function findStaleReturns({ shows, commercial, grossesHistory, now = new Date() }) {
  const lookup = makeGrossesLookup(null, grossesHistory);
  const candidates = [];
  for (const show of shows) {
    if (!isCommercialScope(show) || !isRunningReturn(show, now)) continue;
    const entry = commercial.shows?.[show.slug] || commercial.shows?.[show.id];
    if (entry?.recouped !== true || !MODEST_RETURN_DESIGNATIONS.includes(entry.designation)) continue;
    const recoup = dateBounds(entry.recoupedDate);
    if (recoup && (recoup.start > Number(now) || (show.openingDate && recoup.end < Date.parse(show.openingDate)))) continue;
    const snapshotAsOf = returnSnapshotDate(entry, now);
    if (!snapshotAsOf) continue;
    const ageDays = Math.floor((Number(now) - dateBounds(snapshotAsOf).end) / DAY);
    if (ageDays <= 90) continue;
    candidates.push({ slug: show.slug || show.id, snapshotAsOf, ageDays, recoupedDate: entry.recoupedDate,
      estimate: estimateSinceRecoupment(entry, show, lookup.getWeeklyData(show.slug, show.id), now) });
  }
  return candidates;
}

function queueStaleReturns(pending, archive, candidates, now = new Date()) {
  pending.shows ||= {};
  let added = 0;
  for (const candidate of candidates) {
    // BRO-6471: a stale label only needs a look when the estimate says it may have crossed into Windfall. A row
    // estimated at ~1.03x has nothing for anyone to do, and held rows now file a worker card.
    if (candidate.estimate?.possibleWindfall !== true) continue;
    const key = `return-snapshot:${candidate.slug}`;
    const same = row => row?.detectedBy === 'return-snapshot-check' && row.slug === candidate.slug && row.snapshotAsOf === candidate.snapshotAsOf;
    const recentlyReviewed = row => same(row) && /^reviewed-/.test(row.archivedReason || '')
      && Number(now) - Date.parse(row.archivedAt) < 90 * DAY
      && row.estimate?.possibleWindfall === candidate.estimate.possibleWindfall;
    if (Object.values(pending.shows).some(same) || Object.values(archive.shows || {}).some(recentlyReviewed)) continue;
    // Never replace unrelated research or an earlier review still awaiting a decision.
    if (pending.shows[key]) continue;
    const e = candidate.estimate;
    pending.shows[key] = { ...candidate, _reviewHold: true, detectedBy: 'return-snapshot-check', detectedAt: now.toISOString(),
      notes: `Trickle return evidence as of ${candidate.snapshotAsOf} is ${candidate.ageDays} days old. Estimated investor multiple from observed grosses since recoupment: ${e.investorMultiple == null ? 'unavailable' : `${e.investorMultiple}x`}; ${e.weeksObserved} observed weeks, ${e.missingWeeks} missing weeks${e.usesEstimatedCost ? '; category cost estimate used' : ''}. Review whether it has crossed ${TRICKLE_MAX_MULTIPLE}x. This is an estimate, not a reported return; never auto-apply.` };
    added++;
  }
  if (added) pending.lastUpdated = now.toISOString();
  return { added };
}

module.exports = { findStaleReturns, queueStaleReturns };
