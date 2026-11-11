/**
 * review-forecast-v2-extra.js (BRO-7347): second batch of pre-opening inputs for the research
 * backtest. Pure (no fs, network, clock). Same rule as v1/v2: every dated input must be dated
 * strictly before opening night (credits and reviews keep the LAG_DAYS lag); provenance is
 * recorded and refused by assertNoLeakageExtra().
 *
 *   calendar   spring-crush flag and month of year (the opening date itself; announced weeks ahead)
 *   venue      house type: nonprofit-run houses (Vivian Beaumont, Samuel J. Friedman, Laura Pels, ...)
 *   awards     honours earned by EARLIER productions of the same title, counted only once the
 *              ceremony season had ended (conservative date: 30 June of the season's end year)
 *   panel      per-critic forecasts: each regular critic's own recent average (last 24 months,
 *              reviews dated before opening minus the lag), combined with the real tier weights
 */
'use strict';
const RF = require('./review-forecast.js');
const { LAG_DAYS, toDay } = RF;

const EXTRA_GROUPS = {
  calendar: ['springCrush', 'monthSin', 'monthCos'],
  venueType: ['nonprofitHouse'],
  awards: ['awardWins', 'awardNoms'],
  panel: ['panelAll', 'panelType'],
};
const EXTRA_FEATURE_NAMES = Object.values(EXTRA_GROUPS).flat();
const NONPROFIT_HOUSE = /vivian beaumont|mitzi newhouse|samuel j\.? friedman|laura pels|linda gross|harold and miriam steinberg|new york city center|classic stage|public theater|newman|anspacher/i;
const AWARD_KEYS = ['tony', 'olivier', 'lortel', 'obie', 'oba', 'pulitzer', 'whatsOnStage', 'outerCriticsCircle', 'dramadesk', 'dramaLeague', 'nyDramaCritics', 'criticsCircle', 'eveningStandard'];
const PANEL_MONTHS = 24; const PANEL_MIN_REVIEWS = 3; const PANEL_SHRINK_K = 3;

/** Conservative date an award was public: 30 June of the season's end year ("2015-16" -> 2016-06-30; pulitzer year Y -> Y-06-30). */
function awardDate(key, rec) {
  if (key === 'pulitzer' && rec && rec.year) return `${rec.year}-06-30`;
  const m = /^(\d{4})-(\d{2})$/.exec((rec && rec.season) || '');
  if (!m) return null;
  const y = +m[1] + 1; // end year of the season
  return `${y}-06-30`;
}

function monthParts(iso) {
  const m = +iso.slice(5, 7); const d = +iso.slice(8, 10);
  return { m, d, doy: (m - 1) * 30.4 + d };
}

/** Earlier-production awards: counts wins and nominations dated on or before D - LAG_DAYS. */
function awardsFeatures(target, ctx, note) {
  const D = toDay(target.openingDate);
  const tk = RF.titleKey(target.title);
  let wins = 0; let noms = 0; let n = 0;
  for (const s of ctx.pool) {
    if (s.id === target.id || RF.titleKey(s.title) !== tk) continue;
    if (toDay(s.openingDate) == null || toDay(s.openingDate) > D - LAG_DAYS) continue;
    const rec = ctx.awards && ctx.awards[s.id];
    if (!rec) continue;
    for (const k of AWARD_KEYS) {
      const a = rec[k];
      if (!a) continue;
      const ad = awardDate(k, a);
      if (!ad || toDay(ad) == null || toDay(ad) > D - LAG_DAYS) continue;
      const w = (a.wins || []).length; const nn = Math.max(a.nominations || 0, (a.nominatedFor || []).length, w);
      if (w || nn) { wins += w; noms += nn; n += 1; note('award', `${s.id}:${k}`, ad); }
    }
  }
  return { awardWins: Math.log1p(wins), awardNoms: Math.log1p(noms), n };
}

/**
 * Panel features. ctx.panel = { byCritic: Map(key -> [{date:'YYYY-MM-DD', score, type, weight, showOpen}]) }.
 * The panel is the set of critics with >= PANEL_MIN_REVIEWS dated reviews in the 24 months before
 * (opening - LAG); each contributes its mean score (shrunk to the panel mean), weighted by tier weight.
 * panelType uses only reviews of shows of the target's type (play/musical).
 */
function panelFeatures(target, ctx, note, mu) {
  const D = toDay(target.openingDate);
  const hi = D - LAG_DAYS; const lo = hi - PANEL_MONTHS * 30.4;
  const rowsFor = (typeOnly) => {
    const crit = [];
    for (const [key, list] of ctx.panel.byCritic) {
      const use = list.filter((r) => r.day <= hi && r.day >= lo && (!typeOnly || r.type === target.type));
      if (use.length < PANEL_MIN_REVIEWS) continue;
      crit.push({ key, mean: RF.mean(use.map((r) => r.score)), n: use.length, w: RF.mean(use.map((r) => r.weight)) });
    }
    return crit;
  };
  const combine = (crit) => {
    if (crit.length < 5) return null;
    const allW = crit.reduce((s, c) => s + c.w, 0);
    const grand = crit.reduce((s, c) => s + c.w * c.mean, 0) / allW;
    let num = 0; let den = 0;
    for (const c of crit) { const sh = (c.n * c.mean + PANEL_SHRINK_K * grand) / (c.n + PANEL_SHRINK_K); num += c.w * sh; den += c.w; }
    return num / den;
  };
  const all = rowsFor(false); const typ = rowsFor(true);
  const pa = combine(all); const pt = combine(typ);
  if (pa != null) note('panel', `${all.length} critics`, `${new Date((hi) * 86400000).toISOString().slice(0, 10)}`);
  return { panelAll: pa == null ? 0 : pa - mu, panelType: pt == null ? 0 : pt - mu, has: pa != null };
}

/**
 * ctx = { pool, awards, panel }. mu = the v1 baseline mean for this target (so panel features are
 * "points above the earlier-season category mean").
 */
function buildExtraFeatures(target, ctx, mu) {
  const D = toDay(target.openingDate);
  if (D == null) throw new Error(`bad openingDate for ${target.id}`);
  const prov = []; const note = (kind, ref, date) => prov.push({ kind, ref, date });
  const x = {}; EXTRA_FEATURE_NAMES.forEach((k) => { x[k] = 0; });
  const has = { awards: false, panel: false };
  const { m, doy } = monthParts(target.openingDate);
  x.springCrush = (m === 3 && +target.openingDate.slice(8, 10) >= 15) || m === 4 ? 1 : 0;
  x.monthSin = Math.sin((2 * Math.PI * doy) / 365); x.monthCos = Math.cos((2 * Math.PI * doy) / 365);
  note('opening-date', target.id, null);
  x.nonprofitHouse = target.venue && NONPROFIT_HOUSE.test(target.venue) ? 1 : 0;
  if (ctx.awards) {
    const a = awardsFeatures(target, ctx, note);
    x.awardWins = a.awardWins; x.awardNoms = a.awardNoms; has.awards = a.n > 0;
  }
  if (ctx.panel) {
    const p = panelFeatures(target, ctx, note, mu);
    x.panelAll = p.panelAll; x.panelType = p.panelType; has.panel = p.has;
  }
  return { x, provenance: prov, has };
}

/** Throws unless every dated extra input is on or before opening minus the lag. */
function assertNoLeakageExtra(target, provenance) {
  const D = toDay(target.openingDate); const bad = [];
  for (const p of provenance) {
    if (p.kind === 'opening-date') continue; // the announced opening date itself
    const d = toDay(p.date);
    if (d == null) { bad.push({ ...p, why: 'undated input' }); continue; }
    if (!(d <= D - LAG_DAYS)) bad.push({ ...p, why: `${p.kind} dated ${(D - d).toFixed(0)}d before opening (< ${LAG_DAYS}d lag)` });
  }
  if (bad.length) { const e = new Error(`LEAKAGE(extra) for ${target.id}: ${JSON.stringify(bad[0])}`); e.bad = bad; throw e; }
  return true;
}

module.exports = { EXTRA_GROUPS, EXTRA_FEATURE_NAMES, AWARD_KEYS, NONPROFIT_HOUSE, awardDate, buildExtraFeatures, assertNoLeakageExtra };
