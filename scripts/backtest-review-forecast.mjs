#!/usr/bin/env node
/**
 * backtest-review-forecast.mjs (BRO-7314): how well can we forecast a show's
 * settled Critic Score before its reviews exist? Out-of-sample only.
 *
 * Target = getCriticScore(showId) (canonical, integer as displayed), never a raw
 * mean of reviews.json. Floor = FLOOR reviews so the target is stable (declared
 * before looking at results: a score on fewer than 10 reviews can move several
 * points on one review).
 *
 * Protocols (all out of sample):
 *   LOSO         leave one season out, weights fit on every other season
 *   WALK-FORWARD for season S, weights fit on seasons before S only
 *   FIXED SPLIT  train through the 2019-20 season, test 2021-22 onward
 * Interval widths come from nested leave-season-out residuals inside the
 * training data only. Inputs are leakage-checked row by row (assertNoLeakage)
 * and a perturbation self-check re-computes features after corrupting every
 * input dated on or after opening night.
 *
 * Usage:
 *   node scripts/backtest-review-forecast.mjs [--market=broadway|off-broadway|west-end] [--floor=10] [--out=path] [--forecast-out=/path/outside/repo.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCriticScore } from './lib/canonical-critic-scores.ts';

const require = createRequire(import.meta.url);
const RF = require('./lib/review-forecast.js');
const { getScoreTierId } = require('./lib/score-tiers.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const MARKET = arg('market', 'broadway');
if (!['broadway', 'off-broadway', 'west-end'].includes(MARKET)) { console.error(`unknown --market=${MARKET} (use broadway, off-broadway or west-end)`); process.exit(2); }
const FLOOR = +arg('floor', 10);
const SETTLE_DAYS = +arg('settle-days', 21); // a show must have opened this long before TODAY so its score has settled
// Forecasts for shows that have not opened are NEVER written next to the backtest: this repo is public,
// so a committed forecast would be a published claim. Pass --forecast-out=<path outside the repo>.
const FORECAST_OUT = arg('forecast-out', null);
const WANT_FORECAST = !!FORECAST_OUT;
const TODAY = arg('today', new Date().toISOString().slice(0, 10));
const OUT = arg('out', path.join(ROOT, 'data/audit', MARKET === 'broadway' ? 'review-forecast-backtest.json' : `review-forecast-backtest-${MARKET}.json`));
const MIN_PRIOR_SHOWS = 30; // a show is evaluated only once 30 earlier-season shows of its category exist

// True if the path is inside this worktree OR the main checkout (git common dir parent), resolving symlinks.
function insideAnyCheckout(p) {
  const real = (x) => { let d = path.resolve(x); const tail = []; while (!fs.existsSync(d)) { tail.unshift(path.basename(d)); d = path.dirname(d); } return path.join(fs.realpathSync(d), ...tail); };
  const roots = new Set([fs.realpathSync(ROOT)]);
  try { const c = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim(); roots.add(fs.realpathSync(path.dirname(path.resolve(ROOT, c)))); } catch { /* no git: ROOT only */ }
  const t = real(p);
  return [...roots].some((r) => t === r || t.startsWith(r + path.sep));
}
const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

// ---- pre-declared publish bar (written before any result was seen) ----------------
const BAR = {
  text: 'Publish-worthy only if, walk-forward, (1) model MAE is at least 15% lower than the category-mean baseline with a season-clustered 95% bootstrap interval that excludes zero, and (2) the stated 80% range holds between 72% and 88% of outcomes.',
  minRelativeMaeGain: 0.15, coverageLow: 0.72, coverageHigh: 0.88,
};

// ---- load -------------------------------------------------------------------------
const shows = J('data/shows.json').shows;
const grosses = J('data/grosses-history.json').weeks;
const origins = J('data/show-origins.json').shows;
const slimRc = (id) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/shows', `${id}.json`), 'utf8')).rc ?? 0; } catch { return 0; }
};
const weeks = {};
for (const [w, rows] of Object.entries(grosses)) weeks[w] = rows;

const PERSON_CATS = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);
const pool = [];
const byId = {};
for (const s of shows) {
  if (!s.openingDate || RF.toDay(s.openingDate) == null) continue;
  const score = getCriticScore(s.id);
  if (score == null) continue;
  const rc = slimRc(s.id);
  const rec = {
    id: s.id, title: s.title, openingDate: s.openingDate, score, rc, category: s.category,
    type: s.type, isRevival: !!s.isRevival, venue: s.venue || null, people: RF.peopleOf(s.creativeTeam),
    status: s.status,
  };
  byId[s.id] = rec;
  if (rc >= 3) pool.push(rec);
}
const ctx = { pool, weeks, origins };
const tier = (v, cat) => getScoreTierId(Math.round(v), cat === 'west-end' ? 'west-end' : 'broadway');

// ---- targets ------------------------------------------------------------------------
const targets = shows.filter((s) => byId[s.id] && s.category === MARKET && byId[s.id].rc >= FLOOR
  && (s.type === 'play' || s.type === 'musical') && !s.noReviewsExpected && !s.cancelledBeforeOpening
  && RF.toDay(s.openingDate) <= RF.toDay(TODAY) - SETTLE_DAYS)
  .map((s) => byId[s.id]);
console.error(`[${MARKET}] scored shows >= ${FLOOR} reviews: ${targets.length}`);

const rows = [];
let leakChecked = 0;
for (const t of targets) {
  const f = RF.buildFeatures(t, ctx, { floor: FLOOR });
  RF.assertNoLeakage(t, f.provenance); leakChecked++;
  if (f.mu == null || f.baselineN < MIN_PRIOR_SHOWS) continue;
  rows.push({ t, season: RF.seasonStartYear(t.openingDate), x: f.x, mu: f.mu, y: t.score, priorScore: f.priorScore, hasGross: f.hasGross, base: f.mu });
}
console.error(`evaluated rows (>= ${MIN_PRIOR_SHOWS} earlier-season shows): ${rows.length}; leakage-checked: ${leakChecked}`);

// Perturbation self-check: corrupt everything dated on/after opening, features must not move.
{
  const sample = rows.filter((_, i) => i % Math.max(1, Math.floor(rows.length / 40)) === 0).slice(0, 40);
  let moved = 0;
  for (const r of sample) {
    const D = RF.toDay(r.t.openingDate);
    const corruptPool = pool.map((s) => (RF.toDay(s.openingDate) > D - RF.LAG_DAYS ? { ...s, score: 100 - s.score } : s));
    const corruptWeeks = {};
    for (const [w, v] of Object.entries(weeks)) corruptWeeks[w] = RF.toDay(w) >= D ? Object.fromEntries(Object.entries(v).map(([k, q]) => [k, { ...q, capacity: 1, atp: 1 }])) : v;
    const f2 = RF.buildFeatures(r.t, { pool: corruptPool, weeks: corruptWeeks, origins }, { floor: FLOOR });
    if (JSON.stringify(f2.x) !== JSON.stringify(r.x) || f2.mu !== r.mu) moved++;
  }
  console.error(`perturbation self-check: ${sample.length} shows, ${moved} features moved`);
  if (moved) { console.error('FAIL: features depend on post-opening data'); process.exit(2); }
  var perturbation = { checked: sample.length, moved };
}

// ---- model helpers --------------------------------------------------------------------
const seasonsOf = (rs) => [...new Set(rs.map((r) => r.season))].sort((a, b) => a - b);
const toTrain = (rs) => rs.map((r) => ({ x: r.x, y: r.y - r.mu }));
const predictRow = (m, r) => Math.max(0, Math.min(100, r.mu + RF.predictRidge(m, r.x)));
function fitOn(rs, names) { return RF.fitRidge(toTrain(rs), names); }

/** Nested leave-one-season-out residuals inside `train` (model and baseline). */
function nestedResiduals(train, names) {
  const model = []; const base = [];
  for (const s of seasonsOf(train)) {
    const tr = train.filter((r) => r.season !== s); const te = train.filter((r) => r.season === s);
    if (tr.length < 60) continue;
    const m = fitOn(tr, names);
    for (const r of te) { model.push(r.y - predictRow(m, r)); base.push(r.y - r.mu); }
  }
  const srt = (a) => a.slice().sort((x, y) => x - y);
  return { model: srt(model), base: srt(base) };
}
const band = (resid, lo, hi) => [RF.quantile(resid, lo), RF.quantile(resid, hi)];

function evaluate(trainTestPairs, names) {
  const out = [];
  for (const { train, test } of trainTestPairs) {
    if (train.length < 150 || !test.length) continue;
    const m = fitOn(train, names);
    const nr = nestedResiduals(train, names);
    const [m10, m90] = band(nr.model, 0.1, 0.9); const [m25, m75] = band(nr.model, 0.25, 0.75);
    const [b10, b90] = band(nr.base, 0.1, 0.9);
    for (const r of test) {
      const p = predictRow(m, r);
      out.push({ id: r.t.id, title: r.t.title, date: r.t.openingDate, season: r.season, type: r.t.type, isRevival: r.t.isRevival,
        y: r.y, pred: p, base: r.mu, priorScore: r.priorScore, hasGross: r.hasGross, rc: r.t.rc,
        lo80: Math.max(0, p + m10), hi80: Math.min(100, p + m90), lo50: p + m25, hi50: p + m75,
        blo80: r.mu + b10, bhi80: r.mu + b90 });
    }
  }
  return out;
}

const loso = (names) => evaluate(seasonsOf(rows).map((s) => ({ train: rows.filter((r) => r.season !== s), test: rows.filter((r) => r.season === s) })), names);
const walk = (names) => evaluate(seasonsOf(rows).map((s) => ({ train: rows.filter((r) => r.season < s), test: rows.filter((r) => r.season === s) })), names);
const fixed = (names) => evaluate([{ train: rows.filter((r) => r.season <= 2019), test: rows.filter((r) => r.season >= 2021) }], names);

// ---- metrics ----------------------------------------------------------------------------
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mae = (a) => RF.mean(a);
function clusterBootstrapDiff(preds, f, g, B = 2000) {
  // 95% CI of mean(|f err|) - mean(|g err|), resampling whole seasons.
  const bySeason = {};
  preds.forEach((p) => { (bySeason[p.season] = bySeason[p.season] || []).push(Math.abs(f(p)) - Math.abs(g(p))); });
  const ks = Object.keys(bySeason); const R = rng(7314); const ds = [];
  for (let b = 0; b < B; b++) {
    let sum = 0; let n = 0;
    for (let i = 0; i < ks.length; i++) { const v = bySeason[ks[Math.floor(R() * ks.length)]]; sum += v.reduce((s, x) => s + x, 0); n += v.length; }
    ds.push(sum / n);
  }
  ds.sort((a, b) => a - b);
  return [RF.quantile(ds, 0.025), RF.quantile(ds, 0.975)];
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

function summarize(preds) {
  if (!preds.length) return { n: 0 };
  const m = preds.map((p) => Math.abs(p.y - p.pred));
  const b = preds.map((p) => Math.abs(p.y - p.base));
  const cat = MARKET;
  const hyb = (p) => (p.priorScore != null ? p.priorScore : p.base);
  const hit = (k) => RF.mean(preds.map((p) => (tier(p[k], cat) === tier(p.y, cat) ? 1 : 0)));
  const withPrior = preds.filter((p) => p.priorScore != null);
  const bPrior = withPrior.map((p) => Math.abs(p.y - p.priorScore));
  const mPrior = withPrior.map((p) => Math.abs(p.y - p.pred));
  const bBase = withPrior.map((p) => Math.abs(p.y - p.base));
  const ci = clusterBootstrapDiff(preds, (p) => p.y - p.pred, (p) => p.y - p.base);
  const ciH = clusterBootstrapDiff(preds, (p) => p.y - p.pred, (p) => p.y - hyb(p));
  const cov = (lo, hi) => RF.mean(preds.map((p) => (p.y >= p[lo] && p.y <= p[hi] ? 1 : 0)));
  const sd = (a) => Math.sqrt(RF.mean(a.map((x) => (x - RF.mean(a)) ** 2)));
  return {
    n: preds.length, seasons: seasonsOf(preds.map((p) => ({ season: p.season }))).length,
    maeModel: r1(mae(m)), maeCategoryMean: r1(mae(b)),
    maeGainPct: r1(100 * (1 - mae(m) / mae(b))), maeDiffCI95: [r3(ci[0]), r3(ci[1])].map((x) => r1(x)),
    maeDiffVsPriorElseMeanCI95: ciH.map((x) => r1(x)),
    rmseModel: r1(Math.sqrt(RF.mean(preds.map((p) => (p.y - p.pred) ** 2)))), rmseCategoryMean: r1(Math.sqrt(RF.mean(preds.map((p) => (p.y - p.base) ** 2)))),
    scoreSd: r1(sd(preds.map((p) => p.y))),
    maePriorElseMean: r1(mae(preds.map((p) => Math.abs(p.y - hyb(p))))),
    bandHitModel: r3(hit('pred')), bandHitCategoryMean: r3(hit('base')),
    bandHitPriorElseMean: r3(RF.mean(preds.map((p) => (tier(hyb(p), cat) === tier(p.y, cat) ? 1 : 0)))),
    coverage80: r3(cov('lo80', 'hi80')), coverage50: r3(cov('lo50', 'hi50')),
    avgWidth80: r1(RF.mean(preds.map((p) => p.hi80 - p.lo80))),
    baselineIntervalCoverage80: r3(cov('blo80', 'bhi80')), baselineIntervalWidth80: r1(RF.mean(preds.map((p) => p.bhi80 - p.blo80))),
    priorRunSubset: withPrior.length ? {
      n: withPrior.length, maePriorRunAlone: r1(mae(bPrior)), maeModel: r1(mae(mPrior)), maeCategoryMean: r1(mae(bBase)),
    } : null,
  };
}

function failures(preds) {
  const groups = {};
  const add = (k, p) => { (groups[k] = groups[k] || []).push(p); };
  for (const p of preds) {
    add(`${p.type}${p.isRevival ? ' revival' : ' new'}`, p);
    add(`actual tier: ${tier(p.y, MARKET)}`, p);
    add(p.priorScore != null ? 'has earlier production' : 'no earlier production', p);
    add(p.hasGross ? 'has preview grosses' : 'no preview grosses', p);
    add(p.rc >= 25 ? '25+ reviews' : '10-24 reviews', p);
  }
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, {
    n: v.length, mae: r1(mae(v.map((p) => Math.abs(p.y - p.pred)))), maeCategoryMean: r1(mae(v.map((p) => Math.abs(p.y - p.base)))),
    meanSigned: r1(RF.mean(v.map((p) => p.pred - p.y))), // positive = we guessed too high
  }]));
}

const ABLATIONS = {
  all: RF.FEATURE_NAMES,
  'people only': ['dir', 'chor', 'writer'],
  'prior run only': ['priorRun'],
  'preview grosses only': ['grossCap', 'grossAtp'],
  'route and source only': ['srcFilm', 'srcTv', 'srcBook', 'srcMusic', 'srcPlay', 'pathLondon', 'pathOffB', 'pathRegional'],
  'everything but grosses': RF.FEATURE_NAMES.filter((f) => !f.startsWith('gross')),
};

const result = {
  generatedAt: new Date().toISOString(), card: 'BRO-7314', market: MARKET, floor: FLOOR, settleDays: SETTLE_DAYS, today: TODAY,
  target: 'getCriticScore(showId) from scripts/lib/canonical-critic-scores.ts (integer, as displayed)',
  preDeclaredBar: BAR,
  caveats: [
    'Population: targets need a settled review count at or above the floor, measured today. That is not knowable before opening, so results describe well-reviewed shows only.',
    'Earlier shows enter the model with today\'s settled score and review count, dated by opening day. A show that opened a few days before the target may carry reviews published after the target opened. Thin on Broadway, larger on Off-Broadway and West End.',
    'Creative team, venue and show-origins are current snapshots, not as-of-opening records.',
    'Leave-one-season-out trains on later seasons and so is optimistic. Walk-forward and the fixed split are the forward-in-time numbers. Ablations use leave-one-season-out only.',
    'Floors 5, 10 and 15 were all run. Every run misses the pre-declared bar, so this does not inflate the verdict.'
  ],
  population: { scoredShowsAtFloor: targets.length, evaluated: rows.length, minEarlierSeasonShows: MIN_PRIOR_SHOWS,
    firstSeason: seasonsOf(rows)[0], lastSeason: seasonsOf(rows).slice(-1)[0], withEarlierProduction: rows.filter((r) => r.priorScore != null).length,
    withPreviewGrosses: rows.filter((r) => r.hasGross).length },
  leakage: { rowsChecked: leakChecked, lagDays: RF.LAG_DAYS, perturbation },
  notUsed: ['audience grades (no dated history; data/audience-snapshots begins 2026-04 and live scores postdate openings)',
    'cast (shows.json cast is a later snapshot incl. replacements)', 'producers (not in the data)'],
};
const L = loso(RF.FEATURE_NAMES); const W = walk(RF.FEATURE_NAMES); const F = fixed(RF.FEATURE_NAMES);
result.loso = summarize(L); result.walkForward = summarize(W); result.fixedSplit = summarize(F);
result.fixedSplit.window = 'train through 2019-20, test 2021-22 onward';
result.ablationsLoso = Object.fromEntries(Object.entries(ABLATIONS).map(([k, v]) => { const s = summarize(loso(v)); return [k, { n: s.n, maeModel: s.maeModel, maeCategoryMean: s.maeCategoryMean, bandHitModel: s.bandHitModel }]; }));
result.failuresWalkForward = failures(W);
result.failuresLoso = failures(L);
const fullModel = rows.length >= 150 ? fitOn(rows, RF.FEATURE_NAMES) : null;
if (fullModel) result.fullModelWeights = Object.fromEntries(fullModel.names.map((n, j) => [n, r3(fullModel.beta[j] / fullModel.sd[j])]));
const wf = W.length ? W : L;
const pick = (p) => ({ id: p.id, title: p.title, opened: p.date, type: `${p.type}${p.isRevival ? ' revival' : ''}`, forecast: Math.round(p.pred),
  range80: [Math.round(p.lo80), Math.round(p.hi80)], categoryMean: Math.round(p.base), earlierProduction: p.priorScore, actual: p.y, error: Math.round(p.pred - p.y) });
const recent = wf.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);
const misses = wf.slice().sort((a, b) => Math.abs(b.y - b.pred) - Math.abs(a.y - a.pred)).filter((p) => !recent.includes(p)).slice(0, 4);
result.examples = { rule: '5 most recent evaluated openings (walk-forward forecasts) plus the 4 largest misses overall; no other selection', recent: recent.map(pick), largestMisses: misses.map(pick) };
result.predictionsWalkForward = W.map((p) => ({ id: p.id, opened: p.date, forecast: r1(p.pred), lo80: r1(p.lo80), hi80: r1(p.hi80), categoryMean: r1(p.base), actual: p.y }));

const gain = result.walkForward.maeGainPct; const ci = result.walkForward.maeDiffCI95;
result.verdictFlags = {
  walkForwardMaeGainPct: gain, maeDiffCI95: ci,
  beatsBaselineByBar: gain != null && gain / 100 >= BAR.minRelativeMaeGain && ci && ci[1] < 0,
  coverage80InBand: result.walkForward.coverage80 != null && result.walkForward.coverage80 >= BAR.coverageLow && result.walkForward.coverage80 <= BAR.coverageHigh,
};
result.verdictFlags.meetsPublishBar = !!(result.verdictFlags.beatsBaselineByBar && result.verdictFlags.coverage80InBand);

// ---- forecasts for shows that have not opened yet --------------------------------------
if (WANT_FORECAST && !fullModel) { console.error('refusing: --forecast-out given but too few evaluated rows (<150) to fit a model for this market'); process.exit(4); }
if (WANT_FORECAST && fullModel) {
  const nested = nestedResiduals(rows, RF.FEATURE_NAMES);
  const [q10, q90] = band(nested.model, 0.1, 0.9);
  const up = shows.filter((s) => s.category === MARKET && s.openingDate && s.openingDate > TODAY && (s.type === 'play' || s.type === 'musical')
    && !s.cancelledBeforeOpening && !['closed'].includes(s.status));
  result.upcoming = up.map((s) => {
    const t = { id: s.id, title: s.title, openingDate: s.openingDate, category: s.category, type: s.type, isRevival: !!s.isRevival, venue: s.venue || null, people: RF.peopleOf(s.creativeTeam) };
    const f = RF.buildFeatures(t, ctx, { floor: FLOOR });
    RF.assertNoLeakage(t, f.provenance);
    if (f.mu == null) return null;
    const p = Math.max(0, Math.min(100, f.mu + RF.predictRidge(fullModel, f.x)));
    return { id: s.id, title: s.title, opens: s.openingDate, type: `${s.type}${s.isRevival ? ' revival' : ''}`, venue: s.venue,
      forecast: Math.round(p), range80: [Math.round(Math.max(0, p + q10)), Math.round(Math.min(100, p + q90))], categoryMean: Math.round(f.mu),
      earlierProduction: f.priorScore, hasPreviewGrosses: f.hasGross, peopleWithHistory: ['dir', 'chor', 'writer'].filter((k) => f.x[k] !== 0),
      status: 'UNPUBLISHED internal forecast', madeOn: TODAY };
  }).filter(Boolean).sort((a, b) => (a.opens < b.opens ? -1 : 1));
}

if (result.upcoming) {
  if (insideAnyCheckout(FORECAST_OUT)) { console.error('refusing: --forecast-out must be outside every checkout of this repo (public)'); process.exit(3); }
  fs.writeFileSync(FORECAST_OUT, JSON.stringify({ madeOn: TODAY, market: MARKET, status: 'UNPUBLISHED internal forecast', upcoming: result.upcoming }, null, 2));
  delete result.upcoming;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.error(`wrote ${path.relative(ROOT, OUT)}`);
const brief = (k, s) => `${k.padEnd(13)} n=${s.n} MAE model ${s.maeModel} vs category mean ${s.maeCategoryMean} (gain ${s.maeGainPct}%, CI ${JSON.stringify(s.maeDiffCI95)}) band ${s.bandHitModel} vs ${s.bandHitCategoryMean} cov80 ${s.coverage80}`;
console.log(brief('LOSO', result.loso)); console.log(brief('WALK-FORWARD', result.walkForward)); console.log(brief('FIXED SPLIT', result.fixedSplit));
console.log('prior-run subset (walk-forward):', JSON.stringify(result.walkForward.priorRunSubset));
console.log('verdictFlags:', JSON.stringify(result.verdictFlags));
