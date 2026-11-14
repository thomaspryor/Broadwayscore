/**
 * review-forecast.js (BRO-7314): pure helpers for forecasting a show's settled
 * Critic Score BEFORE its reviews exist. No fs, no network, no clock.
 *
 * THE RULE THAT MATTERS: every input to a forecast must be dated before the
 * show's opening night. buildFeatures() records the date of every source it
 * reads (`provenance`) and assertNoLeakage() throws if any source is not
 * strictly earlier than the cutoff. tests/unit/review-forecast-leakage.test.mjs
 * pins this, including an invariance check: changing every input dated on or
 * after the cutoff must not change a single feature value.
 *
 * Inputs (all "as of" the cutoff):
 *   - baseline: mean score of earlier-SEASON shows of the same type (play or
 *     musical) and newness (new or revival) in the same market
 *   - director / choreographer / writer track record: that person's earlier
 *     shows (any market with a published score), shrunk toward the market mean
 *   - prior run: the latest earlier production of the same title
 *   - same-theater track record
 *   - preview-period grosses (weeks that END before opening night): capacity and
 *     average ticket price relative to that week's median show
 *   - route and source material (film, tv, book, play, music catalog; London,
 *     Off-Broadway or regional run first). Static descriptors, not dated.
 * Deliberately NOT used: audience grades (no dated history, see backtest
 * notes), cast lists (the stored cast is a later snapshot, replacements
 * included), producers (not in the data).
 */

'use strict';

// venue-write-guard-ok: x.venue is a numeric model feature (shrunk venue track record), not a show venue write
const LAG_DAYS = 3; // an earlier show only counts once it opened at least this long before
const PERSON_SHRINK_K = 3; // pseudo-shows of "average" added to every person's record
const VENUE_SHRINK_K = 5;
const PREVIEW_WEEKS_USED = 2;
const MIN_GROUP_N = 8; // min earlier-season shows before a type x newness mean is trusted
const RIDGE_LAMBDA = 20; // fixed in advance, on standardized features. Not tuned.

const FEATURE_NAMES = [
  'dir', 'chor', 'writer', 'priorRun', 'venue',
  'grossCap', 'grossAtp',
  'srcFilm', 'srcTv', 'srcBook', 'srcMusic', 'srcPlay',
  'pathLondon', 'pathOffB', 'pathRegional',
];

function toDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
}

/** Season start year: a Broadway season runs June to May. */
function seasonStartYear(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  return +m[2] >= 6 ? +m[1] : +m[1] - 1;
}

function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleKey(t) {
  return String(t || '').toLowerCase().replace(/&/g, 'and')
    .replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const EXCLUDE_ROLE = /direction|supervis|orchestrat|arrang|design|coordinator|associate|assistant|casting|stage manag|production manag/i;
function roleGroup(role) {
  const r = String(role || '');
  if (/^(co-)?directors?$/i.test(r.trim())) return 'dir';
  if (/choreograph/i.test(r)) return 'chor';
  if (EXCLUDE_ROLE.test(r)) return null;
  if (/playwright|\bbook\b|\bmusic\b|lyric|writer|adaptation/i.test(r)) return 'writer';
  return null;
}

/** [{name, role}] -> {dir:Set, chor:Set, writer:Set, all:Set} of normalized names. */
function peopleOf(creativeTeam) {
  const g = { dir: new Set(), chor: new Set(), writer: new Set(), all: new Set() };
  for (const c of creativeTeam || []) {
    const grp = roleGroup(c.role);
    const n = normName(c.name);
    if (!grp || !n) continue;
    g[grp].add(n);
    g.all.add(n);
  }
  return g;
}

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

/**
 * ctx = {
 *   pool:   [{id,title,openingDate,score,rc,category,type,isRevival,venue,people}]  every show with a published score
 *   weeks:  { 'YYYY-MM-DD': { [showId]: {capacity, atp} } }   week-ENDING dates
 *   origins:{ [showId]: {path:[], source} }
 * }
 * target = {id,title,openingDate,category,type,isRevival,venue,people}
 * opts.floor = min review count for a show to count in baselines.
 * Returns { x, mu, baselineN, provenance }.
 */
function buildFeatures(target, ctx, opts = {}) {
  const floor = opts.floor ?? 10;
  const D = toDay(target.openingDate);
  if (D == null) throw new Error(`bad openingDate for ${target.id}`);
  const cutoff = D - LAG_DAYS;
  const tSeason = seasonStartYear(target.openingDate);
  const prov = []; // {kind, ref, date}
  const note = (kind, ref, date) => prov.push({ kind, ref, date });

  // Earlier shows only. Strictly: opened at least LAG_DAYS before, never the target itself.
  const past = ctx.pool.filter((s) => s.id !== target.id && toDay(s.openingDate) != null && toDay(s.openingDate) <= cutoff);

  // Baseline: earlier SEASONS, same category, same type x newness (fallbacks widen).
  const earlierSeason = past.filter((s) => s.category === target.category && s.rc >= floor
    && (s.type === 'play' || s.type === 'musical') && seasonStartYear(s.openingDate) < tSeason);
  let grp = earlierSeason.filter((s) => s.type === target.type && !!s.isRevival === !!target.isRevival);
  if (grp.length < MIN_GROUP_N) grp = earlierSeason.filter((s) => s.type === target.type);
  if (grp.length < MIN_GROUP_N) grp = earlierSeason;
  const mu = grp.length ? mean(grp.map((s) => s.score)) : null;
  grp.forEach((s) => note('baseline', s.id, s.openingDate));
  const baselineN = earlierSeason.length;

  // Market means (as of cutoff) so a person's past scores are compared with their own market.
  const catMeanCache = {};
  const catMean = (cat) => {
    if (catMeanCache[cat] === undefined) {
      const v = past.filter((s) => s.category === cat && s.rc >= floor).map((s) => s.score);
      catMeanCache[cat] = v.length ? mean(v) : null;
    }
    return catMeanCache[cat];
  };

  const personFeature = (names) => {
    const devs = [];
    for (const nm of names) {
      let sum = 0; let n = 0;
      for (const s of past) {
        if (!s.people || !s.people.all.has(nm)) continue;
        const cm = catMean(s.category);
        if (cm == null) continue;
        sum += s.score - cm; n += 1;
        note('person', s.id, s.openingDate);
      }
      if (n > 0) devs.push(sum / (n + PERSON_SHRINK_K));
    }
    return devs.length ? mean(devs) : 0;
  };
  const tp = target.people || peopleOf([]);
  const x = {};
  x.dir = personFeature(tp.dir);
  x.chor = personFeature(tp.chor);
  x.writer = personFeature(tp.writer);

  // Prior run: latest earlier production of the same title.
  const tk = titleKey(target.title);
  const prior = past.filter((s) => titleKey(s.title) === tk && toDay(s.openingDate) < D)
    .sort((a, b) => (a.openingDate < b.openingDate ? 1 : -1))[0];
  let priorScore = null;
  if (prior && mu != null) {
    x.priorRun = prior.score - mu;
    priorScore = prior.score;
    note('prior-run', prior.id, prior.openingDate);
  } else x.priorRun = 0;

  // Same theater, same category.
  if (target.venue) {
    let sum = 0; let n = 0;
    for (const s of past) {
      if (s.category !== target.category || s.venue !== target.venue || s.rc < floor) continue;
      const cm = catMean(s.category);
      if (cm == null) continue;
      sum += s.score - cm; n += 1; note('venue', s.id, s.openingDate);
    }
    x.venue = n ? sum / (n + VENUE_SHRINK_K) : 0;
  } else x.venue = 0;

  // Preview grosses: weeks ending strictly before opening night.
  x.grossCap = 0; x.grossAtp = 0;
  let hasGross = false;
  // Intentionally NOT isBroadwayCategory: the backtest keys everything on the explicit category string; grosses exist for Broadway proper only, and a null category must not borrow them.
  if (ctx.weeks && target.category === 'broadway') {
    const wk = Object.keys(ctx.weeks).filter((w) => toDay(w) < D && ctx.weeks[w][target.id]).sort().slice(-PREVIEW_WEEKS_USED);
    const caps = []; const atps = [];
    for (const w of wk) {
      const all = Object.values(ctx.weeks[w]).filter((r) => r && r.capacity > 0 && r.atp > 0);
      if (all.length < 5) continue;
      const med = (f) => { const v = all.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
      const r = ctx.weeks[w][target.id];
      if (!(r.capacity > 0 && r.atp > 0)) continue;
      caps.push(r.capacity - med((q) => q.capacity));
      atps.push(Math.log(r.atp / med((q) => q.atp)));
      note('gross-week', `${target.id}@${w}`, w);
    }
    if (caps.length) { x.grossCap = mean(caps); x.grossAtp = mean(atps); hasGross = true; }
  }

  // Route and source material: static descriptors from show-origins (not dated).
  const o = ctx.origins && ctx.origins[target.id];
  const src = o ? o.source : null;
  const path = o && Array.isArray(o.path) ? o.path : [];
  x.srcFilm = src === 'film' ? 1 : 0;
  x.srcTv = src === 'tv' ? 1 : 0;
  x.srcBook = src === 'book' ? 1 : 0;
  x.srcMusic = src === 'music-catalog' ? 1 : 0;
  x.srcPlay = src === 'play' ? 1 : 0;
  x.pathLondon = path.includes('london') ? 1 : 0;
  x.pathOffB = path.includes('off-broadway') ? 1 : 0;
  x.pathRegional = path.includes('regional-us') ? 1 : 0;
  if (o) note('static-origin', target.id, null);

  return { x, mu, baselineN, priorScore, hasGross, provenance: prov };
}

/** Throws if any dated input is not strictly earlier than the opening night (with lag). */
function assertNoLeakage(target, provenance) {
  const D = toDay(target.openingDate);
  const bad = [];
  for (const p of provenance) {
    if (p.kind === 'static-origin') continue;
    const d = toDay(p.date);
    if (d == null) { bad.push({ ...p, why: 'undated input' }); continue; }
    if (p.kind === 'gross-week') { if (!(d < D)) bad.push({ ...p, why: 'gross week not before opening' }); continue; }
    if (p.ref === target.id) { bad.push({ ...p, why: 'uses the show itself' }); continue; }
    if (!(d <= D - LAG_DAYS)) bad.push({ ...p, why: `opened ${(D - d).toFixed(0)}d before target (< ${LAG_DAYS}d lag)` });
  }
  if (bad.length) {
    const e = new Error(`LEAKAGE for ${target.id} (${target.openingDate}): ${bad.length} input(s) not dated before opening, first: ${JSON.stringify(bad[0])}`);
    e.bad = bad;
    throw e;
  }
  return true;
}

// ---- ridge regression, tiny and dependency-free --------------------------------

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r) => r[n]);
}

/** rows: [{x:{name:val}, y}] where y is already (score - baseline). */
function fitRidge(rows, names = FEATURE_NAMES, lambda = RIDGE_LAMBDA) {
  const n = rows.length;
  const mu = names.map((f) => mean(rows.map((r) => r.x[f] || 0)));
  const sd = names.map((f, j) => {
    const v = Math.sqrt(mean(rows.map((r) => ((r.x[f] || 0) - mu[j]) ** 2)));
    return v > 1e-9 ? v : 1;
  });
  const Z = rows.map((r) => names.map((f, j) => ((r.x[f] || 0) - mu[j]) / sd[j]));
  const ybar = mean(rows.map((r) => r.y));
  const p = names.length;
  const A = Array.from({ length: p }, () => Array(p).fill(0));
  const b = Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += Z[i][j] * (rows[i].y - ybar);
      for (let k = 0; k < p; k++) A[j][k] += Z[i][j] * Z[i][k];
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += lambda;
  const beta = solve(A, b);
  return { names, mu, sd, beta, ybar };
}

function predictRidge(model, x) {
  let s = model.ybar;
  model.names.forEach((f, j) => { s += model.beta[j] * (((x[f] || 0) - model.mu[j]) / model.sd[j]); });
  return s;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

module.exports = {
  LAG_DAYS, RIDGE_LAMBDA, FEATURE_NAMES, MIN_GROUP_N,
  toDay, seasonStartYear, normName, titleKey, roleGroup, peopleOf,
  buildFeatures, assertNoLeakage, fitRidge, predictRidge, quantile, mean,
};
