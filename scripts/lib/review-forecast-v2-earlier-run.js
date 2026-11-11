/**
 * review-forecast-v2-earlier-run.js (BRO-7347): "earlier-run" input for the review-score forecast
 * RESEARCH backtest. Pure: no fs, no network, no clock. The live forecast does not import this file.
 *
 * Source: scores (0-100) that research agents assigned to reviews of the show's EARLIER run (regional,
 * Off-Broadway, West End tryout), gathered from the web, each with its publish date. The scores are
 * noisy and carry some hindsight risk (an agent read them after the Broadway verdict was known).
 * Leakage rule: a review counts only if published on or before opening minus LAG_DAYS. Partial dates
 * ("2013", "2010-04") are read as the LAST day of that period, the conservative choice.
 *
 *   ctx.earlierRun = { [showId]: [[score, 'YYYY[-MM[-DD]]', viaRoundUp 0|1], ...] }
 *   features: erHas, erDev (shrunk earlier mean minus the baseline mean mu), erLow / erHigh (step at ER_CUT),
 *             erTrouble (undated trouble list; NOT valid for forecasting, exploratory only)
 */
'use strict';

const RF = require('./review-forecast.js');

const { LAG_DAYS, toDay } = RF;
const ER_CUT = 75; // declared in advance by the parent; 72 and 78 are forked-path sensitivity checks
const ER_SHRINK_K = 2;

const ER_GROUPS = {
  linear: ['erHas', 'erDev'],
  step: ['erHas', 'erLow', 'erHigh'],
  trouble: ['erTrouble'],
};
const ER_FEATURE_NAMES = [...new Set(Object.values(ER_GROUPS).flat())];

/** 'YYYY' -> last day of year, 'YYYY-MM' -> last day of month, full date unchanged. Null when unparseable. */
function latestDay(s) {
  if (typeof s !== 'string') return null;
  if (/^\d{4}$/.test(s)) return `${s}-12-31`;
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) { const last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate(); return `${s}-${String(last).padStart(2, '0')}`; }
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function buildEarlierRunFeatures(target, ctx, mu, opts = {}) {
  const cut = opts.cut ?? ER_CUT;
  const D = toDay(target.openingDate);
  const cutoff = D - LAG_DAYS;
  const prov = [];
  const x = {}; ER_FEATURE_NAMES.forEach((k) => { x[k] = 0; });
  const has = { earlierRun: false, trouble: false };
  const list = (ctx.earlierRun && ctx.earlierRun[target.id]) || [];
  const kept = [];
  for (const [score, date] of list) {
    const d = latestDay(date);
    if (d == null || toDay(d) == null || toDay(d) > cutoff) continue; // undated or too late: dropped, never used
    kept.push(score); prov.push({ kind: 'earlier-run-review', ref: target.id, date: d });
  }
  if (kept.length) {
    const mean = RF.mean(kept);
    const shrunk = (kept.length * mean + ER_SHRINK_K * mu) / (kept.length + ER_SHRINK_K);
    x.erHas = 1; x.erDev = shrunk - mu;
    if (mean < cut) x.erLow = 1; else x.erHigh = 1;
    has.earlierRun = true;
  }
  if (ctx.troubleSet && ctx.troubleSet.has(target.id)) { x.erTrouble = 1; has.trouble = true; }
  return { x, provenance: prov, has };
}

/** Throws if an earlier-run review used by the target is dated after opening minus LAG_DAYS (or undated). */
function assertNoLeakageEarlierRun(target, provenance) {
  const D = toDay(target.openingDate);
  const bad = provenance.filter((p) => toDay(p.date) == null || !(toDay(p.date) <= D - LAG_DAYS));
  if (bad.length) {
    const e = new Error(`LEAKAGE(earlier-run) for ${target.id} (${target.openingDate}): ${bad.length} review(s) not dated by opening minus ${LAG_DAYS}d, first: ${JSON.stringify(bad[0])}`);
    e.bad = bad; throw e;
  }
  return true;
}

module.exports = { ER_GROUPS, ER_FEATURE_NAMES, ER_CUT, ER_SHRINK_K, latestDay, buildEarlierRunFeatures, assertNoLeakageEarlierRun };
