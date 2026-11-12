/**
 * review-forecast-v2-earlier-audience.js (BRO-7369): "earlier-production audience" input for the
 * review-score forecast RESEARCH backtest. Pure: no fs, no network, no clock. The live forecast and the
 * nightly pilot do not import this file unless the backtest result earns it a shadow slot.
 *
 * Source: Show Score MEMBER ratings (0-100, each with a publish date) of a show's EARLIER production
 * (Off-Broadway page, or the earlier part of a page the Broadway run shares). Only ratings dated strictly
 * before the Broadway first preview count, and never later than opening minus LAG_DAYS.
 * Stored per show: counts, mean, spread, newest date. No names, no text.
 *
 *   ctx.earlierAudience = { [showId]: { n, mean, shareLe60, newest } }   (pooled over its sources)
 *   features: eaScore = (n*mean + EA_K*EA_CENTER)/(n+EA_K) - EA_CENTER, 0 when the show has no earlier ratings
 *             eaHas   = 1 when it has at least one
 */
'use strict';

const RF = require('./review-forecast.js');

const { LAG_DAYS, toDay } = RF;
const EA_CENTER = 85; // same centre and shrinkage as the v2 audScore (k=10), so the two are comparable
const EA_K = 10;

const EA_GROUPS = { primary: ['eaScore'], flag: ['eaHas', 'eaScore'] };
const EA_FEATURE_NAMES = [...new Set(Object.values(EA_GROUPS).flat())];

/** member ratings on one Show Score page: [{date:'YYYY-MM-DD', rating}] (empty past the last page). */
function parseMembers(html) {
  const out = [];
  const re = /"datePublished":"(\d{4}-\d{2}-\d{2})T[^"]*","reviewRating":\{[^}]*?"ratingValue":(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(html || ''))) out.push({ date: m[1], rating: +m[2] });
  return out;
}

/** Show name from a Show Score page <title> (NYC and London pages), parenthetical venue tag stripped; null when it does not parse. */
function pageName(html) {
  const m = /<title>\s*Show Score \| (.*?)\s*(?:NYC|London) Reviews/i.exec(html || '');
  return m ? m[1].replace(/\s*\([^)]*\)\s*$/, '') : null;
}

const addDays = (iso, d) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

/**
 * The latest date a rating may carry to count for this Broadway show: the day BEFORE the first preview
 * (spec), and never later than opening minus LAG_DAYS (the lag every input uses). A show with no
 * recorded first preview falls back to opening minus 21 days.
 */
function earlierCutoff(show) {
  const lag = addDays(show.openingDate, -LAG_DAYS);
  const pre = show.previewsStartDate ? addDays(show.previewsStartDate, -1) : addDays(show.openingDate, -21);
  return pre < lag ? pre : lag;
}

/** Summary of the ratings dated on or before cutoff (aggregates only). */
function summarize(reviews, cutoff) {
  const kept = reviews.filter((r) => r.date <= cutoff);
  if (!kept.length) return { n: 0 };
  const rt = kept.map((r) => r.rating);
  const dates = kept.map((r) => r.date).sort();
  const r1 = (x) => Math.round(x * 10) / 10;
  return { n: rt.length, mean: r1(RF.mean(rt)), shareLe60: r1(rt.filter((x) => x <= 60).length / rt.length), newest: dates[dates.length - 1], oldest: dates[0] };
}

/** Pool several per-source summaries (n-weighted mean). */
function pool(sources) {
  const live = sources.filter((s) => s && s.n > 0);
  if (!live.length) return null;
  const n = live.reduce((a, s) => a + s.n, 0);
  const mean = live.reduce((a, s) => a + s.n * s.mean, 0) / n;
  const shareLe60 = live.reduce((a, s) => a + s.n * (s.shareLe60 ?? 0), 0) / n;
  const newest = live.map((s) => s.newest).sort().pop();
  return { n, mean, shareLe60, newest };
}

function buildEarlierAudienceFeatures(target, ctx) {
  const x = {}; EA_FEATURE_NAMES.forEach((k) => { x[k] = 0; });
  const has = { earlierAudience: false };
  const prov = [];
  const a = ctx.earlierAudience && ctx.earlierAudience[target.id];
  if (a && a.n > 0) {
    x.eaScore = (a.n * a.mean + EA_K * EA_CENTER) / (a.n + EA_K) - EA_CENTER;
    x.eaHas = 1; has.earlierAudience = true;
    prov.push({ kind: 'earlier-audience', ref: target.id, date: a.newest });
  }
  return { x, provenance: prov, has };
}

/** Throws if an earlier-audience rating used by the target is dated after the show's cutoff (or undated). */
function assertNoLeakageEarlierAudience(target, provenance) {
  const cutoff = earlierCutoff(target);
  const bad = provenance.filter((p) => !p.date || toDay(p.date) == null || p.date > cutoff);
  if (bad.length) {
    const e = new Error(`LEAKAGE(earlier-audience) for ${target.id} (previews ${target.previewsStartDate || 'n/a'}, opening ${target.openingDate}): newest ${JSON.stringify(bad[0])} is after ${cutoff}`);
    e.bad = bad; throw e;
  }
  return true;
}

module.exports = { EA_CENTER, EA_K, EA_GROUPS, EA_FEATURE_NAMES, parseMembers, pageName, earlierCutoff, summarize, pool, buildEarlierAudienceFeatures, assertNoLeakageEarlierAudience };
