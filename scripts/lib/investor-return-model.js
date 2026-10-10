'use strict';

/**
 * investor-return-model.js — SHADOW replacement for the recoupment model's
 * percentage (BRO-4989). The live site still reads modelRecoupmentPct from
 * recoupment-model.js until a separate, flagged switch.
 *
 * What was wrong with modelRecoupmentPct (dear-evan-hansen-2016 22,506%,
 * chicago 95,786%, six 7,078%, book-of-mormon 14,659%):
 *  1. The denominator. A $10M SVOG grant was subtracted from capitalization,
 *     and the floor was the reserve fund, so a show whose grant exceeded its
 *     cap (Chicago $2.5M, Six $5M, DEH $9.5M) divided years of profit by a
 *     few hundred thousand dollars. A grant is cash the production received,
 *     not capital investors put in: here it is an inflow, and the
 *     denominator is always the capitalization.
 *  2. It was producer-level operating profit, not what investors got back.
 *     After recoupment, net profits split between the producers and the
 *     investors (the standard 50/50 "producer's share"). Here the investor
 *     multiple is: capital returned + investor share of profit beyond it.
 *  3. One current cost figure for the whole run (and a 10-year cap with a
 *     lifetime shortcut for long runs). Here every week's cost comes from
 *     costForWeek() (dated anchors carried by the Broadway cost index), and
 *     the whole run is simulated week by week.
 *
 * Royalties are unchanged from recoupment-model.js: authors' % of gross
 * before recoupment, the 35% royalty pool of operating profit after it.
 *
 * Reported return wins: a cited investorMultiple on the record is returned as
 * `reportedMultiple` and used by the designation classifier ahead of the model.
 */

const rm = require('./recoupment-model');
const { costForWeek, breakEvenRatio, costIndexAt } = require('./cost-for-week');

const WEEK_MS = 7 * 86400000;
/** Standard Broadway split of net profits after recoupment (investors' half). */
const INVESTOR_PROFIT_SHARE = 0.5;
/** Multiples above these are flagged for a human look, never silently shown. */
const SANITY = { anyRun: 50, shortRunYears: 5, shortRunMultiple: 10 };

function sundayOnOrAfter(t) {
  const d = new Date(t);
  const add = (7 - d.getUTCDay()) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add);
}
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const inCovidDark = (t) => t >= rm.COVID_DARK_START.getTime() && t < rm.COVID_DARK_END.getTime();

/**
 * Dated weekly schedule for the run: weekly-history grosses where we have
 * them; other weeks share the remaining all-time gross in proportion to the
 * cost index (nominal grosses rise with prices), or, with no all-time figure,
 * the history average carried by the index. Preview weeks use the ramp.
 */
function buildDatedSchedule(show, grossesAllTime, grossesWeekly, now, warnings) {
  const opening = show.openingDate ? Date.parse(show.openingDate) : null;
  const previews = show.previewsStartDate ? Date.parse(show.previewsStartDate) : null;
  const start = previews && opening && previews < opening ? previews : opening;
  if (!start) return [];
  const closing = show.closingDate ? Date.parse(show.closingDate) : null;
  const end = closing && closing < now ? closing : now;

  const hist = grossesWeekly || {};
  const histByWeek = new Map();
  for (const [d, w] of Object.entries(hist)) {
    if (w && Number.isFinite(w.gross)) histByWeek.set(sundayOnOrAfter(Date.parse(d)), w.gross);
  }

  const weeks = [];
  let previewCount = 0;
  for (let t = sundayOnOrAfter(start); t <= end + 6 * 86400000; t += WEEK_MS) {
    if (inCovidDark(t)) continue;
    const isPreview = !!(opening && t < opening && previews);
    if (isPreview) previewCount++;
    weeks.push({ t, date: iso(t), isPreview, previewWeek: isPreview ? previewCount : 0, gross: histByWeek.get(t) ?? null });
  }
  if (!weeks.length) return [];

  const known = weeks.filter((w) => w.gross != null);
  const missing = weeks.filter((w) => w.gross == null);
  if (missing.length) {
    const knownSum = known.reduce((s, w) => s + w.gross, 0);
    const idx = (w) => costIndexAt(w.date); // missing weeks weighted by price level
    let remaining = null;
    if (grossesAllTime && grossesAllTime.gross > 0) {
      let all = grossesAllTime.gross;
      const expectedPerfs = weeks.length * 8;
      const ratio = (grossesAllTime.performances || 0) / Math.max(expectedPerfs, 1);
      if (ratio > 1.3) {
        all /= ratio;
        warnings.push(`All-time gross decontaminated: ${grossesAllTime.performances} perfs vs ${expectedPerfs} expected`);
      }
      remaining = all - knownSum;
    }
    const weights = missing.map((w) => idx(w) * (w.isPreview ? rm.getPreviewGrossMultiplier(w.previewWeek) : 1));
    const wSum = weights.reduce((s, x) => s + x, 0);
    if (remaining != null && remaining > 0) {
      missing.forEach((w, i) => { w.gross = remaining * weights[i] / wSum; w.estimated = true; });
    } else if (known.length) {
      // No usable all-time remainder: the history's index-adjusted average.
      const avgPerIdx = known.reduce((s, w) => s + w.gross / idx(w), 0) / known.length;
      missing.forEach((w, i) => { w.gross = avgPerIdx * weights[i]; w.estimated = true; });
      if (remaining != null) warnings.push('All-time gross does not exceed weekly history; gap weeks use the history average');
    } else {
      return [];
    }
    warnings.push(`${missing.length} of ${weeks.length} weeks estimated (no weekly grosses)`);
  }
  return weeks;
}

/**
 * @param {object} show - shows.json record
 * @param {object} commercial - commercial.json record
 * @param {object|null} grossesAllTime
 * @param {object|null} grossesWeekly - { 'YYYY-MM-DD': { gross } }
 * @param {{ now?: number }} [opts]
 */
function calculateInvestorReturn(show, commercial, grossesAllTime, grossesWeekly, opts = {}) {
  const warnings = [];
  const cap = commercial.capitalization;
  if (!cap) return { error: 'No capitalization data', warnings: ['Missing capitalization'] };
  const now = opts.now || Date.now();

  const category = rm.classifyShow(show);
  const baseVarRate = rm.getBaseVariableRate(category);
  const authorRate = rm.AUTHOR_ROYALTY_PRE[show.type] || rm.AUTHOR_ROYALTY_PRE.musical;
  const slug = show.slug || show.id;
  const starDeal = rm.KNOWN_STAR_DEALS[slug] || null;
  const fallbackCost = rm.estimateWeeklyNut(show, commercial, { eraAdjust: false });

  const weeks = buildDatedSchedule(show, grossesAllTime, grossesWeekly, now, warnings);
  if (!weeks.length) return { error: 'No gross data available', warnings: ['No grosses data'] };

  const isClosed = !!(show.closingDate && Date.parse(show.closingDate) < now);
  const opening = show.openingDate ? Date.parse(show.openingDate) : weeks[0].t;

  // Cash the production received that is not investor capital.
  const svog = rm.KNOWN_SVOG[slug] || rm.parseSvogFromNotes(commercial.notes) || 0;
  const svogWeek = svog ? weeks.findIndex((w) => w.t >= Date.parse('2021-09-14')) : -1;
  const notesCredit = rm.parseTaxCreditFromNotes(commercial.notes);
  const runEnd = weeks[weeks.length - 1].t;
  const eligibleCredit = runEnd >= rm.TAX_CREDIT_PROGRAM_START.getTime() && opening <= rm.TAX_CREDIT_PROGRAM_END.getTime();

  // Costs for each week, once (scenario multipliers scale them).
  const costs = weeks.map((w) => costForWeek(commercial, w.date, { show, category, fallbackCost }));
  if (costs.some((c) => !c)) return { error: 'No cost figure and no category estimate', warnings };
  const firstYearCost = costs.slice(0, 52).reduce((s, c) => s + c.cost, 0);
  const taxCredit = notesCredit !== null ? notesCredit
    : (eligibleCredit ? Math.min(rm.TAX_CREDIT_RATE * (cap + firstYearCost), rm.TAX_CREDIT_MAX) : 0);
  const creditWeek = isClosed ? weeks.length - 1 : Math.min(rm.TAX_CREDIT_LAG_WEEKS, weeks.length - 1);

  const isLimitedRun = !!(show.closingDate && show.openingDate && (Date.parse(show.closingDate) - Date.parse(show.openingDate)) < 200 * 86400000);
  const currentCost = costs[costs.length - 1].cost;
  const reserve = currentCost * (isLimitedRun ? 1.5 : rm.RESERVE_FUND_WEEKS);

  const results = {};
  for (const [scenario, mult] of Object.entries(rm.SCENARIO_MULTIPLIERS)) {
    let cum = 0;
    let post = false;
    let recoupWeek = null;
    let totalGross = 0;
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      if (i === svogWeek) cum += svog;
      if (i === creditWeek) cum += taxCredit;
      const gross = w.gross * mult.grossAdj;
      const nut = costs[i].cost * mult.fixedCost;
      const varRate = (post ? baseVarRate - authorRate : baseVarRate) * mult.variableCost;
      let fixed = nut * (w.isPreview ? rm.PREVIEW_DEFAULTS.costMultiplier : 1);
      if (i < 8) fixed += rm.MARKETING_SURCHARGES.openingPush[category] || rm.MARKETING_SURCHARGES.openingPush.musical;
      let profit = gross - gross * varRate - rm.calcTheaterOverage(gross, nut) - fixed;
      if (starDeal) profit -= starDeal.weeklyPremium + Math.max(0, gross - starDeal.grossThreshold) * starDeal.grossPct;
      if (post && profit > 0) profit -= profit * rm.ROYALTY_POOL_POST_RECOUP;
      cum += profit;
      totalGross += gross;
      if (!post && cum >= cap + reserve) { post = true; recoupWeek = i; }
    }
    if (isClosed && weeks.length < 104) cum -= rm.CLOSING_COSTS[category] || rm.CLOSING_COSTS.musical;
    // A running show still holds its reserve; a closed one has paid it out.
    const distributable = isClosed ? cum : cum - reserve;
    const returned = Math.min(Math.max(distributable, 0), cap) + INVESTOR_PROFIT_SHARE * Math.max(distributable - cap, 0);
    results[scenario] = {
      producerProfit: Math.round(cum),
      investorReturned: Math.round(returned),
      investorMultiple: Math.round(returned / cap * 100) / 100,
      recoupedPct: Math.round(Math.min(Math.max(distributable, 0), cap) / cap * 1000) / 10,
      recouped: distributable >= cap,
      recoupDate: recoupWeek != null ? weeks[recoupWeek].date : null,
      totalGross: Math.round(totalGross),
    };
  }

  const now0 = costs[costs.length - 1];
  const yearsRun = weeks.length / 52;
  const flags = [];
  const m = results.central.investorMultiple;
  if (m > SANITY.anyRun) flags.push(`investor multiple ${m}x above ${SANITY.anyRun}x: check capitalization and costs`);
  else if (yearsRun < SANITY.shortRunYears && m > SANITY.shortRunMultiple) flags.push(`investor multiple ${m}x in a ${yearsRun.toFixed(1)}-year run: check inputs`);

  const reportedMultiple = Number.isFinite(commercial.investorMultiple) ? commercial.investorMultiple : null;

  return {
    slug,
    title: show.title,
    category,
    capitalization: cap,
    svogGrant: svog,
    taxCreditAmount: Math.round(taxCredit),
    reserveFund: Math.round(reserve),
    weeks: weeks.length,
    estimatedWeeks: weeks.filter((w) => w.estimated).length,
    currentWeeklyCost: now0.cost,
    currentBreakEven: now0.breakEven,
    currentBreakEvenRange: [now0.breakEvenLow, now0.breakEvenHigh],
    costQuality: now0.quality,
    costBasis: now0.basis,
    optimistic: results.optimistic,
    central: results.central,
    pessimistic: results.pessimistic,
    investorMultipleRange: [results.pessimistic.investorMultiple, results.central.investorMultiple, results.optimistic.investorMultiple],
    recoupedPctRange: [results.pessimistic.recoupedPct, results.central.recoupedPct, results.optimistic.recoupedPct],
    modelRecouped: results.central.recouped,
    reportedMultiple,
    sanityFlags: flags,
    warnings,
    breakEvenRatio: Math.round(breakEvenRatio(category) * 1000) / 1000,
  };
}

module.exports = {
  calculateInvestorReturn,
  buildDatedSchedule,
  INVESTOR_PROFIT_SHARE,
  SANITY,
};
