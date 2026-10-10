'use strict';

/**
 * cost-for-week.js — the ONE answer to "what did this show cost to run in
 * week W, and what did it need to gross to break even?" (BRO-4989).
 *
 *   costForWeek(record, weekEnding, ctx) -> { cost, breakEven, low, high, quality, ... }
 *
 * Inputs are the record's dated costHistory anchors (cost-history.js). A
 * figure is carried to week W by the Broadway cost index
 * (data/broadway-cost-index.json): an $800K nut in 2008 is about
 * $800K x index(2023)/index(2008) in 2023. Between two anchors the carried
 * values are blended by time and source quality; outside them the nearest
 * anchor is carried. The range widens with a weaker source and with distance
 * from the anchor. A record with no anchor at all falls back to its legacy
 * weeklyRunningCost (as a migrated anchor), then to the category estimate.
 *
 * Every new consumer must use this: tests/unit/cost-for-week.test.mjs fails
 * when a file outside its baseline reads weeklyRunningCost directly.
 *
 * Pure apart from reading the index file once.
 */

const fs = require('fs');
const path = require('path');
const { SOURCE_TIERS, legacyCostAnchor, anchorErrors } = require('./cost-history');

const INDEX_PATH = path.join(__dirname, '..', '..', 'data', 'broadway-cost-index.json');
const DAY_MS = 86400000;
const YEAR_MS = 365.25 * DAY_MS;

/** Range half-width added per year between the anchor and the week (index error). */
const DRIFT_PER_YEAR = 0.015;
const MAX_HALF_WIDTH = 0.5;
/** Range for a show with no figure at all (category estimate). */
const NO_ANCHOR_HALF_WIDTH = 0.35;
const QUALITY_BANDS = [
  [0.10, 'high'],
  [0.18, 'medium'],
  [0.30, 'low'],
];

/**
 * Break-even gross as a multiple of the weekly running cost, by category:
 * the recoupment model's weekly break-even (nut x (1 - rent share) /
 * (1 - variable rate - theater %)). Read from recoupment-model.js so the two
 * can never drift apart.
 */
const { THEATER_DEAL, getBaseVariableRate } = require('./recoupment-model');
const BREAK_EVEN_RATIO = Object.fromEntries(
  ['musical', 'musicalSpectacle', 'play', 'playStar', 'special'].map((c) => [
    c, (1 - THEATER_DEAL.rentPctOfNut) / (1 - getBaseVariableRate(c) - THEATER_DEAL.pctOfGross),
  ]),
);

let cachedIndex = null;
function loadIndex(file = INDEX_PATH) {
  if (cachedIndex && file === INDEX_PATH) return cachedIndex;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pts = raw.points
    .map((p) => ({ t: Date.parse(p.effectiveDate), v: p.value }))
    .sort((a, b) => a.t - b.t);
  const base = Date.parse(raw._meta.baseDate);
  const idx = { points: pts, base, baseValue: null };
  idx.baseValue = rawIndexAt(idx, base);
  if (file === INDEX_PATH) cachedIndex = idx;
  return idx;
}

/** Index level at time t (ms): geometric between points, flat beyond the ends. */
function rawIndexAt(idx, t) {
  const pts = idx.points;
  if (t <= pts[0].t) return pts[0].v;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
  let i = 1;
  while (pts[i].t < t) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const f = (t - a.t) / (b.t - a.t);
  return a.v * Math.pow(b.v / a.v, f);
}

function toTime(d) {
  const t = d instanceof Date ? d.getTime() : Date.parse(String(d).slice(0, 10));
  if (!Number.isFinite(t)) throw new Error(`bad date ${d}`);
  return t;
}

/** Cost index at a date, 1.0 at the index base date (Oct 2025). */
function costIndexAt(date, idx = loadIndex()) {
  return rawIndexAt(idx, toTime(date)) / idx.baseValue;
}

/** Carry an amount from one date's price level to another's. */
function carry(amount, fromDate, toDate, idx = loadIndex()) {
  return amount * rawIndexAt(idx, toTime(toDate)) / rawIndexAt(idx, toTime(fromDate));
}

function breakEvenRatio(category) {
  return BREAK_EVEN_RATIO[category] || BREAK_EVEN_RATIO.musical;
}

function qualityFor(halfWidth, hasAnchor) {
  if (!hasAnchor) return 'estimated';
  for (const [limit, label] of QUALITY_BANDS) if (halfWidth <= limit + 1e-9) return label; // float-safe band edge
  return 'low';
}

/**
 * Cost-equivalent anchors: break-even anchors are converted to a running
 * cost with the category ratio so both kinds feed one series.
 */
function costAnchors(record, show, category) {
  // Malformed anchors are skipped (check-cost-anchors.js reports them).
  let hist = Array.isArray(record?.costHistory) ? record.costHistory.filter((a) => anchorErrors(a).length === 0) : [];
  if (!hist.length) {
    const legacy = legacyCostAnchor(record || {}, show);
    hist = legacy ? [legacy] : [];
  }
  return hist.map((a) => ({
    ...a,
    t: toTime(a.asOf),
    costAmount: a.kind === 'break-even' ? a.amount / breakEvenRatio(category) : a.amount,
    baseHalfWidth: (SOURCE_TIERS[a.sourceType] || SOURCE_TIERS['industry-estimate']).halfWidth,
  }));
}

/**
 * @param {object} record - commercial.json record (costHistory, weeklyRunningCost...)
 * @param {string|Date} weekEnding
 * @param {{ show?: object, category?: string, fallbackCost?: number, fallbackAsOf?: string, index?: object }} [ctx]
 *   category: recoupment-model classifyShow() category (break-even ratio).
 *   fallbackCost: the category estimate (estimateWeeklyNut with eraAdjust:false,
 *   i.e. 2025-calibrated) used only when the record has no figure at all.
 * @returns {{ cost, breakEven, low, high, breakEvenLow, breakEvenHigh, halfWidth, quality, basis, anchors }}
 */
function costForWeek(record, weekEnding, ctx = {}) {
  const idx = ctx.index || loadIndex();
  const category = ctx.category || 'musical';
  const t = toTime(weekEnding);
  const anchors = costAnchors(record, ctx.show, category);

  let cost;
  let halfWidth;
  let basis;
  let used = [];

  if (!anchors.length) {
    if (!Number.isFinite(ctx.fallbackCost)) return null;
    const asOf = ctx.fallbackAsOf || '2025-07-01';
    cost = ctx.fallbackCost * rawIndexAt(idx, t) / rawIndexAt(idx, toTime(asOf));
    halfWidth = NO_ANCHOR_HALF_WIDTH;
    basis = 'category-estimate';
  } else {
    const carried = (a) => a.costAmount * rawIndexAt(idx, t) / rawIndexAt(idx, a.t);
    const hw = (a) => Math.min(a.baseHalfWidth + DRIFT_PER_YEAR * Math.abs(t - a.t) / YEAR_MS, MAX_HALF_WIDTH);
    const before = anchors.filter((a) => a.t <= t);
    const after = anchors.filter((a) => a.t > t);
    // On each side, the most informative anchor: the narrowest range once
    // distance is counted (source tier + drift), ties to the nearest. A weekly
    // series uses its nearest post; a strong trade report two years back
    // beats a fresh rough estimate. Exact ties (two sources the same day and
    // tier) are all used.
    const bestSet = (list) => {
      if (!list.length) return [];
      const min = Math.min(...list.map(hw));
      const best = list.filter((a) => hw(a) - min < 1e-9);
      const tNear = best.reduce((m, a) => (Math.abs(a.t - t) < Math.abs(m - t) ? a.t : m), best[0].t);
      return best.filter((a) => a.t === tNear);
    };
    const A = bestSet(before);
    const B = bestSet(after);
    let weighted;
    if (A.length && B.length) {
      const f = (t - A[0].t) / (B[0].t - A[0].t);
      weighted = [
        ...A.map((a) => ({ a, w: (1 - f) / hw(a) ** 2 })),
        ...B.map((a) => ({ a, w: f / hw(a) ** 2 })),
      ];
      basis = 'interpolated';
    } else {
      weighted = (A.length ? A : B).map((a) => ({ a, w: 1 / hw(a) ** 2 }));
      basis = A.length ? 'carried-forward' : 'carried-back';
    }
    const W = weighted.reduce((s, x) => s + x.w, 0);
    cost = weighted.reduce((s, x) => s + x.w * carried(x.a), 0) / W;
    halfWidth = weighted.reduce((s, x) => s + x.w * hw(x.a), 0) / W;
    used = weighted.map((x) => ({ asOf: x.a.asOf, amount: x.a.amount, kind: x.a.kind, sourceType: x.a.sourceType }));
  }

  const ratio = breakEvenRatio(category);
  const r = (n) => Math.round(n);
  return {
    cost: r(cost),
    low: r(cost * (1 - halfWidth)),
    high: r(cost * (1 + halfWidth)),
    breakEven: r(cost * ratio),
    breakEvenLow: r(cost * ratio * (1 - halfWidth)),
    breakEvenHigh: r(cost * ratio * (1 + halfWidth)),
    halfWidth: Math.round(halfWidth * 1000) / 1000,
    quality: qualityFor(halfWidth, anchors.length > 0),
    basis,
    anchors: used,
  };
}

/**
 * Weekly status from a gross and a costForWeek() result. The gross-to-
 * break-even multiple is a range (the break-even is); when that range
 * includes 1.0 the show is Near Cost, never Below Cost (owner, BRO-4989).
 * @returns {{ status: 'above-cost'|'near-cost'|'below-cost', multiple, multipleLow, multipleHigh }|null}
 */
function weeklyCostStatus(gross, cw) {
  if (!Number.isFinite(gross) || !cw || !(cw.breakEven > 0)) return null;
  const multiple = gross / cw.breakEven;
  const multipleLow = gross / cw.breakEvenHigh;
  const multipleHigh = gross / cw.breakEvenLow;
  let status;
  if (multipleLow <= 1 && multipleHigh >= 1) status = 'near-cost';
  else status = multipleLow > 1 ? 'above-cost' : 'below-cost';
  const r = (n) => Math.round(n * 100) / 100;
  return { status, multiple: r(multiple), multipleLow: r(multipleLow), multipleHigh: r(multipleHigh) };
}

module.exports = {
  costForWeek,
  weeklyCostStatus,
  costIndexAt,
  carry,
  breakEvenRatio,
  loadIndex,
  BREAK_EVEN_RATIO,
  DRIFT_PER_YEAR,
  NO_ANCHOR_HALF_WIDTH,
};
