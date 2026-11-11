/**
 * review-forecast-v2-earlier-critics.js (BRO-7369 A, B, C-gap): the site's OWN critic scores for a show's earlier
 * production (Off-Broadway, West End, Off-West-End) as inputs to the review-forecast RESEARCH backtest.
 * Pure: no fs, no network, no clock. The live forecast and the nightly pilot do not import this file.
 *
 * Note: v1 already carries priorRun (latest earlier production of the same title, any market, score minus baseline,
 * opened at least LAG_DAYS before). These features test what v1 does not use: the earlier production's review
 * COUNT (shrinkage), only productions that opened before the Broadway first preview, a leakage-safe re-computation
 * from reviews dated by that cutoff, tier weighting, a T1-only version, and the audience-minus-critics gap.
 *
 *   ctx.reviewsByShow = Map showId -> [{ day (number), score, w (effective tier weight), t1 (bool) }]
 *   features (K = EC_K shrinks the gap toward 0 when few reviews):
 *     ecHas, ecGap      A: canonical score of the earlier production minus mu, shrunk by its review count
 *     ecWGap            B: tier-weighted mean of its reviews dated by the cutoff, minus mu, shrunk by their count
 *     ecT1Has, ecT1Gap  B: same with Tier-1 outlets only
 *     eaGapHas, eaCritGap  C: shrunk earlier-audience mean minus the earlier production's canonical score
 */
'use strict';

const RF = require('./review-forecast.js');
const EA = require('./review-forecast-v2-earlier-audience.js');

const { toDay } = RF;
const EC_K = 5;
const EARLIER_CATEGORIES = new Set(['off-broadway', 'west-end', 'off-west-end']);
const EC_GROUPS = {
  a: ['ecHas', 'ecGap'],
  bW: ['ecHas', 'ecWGap'],
  bT1: ['ecT1Has', 'ecT1Gap'],
  cGap: ['eaGapHas', 'eaCritGap'],
};
const EC_FEATURE_NAMES = [...new Set(Object.values(EC_GROUPS).flat())];
const dayStr = (d) => new Date(d * 86400000).toISOString().slice(0, 10);

/** Latest earlier production of the same title in an Off-Broadway / West End market that opened on or before the cutoff. */
function findEarlier(target, ctx, cutoffIso) {
  const tk = RF.titleKey(target.title); const cut = toDay(cutoffIso);
  return (ctx.pool || []).filter((s) => s.id !== target.id && EARLIER_CATEGORIES.has(s.category) && RF.titleKey(s.title) === tk
    && toDay(s.openingDate) != null && toDay(s.openingDate) <= cut)
    .sort((a, b) => (a.openingDate < b.openingDate ? 1 : -1))[0] || null;
}

function buildEarlierCriticsFeatures(target, ctx, mu) {
  const x = {}; EC_FEATURE_NAMES.forEach((k) => { x[k] = 0; });
  const has = { earlierCritics: false, earlierT1: false };
  const prov = [];
  const cutoffIso = EA.earlierCutoff(target); const cut = toDay(cutoffIso);
  const p = mu == null ? null : findEarlier(target, ctx, cutoffIso);
  if (!p) return { x, provenance: prov, has };
  const n = p.rc || 0;
  x.ecHas = 1; has.earlierCritics = true;
  x.ecGap = (n / (n + EC_K)) * (p.score - mu);
  prov.push({ kind: 'earlier-critics', ref: p.id, date: p.openingDate });
  const rv = ((ctx.reviewsByShow && ctx.reviewsByShow.get(p.id)) || []).filter((r) => r.day <= cut);
  if (rv.length) {
    const sw = rv.reduce((a, r) => a + r.w, 0);
    const wMean = rv.reduce((a, r) => a + r.w * r.score, 0) / sw;
    x.ecWGap = (rv.length / (rv.length + EC_K)) * (wMean - mu);
    prov.push({ kind: 'earlier-critics-reviews', ref: p.id, date: dayStr(Math.max(...rv.map((r) => r.day))) });
    const t1 = rv.filter((r) => r.t1);
    if (t1.length) {
      x.ecT1Has = 1; has.earlierT1 = true;
      x.ecT1Gap = (t1.length / (t1.length + EC_K)) * (RF.mean(t1.map((r) => r.score)) - mu);
    }
  }
  const a = ctx.earlierAudience && ctx.earlierAudience[target.id];
  if (a && a.n > 0) {
    x.eaGapHas = 1;
    x.eaCritGap = (a.n * a.mean + EA.EA_K * EA.EA_CENTER) / (a.n + EA.EA_K) - p.score;
  }
  return { x, provenance: prov, has };
}

/** Throws if the earlier production opened after the cutoff or any review used is dated after it. */
function assertNoLeakageEarlierCritics(target, provenance) {
  const cutoff = EA.earlierCutoff(target);
  const bad = provenance.filter((q) => !q.date || toDay(q.date) == null || q.date > cutoff);
  if (bad.length) {
    const e = new Error(`LEAKAGE(earlier-critics) for ${target.id} (previews ${target.previewsStartDate || 'n/a'}, opening ${target.openingDate}): ${JSON.stringify(bad[0])} is after ${cutoff}`);
    e.bad = bad; throw e;
  }
  return true;
}

module.exports = { EC_K, EARLIER_CATEGORIES, EC_GROUPS, EC_FEATURE_NAMES, findEarlier, buildEarlierCriticsFeatures, assertNoLeakageEarlierCritics };
