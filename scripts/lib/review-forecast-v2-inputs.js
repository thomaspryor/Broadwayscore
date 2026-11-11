/**
 * review-forecast-v2-inputs.js (BRO-7347): extra pre-opening inputs for the review-score
 * forecast RESEARCH backtest. Pure: no fs, no network, no clock. The live forecast
 * (scripts/lib/review-forecast.js) is not touched and does not import this file.
 *
 * Same rule as v1: every input is dated strictly before opening night, and every dated
 * source is recorded in `provenance` so assertNoLeakageV2() can refuse it.
 *
 *   cast      opening-night cast (IBDB, stored in data/cast/<show>.json `openingNightCast`) joined to
 *             each person's EARLIER opening-night credits (shows that opened >= LAG_DAYS earlier).
 *             Features: shrunk score record, Broadway experience, debut share, company size.
 *   preview   previews length (previewsStartDate to opening) and week-over-week trend of capacity,
 *             average ticket price and gross across the preview weeks that END before opening night.
 *   audience  Show Score aggregate score and review count read off a Wayback capture dated before
 *             opening night (scripts/review-forecast-v2-wayback-sweep.js). Sparse: most shows have none.
 */
'use strict';

const RF = require('./review-forecast.js');

const { LAG_DAYS, toDay, normName } = RF;
const CAST_SHRINK_K = 3;
const LEAD_N = 5; // billing order is the stored order; the first five are "the leads"
const PREVIEW_WEEKS_TREND = 4;
const PREVIEW_LEN_CENTER = 30; // days; typical Broadway previews, declared in advance
const AUD_SCORE_CENTER = 85; // Show Score level of a typical show, declared in advance
const AUD_COUNT_CENTER = Math.log(60);

const V2_GROUPS = {
  cast: ['castDevLead', 'castDevAll', 'castExpLead', 'castExpAll', 'castDebutFrac', 'castSize'],
  preview: ['prevLen', 'prevWeeks', 'capSlope', 'atpSlope', 'grossRel', 'grossSlope'],
  audience: ['audScore', 'audCount'],
};
const V2_FEATURE_NAMES = Object.values(V2_GROUPS).flat();

const personKey = (p) => (p.ibdbPersonId ? `i${p.ibdbPersonId}` : `n${normName(p.name)}`);

/**
 * castFiles: [{showId, openingNightCast:[{name, ibdbPersonId?, flags?}]}]
 * -> { castByShow: Map(showId -> [{key, debut}]), credits: Map(personKey -> [{showId, openingDate}]) }
 * showDates: { showId: openingDate }
 */
function buildCastIndex(castFiles, showDates) {
  const castByShow = new Map();
  const credits = new Map();
  for (const f of castFiles) {
    const od = showDates[f.showId];
    if (!od || !Array.isArray(f.openingNightCast) || !f.openingNightCast.length) continue;
    const seen = new Set();
    const list = [];
    for (const p of f.openingNightCast) {
      if (!p || !p.name) continue;
      const key = personKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ key, debut: Array.isArray(p.flags) && p.flags.includes('Broadway debut') });
      if (!credits.has(key)) credits.set(key, []);
      credits.get(key).push({ showId: f.showId, openingDate: od });
    }
    castByShow.set(f.showId, list);
  }
  return { castByShow, credits };
}

/** slope of values over their index, per step (0 for fewer than 2 points). */
function slope(v) {
  const n = v.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2; const my = RF.mean(v);
  let num = 0; let den = 0;
  v.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return den ? num / den : 0;
}

/**
 * ctx = { pool, poolById, castIndex, weeks, audience }
 *   audience: { [showId]: { timestamp:'YYYYMMDDhhmmss', score, reviewCount } }
 * Returns { x, provenance, has:{cast, preview, audience} }.
 */
function buildV2Features(target, ctx, opts = {}) {
  const floor = opts.floor ?? 10;
  const D = toDay(target.openingDate);
  if (D == null) throw new Error(`bad openingDate for ${target.id}`);
  const cutoff = D - LAG_DAYS;
  const prov = [];
  const note = (kind, ref, date) => prov.push({ kind, ref, date });
  const x = {};
  V2_FEATURE_NAMES.forEach((k) => { x[k] = 0; });
  const has = { cast: false, preview: false, audience: false };

  // ---- cast ----
  const cast = ctx.castIndex && ctx.castIndex.castByShow.get(target.id);
  if (cast && cast.length) {
    const catMeanCache = {};
    const catMean = (cat) => {
      if (catMeanCache[cat] === undefined) {
        const v = ctx.pool.filter((s) => s.category === cat && s.rc >= floor && toDay(s.openingDate) != null && toDay(s.openingDate) <= cutoff).map((s) => s.score);
        catMeanCache[cat] = v.length ? RF.mean(v) : null;
      }
      return catMeanCache[cat];
    };
    const perPerson = cast.map((c) => {
      let sum = 0; let n = 0; let credits = 0;
      for (const cr of ctx.castIndex.credits.get(c.key) || []) {
        if (cr.showId === target.id) continue;
        const d = toDay(cr.openingDate);
        if (d == null || d > cutoff) continue;
        credits += 1; note('cast-credit', cr.showId, cr.openingDate);
        const s = ctx.poolById[cr.showId];
        if (!s || s.rc < floor) continue;
        const cm = catMean(s.category);
        if (cm == null) continue;
        sum += s.score - cm; n += 1;
      }
      return { dev: n ? sum / (n + CAST_SHRINK_K) : null, credits, debut: c.debut };
    });
    const devs = (arr) => { const v = arr.filter((p) => p.dev != null).map((p) => p.dev); return v.length ? RF.mean(v) : 0; };
    const exp = (arr) => RF.mean(arr.map((p) => Math.log1p(p.credits)));
    const lead = perPerson.slice(0, LEAD_N);
    x.castDevLead = devs(lead); x.castDevAll = devs(perPerson);
    x.castExpLead = exp(lead); x.castExpAll = exp(perPerson);
    x.castDebutFrac = RF.mean(perPerson.map((p) => (p.debut ? 1 : 0)));
    x.castSize = Math.log(perPerson.length);
    has.cast = true;
    note('opening-cast', target.id, null); // the opening-night cast itself: announced before opening, dated by definition "as of opening night"
  }

  // ---- preview signals (Broadway grosses exist for Broadway proper only, as in v1) ----
  if (target.previewsStartDate && toDay(target.previewsStartDate) != null && toDay(target.previewsStartDate) < D) {
    x.prevLen = Math.max(0, Math.min(90, D - toDay(target.previewsStartDate))) - PREVIEW_LEN_CENTER;
    note('previews-start', target.id, target.previewsStartDate);
    has.preview = true;
  }
  if (ctx.weeks && target.category === 'broadway') {
    const wk = Object.keys(ctx.weeks).filter((w) => toDay(w) < D && ctx.weeks[w][target.id]).sort().slice(-PREVIEW_WEEKS_TREND);
    const caps = []; const atps = []; const gross = [];
    for (const w of wk) {
      const all = Object.values(ctx.weeks[w]).filter((r) => r && r.capacity > 0 && r.atp > 0 && r.gross > 0);
      if (all.length < 5) continue;
      const r = ctx.weeks[w][target.id];
      if (!(r.capacity > 0 && r.atp > 0 && r.gross > 0)) continue;
      const med = (f) => { const v = all.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
      caps.push(r.capacity - med((q) => q.capacity));
      atps.push(Math.log(r.atp / med((q) => q.atp)));
      gross.push(Math.log(r.gross / med((q) => q.gross)));
      note('gross-week', `${target.id}@${w}`, w);
    }
    if (caps.length) {
      x.prevWeeks = caps.length;
      x.capSlope = slope(caps); x.atpSlope = slope(atps); x.grossSlope = slope(gross);
      x.grossRel = RF.mean(gross.slice(-2));
      has.preview = true;
    }
  }

  // ---- audience capture (dated before opening) ----
  const a = ctx.audience && ctx.audience[target.id];
  if (a && a.timestamp && a.score != null && a.reviewCount != null) {
    const d = `${a.timestamp.slice(0, 4)}-${a.timestamp.slice(4, 6)}-${a.timestamp.slice(6, 8)}`;
    x.audScore = a.score - AUD_SCORE_CENTER;
    x.audCount = Math.log(a.reviewCount + 1) - AUD_COUNT_CENTER;
    note('audience-capture', target.id, d);
    has.audience = true;
  }
  return { x, provenance: prov, has };
}

/** Throws if any v2 input is not dated strictly before opening night (cast credits keep the v1 lag). */
function assertNoLeakageV2(target, provenance) {
  const D = toDay(target.openingDate);
  const bad = [];
  for (const p of provenance) {
    if (p.kind === 'opening-cast') continue; // the opening-night cast: not a date, but the roster that opened the show
    const d = toDay(p.date);
    if (d == null) { bad.push({ ...p, why: 'undated input' }); continue; }
    if (p.kind === 'cast-credit') {
      if (p.ref === target.id) bad.push({ ...p, why: 'uses the show itself' });
      else if (!(d <= D - LAG_DAYS)) bad.push({ ...p, why: `credit opened ${(D - d).toFixed(0)}d before target (< ${LAG_DAYS}d lag)` });
      continue;
    }
    // previews-start, gross-week, audience-capture: about the target itself, so the date must be BEFORE opening night
    if (!(d < D)) bad.push({ ...p, why: `${p.kind} not before opening` });
  }
  if (bad.length) {
    const e = new Error(`LEAKAGE(v2) for ${target.id} (${target.openingDate}): ${bad.length} input(s) not dated before opening, first: ${JSON.stringify(bad[0])}`);
    e.bad = bad;
    throw e;
  }
  return true;
}

module.exports = { V2_GROUPS, V2_FEATURE_NAMES, LEAD_N, buildCastIndex, buildV2Features, assertNoLeakageV2, slope, personKey };
