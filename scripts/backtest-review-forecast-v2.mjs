#!/usr/bin/env node
/**
 * backtest-review-forecast-v2.mjs (BRO-7347): does any untested pre-opening input lower the
 * walk-forward miss of the review-score forecast? Same harness rules as backtest-review-forecast.mjs
 * (BRO-7314): target = getCriticScore, floor 10 reviews, walk-forward by season, ridge lambda fixed,
 * season-clustered bootstrap (seed 7314, B=2000), every input dated before opening and checked by
 * assertNoLeakageV2 plus a perturbation self-check. The live formula (review-forecast.js) is untouched.
 *
 * Each candidate model is v1 features plus ONE input group. The question per input is the paired
 * difference in absolute error, with and without it, on the same shows. Primary groups were declared
 * before results were seen (cast, preview, audience); the per-feature rows are exploratory.
 *
 * Usage: node scripts/backtest-review-forecast-v2.mjs [--audience=path] [--out=path]
 */
// venue-write-guard-ok: read-only backtest, never writes shows.json
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getCriticScore } from './lib/canonical-critic-scores.ts';

const require = createRequire(import.meta.url);
const RF = require('./lib/review-forecast.js');
const V2 = require('./lib/review-forecast-v2-inputs.js');
const EX = require('./lib/review-forecast-v2-extra.js');
const ER = require('./lib/review-forecast-v2-earlier-run.js');
const OT = require('./lib/outlet-tiers.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const FLOOR = 10; const SETTLE_DAYS = 21; const MIN_PRIOR_SHOWS = 30; const MARKET = 'broadway';
const TODAY = arg('today', new Date().toISOString().slice(0, 10));
const OUT = arg('out', path.join(ROOT, 'data/audit/review-forecast-inputs-v2.json'));
const AUD_FILE = arg('audience', path.join(ROOT, 'data/audit/review-forecast-v2-wayback-audience.json'));
const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

const shows = J('data/shows.json').shows;
const weeks = J('data/grosses-history.json').weeks;
const origins = J('data/show-origins.json').shows;
const slimRc = (id) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/shows', `${id}.json`), 'utf8')).rc ?? 0; } catch { return 0; } };

const pool = []; const poolById = {}; const showDates = {}; const prevStart = {};
for (const s of shows) {
  if (!s.openingDate || RF.toDay(s.openingDate) == null) continue;
  showDates[s.id] = s.openingDate;
  const score = getCriticScore(s.id);
  if (score == null) continue;
  const rec = { id: s.id, title: s.title, openingDate: s.openingDate, previewsStartDate: s.previewsStartDate || null, score, rc: slimRc(s.id), category: s.category,
    type: s.type, isRevival: !!s.isRevival, venue: s.venue || null, people: RF.peopleOf(s.creativeTeam), status: s.status };
  poolById[s.id] = rec;
  if (rec.rc >= 3) pool.push(rec);
}
const castDir = path.join(ROOT, 'data/cast');
const castFiles = fs.readdirSync(castDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(castDir, f), 'utf8'))).filter((f) => f && f.showId);
const castIndex = V2.buildCastIndex(castFiles, showDates);

// audience captures: only entries whose parse succeeded and whose capture is dated before opening
const audience = {};
let audRaw = null;
if (fs.existsSync(AUD_FILE)) {
  audRaw = JSON.parse(fs.readFileSync(AUD_FILE, 'utf8'));
  for (const [id, rec] of Object.entries(audRaw.shows || {})) {
    const c = (rec.captures || []).find((k) => k.score != null && k.reviewCount != null);
    if (c) audience[id] = { timestamp: c.timestamp, score: c.score, reviewCount: c.reviewCount };
  }
}
// per-critic review index (critic = outlet + name; reviews without a name cannot be tracked) and honours
const awards = J('data/awards.json').shows;
const byCritic = new Map();
for (const r of J('data/reviews.json').reviews) {
  if (!r.criticName || r.assignedScore == null || !r.publishDate || !r.outletId) continue;
  const s = poolById[r.showId]; const day = RF.toDay(r.publishDate);
  if (!s || day == null) continue;
  const key = `${String(r.outletId).toLowerCase()}|${r.criticName.toLowerCase().trim()}`;
  if (!byCritic.has(key)) byCritic.set(key, []);
  byCritic.get(key).push({ day, score: r.assignedScore, type: s.type, weight: OT.getEffectiveWeight(r.outletId, { showCategory: s.category }), showId: r.showId });
}
// Show Score member reviews dated before opening (live paginated pages): shrunk mean toward 85 (k=10), review count
const MEM_FILE = arg('members', fs.existsSync(path.join(ROOT, 'data/audit/review-forecast-v2-showscore-members.json')) ? path.join(ROOT, 'data/audit/review-forecast-v2-showscore-members.json') : path.join(ROOT, 'data/audit/review-forecast-v2-showscore-members-pilot.json'));
let memRaw = null; const MEM_MIN = 1; // shrinkage (k=10 toward 85) handles small n; the full-pull spec grades every show with at least one dated member review
if (fs.existsSync(MEM_FILE)) {
  memRaw = JSON.parse(fs.readFileSync(MEM_FILE, 'utf8'));
  for (const [id, m] of Object.entries(memRaw.shows || {})) {
    if (m.n >= MEM_MIN && m.newest) audience[id] = { date: m.newest, score: (m.n * m.mean + 10 * 85) / (m.n + 10), reviewCount: m.n };
  }
}
// earlier-run review scores gathered from the web (scores + dates only), dated before first preview
const erRaw = J('data/audit/review-forecast-v2-earlier-run-compact.json');
const ctx = { pool, weeks, origins, poolById, castIndex, audience, awards, panel: { byCritic }, earlierRun: erRaw.reviews, troubleSet: new Set(erRaw.trouble || []) };

const targets = shows.filter((s) => poolById[s.id] && s.category === MARKET && poolById[s.id].rc >= FLOOR && (s.type === 'play' || s.type === 'musical')
  && !s.noReviewsExpected && !s.cancelledBeforeOpening && RF.toDay(s.openingDate) <= RF.toDay(TODAY) - SETTLE_DAYS).map((s) => poolById[s.id]);

const rows = []; const prov = { checked: 0 };
for (const t of targets) {
  const f = RF.buildFeatures(t, { pool, weeks, origins }, { floor: FLOOR });
  RF.assertNoLeakage(t, f.provenance);
  const v = V2.buildV2Features(t, ctx, { floor: FLOOR });
  V2.assertNoLeakageV2(t, v.provenance); prov.checked++;
  if (f.mu == null || f.baselineN < MIN_PRIOR_SHOWS) continue;
  const e = EX.buildExtraFeatures(t, ctx, f.mu);
  EX.assertNoLeakageExtra(t, e.provenance);
  const er = ER.buildEarlierRunFeatures(t, ctx, f.mu);
  ER.assertNoLeakageEarlierRun(t, er.provenance);
  const er72 = ER.buildEarlierRunFeatures(t, ctx, f.mu, { cut: 72 }); const er78 = ER.buildEarlierRunFeatures(t, ctx, f.mu, { cut: 78 });
  rows.push({ t, season: RF.seasonStartYear(t.openingDate), x: { ...f.x, ...v.x, ...e.x, ...er.x }, x72: er72.x, x78: er78.x, has: { ...v.has, ...e.has, ...er.has, ownPrior: f.priorScore != null }, mu: f.mu, y: t.score });
}
console.error(`evaluated rows ${rows.length}; v2 leakage-checked ${prov.checked}; awards ${rows.filter((r) => r.has.awards).length}, panel ${rows.filter((r) => r.has.panel).length}, cast ${rows.filter((r) => r.has.cast).length}, preview ${rows.filter((r) => r.has.preview).length}, audience ${rows.filter((r) => r.has.audience).length}`);

// perturbation: corrupt everything dated on/after opening; v2 features must not move
let moved = 0; let sampled = 0;
for (const r of rows.filter((_, i) => i % 8 === 0)) {
  const D = RF.toDay(r.t.openingDate); sampled++;
  const cp = pool.map((s) => (RF.toDay(s.openingDate) > D - RF.LAG_DAYS ? { ...s, score: 100 - s.score } : s));
  const cpById = Object.fromEntries(cp.map((s) => [s.id, s]));
  const cw = {};
  for (const [w, v] of Object.entries(weeks)) cw[w] = RF.toDay(w) >= D ? Object.fromEntries(Object.entries(v).map(([k, q]) => [k, { ...q, capacity: 1, atp: 1, gross: 1 }])) : v;
  const v2 = V2.buildV2Features(r.t, { ...ctx, pool: cp, poolById: { ...poolById, ...cpById }, weeks: cw }, { floor: FLOOR });
  const keep = Object.fromEntries(V2.V2_FEATURE_NAMES.map((k) => [k, r.x[k]]));
  if (JSON.stringify(v2.x) !== JSON.stringify(keep)) moved++;
  // extra inputs: flip every review and every award dated after the cutoff, then rebuild
  const cpPanel = new Map([...byCritic].map(([k, l]) => [k, l.map((q) => (q.day > D - RF.LAG_DAYS ? { ...q, score: 100 - q.score } : q))]));
  const cpAw = Object.fromEntries(Object.entries(awards).map(([id, rec]) => [id, Object.fromEntries(Object.entries(rec).map(([k, a]) => [k, a && EX.awardDate(k, a) && RF.toDay(EX.awardDate(k, a)) > D - RF.LAG_DAYS ? { ...a, wins: ['x'], nominations: 9, nominatedFor: ['x'] } : a]))]));
  const ex2 = EX.buildExtraFeatures(r.t, { ...ctx, pool: cp, awards: cpAw, panel: { byCritic: cpPanel } }, r.mu);
  if (EX.EXTRA_FEATURE_NAMES.some((k) => ex2.x[k] !== r.x[k])) moved++;
  // earlier-run: add a post-cutoff review (and a year-only date in the opening year) with an extreme score, rebuild
  const dayStr = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
  const cpEr = { ...ctx.earlierRun, [r.t.id]: [...(ctx.earlierRun[r.t.id] || []), [1, dayStr(D - RF.LAG_DAYS + 1), 0], [99, dayStr(D + 40), 0], [1, r.t.openingDate.slice(0, 4), 0]] };
  const er2 = ER.buildEarlierRunFeatures(r.t, { ...ctx, earlierRun: cpEr }, r.mu);
  if (ER.ER_FEATURE_NAMES.some((k) => er2.x[k] !== r.x[k])) moved++;
}
console.error(`perturbation self-check: ${sampled} shows, ${moved} v2 features moved`);
if (moved) { console.error('FAIL: v2 features depend on post-opening data'); process.exit(2); }

// ---- Show Score full-pull specs (declared before the full pull was graded) ----
// PRIMARY: one feature, audScore = shrunk pre-opening member mean minus 85, in the v1 ridge/residual frame, full population (0 when no dated member review).
// SECONDARY (a) audLow: shrunk share of member ratings <= 60 (k=10 toward 0.10, declared); (b) audBelow: floor rule, only ever negative, the shrunk mean minus
// the median shrunk mean of shows that opened at least 21 days earlier (needs 10 of them), zero otherwise; (c) mean plus n (the two audience features of the group).
// RESTRICTED variant R: shows whose kept reviews stop more than 7 days before the cutoff (the 12-page cap) count as having no audience data.
const SHARE_K = 10; const SHARE_P0 = 0.10; const MEM_GAP_MAX = 7;
const memOf = (id) => (memRaw && memRaw.shows ? memRaw.shows[id] : null);
const byOpen = [...rows].sort((a, b) => (a.t.openingDate < b.t.openingDate ? -1 : 1));
for (const r of rows) {
  const m = memOf(r.t.id); const has = !!(r.has.audience && m && m.n >= MEM_MIN);
  r.xS = { audLow: 0, audBelow: 0 }; r.xR = { audScore: r.x.audScore, audCount: r.x.audCount };
  if (!has) continue;
  if (m.shareLe60 != null) r.xS.audLow = (m.n * m.shareLe60 + SHARE_K * SHARE_P0) / (m.n + SHARE_K) - SHARE_P0;
  const D = RF.toDay(r.t.openingDate);
  const prior = byOpen.filter((q) => q.has.audience && RF.toDay(q.t.openingDate) <= D - 21).map((q) => q.x.audScore).sort((a, b) => a - b);
  if (prior.length >= 10) r.xS.audBelow = Math.min(0, r.x.audScore - prior[Math.floor(prior.length / 2)]);
  if (m.gapNewestToCutoffDays != null && m.gapNewestToCutoffDays > MEM_GAP_MAX) { r.xR = { audScore: 0, audCount: 0 }; r.hasR = false; } else r.hasR = true;
}
for (const r of rows) if (r.hasR === undefined) r.hasR = r.has.audience;
const XVAR = { S: (r) => r.xS, R: (r) => r.xR };

// ---- model plumbing (identical to v1) ----
const seasonsOf = (rs) => [...new Set(rs.map((r) => r.season))].sort((a, b) => a - b);
const xOf = (r, variant) => (variant ? { ...r.x, ...(XVAR[variant] ? XVAR[variant](r) : r[`x${variant}`]) } : r.x);
const fitOn = (rs, names, variant) => RF.fitRidge(rs.map((r) => ({ x: xOf(r, variant), y: r.y - r.mu })), names);
const predictRow = (m, r, variant) => Math.max(0, Math.min(100, r.mu + RF.predictRidge(m, xOf(r, variant))));
function walk(names, variant) {
  const out = [];
  for (const s of seasonsOf(rows)) {
    const train = rows.filter((r) => r.season < s); const test = rows.filter((r) => r.season === s);
    if (train.length < 150 || !test.length) continue;
    const m = fitOn(train, names, variant);
    for (const r of test) out.push({ id: r.t.id, season: s, y: r.y, pred: predictRow(m, r, variant), base: r.mu, has: r.has, prior: r.has.ownPrior, v1prior: r.x.priorRun });
  }
  return out;
}
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function diffCI(a, b, B = 2000, alpha = 0.05) { // a, b: aligned prediction arrays; CI of MAE(a) - MAE(b), seasons resampled
  const by = {};
  a.forEach((p, i) => { (by[p.season] = by[p.season] || []).push(Math.abs(p.y - p.pred) - Math.abs(b[i].y - b[i].pred)); });
  const ks = Object.keys(by); const R = rng(7314); const ds = [];
  for (let k = 0; k < B; k++) { let s = 0; let n = 0; for (let i = 0; i < ks.length; i++) { const v = by[ks[Math.floor(R() * ks.length)]]; s += v.reduce((x, y) => x + y, 0); n += v.length; } ds.push(s / n); }
  ds.sort((x, y) => x - y);
  return [RF.quantile(ds, alpha / 2), RF.quantile(ds, 1 - alpha / 2)];
}
// Test family for the correction (every row that can be called a winner or a verdict counts, combinations included):
// 6 single-group primary tests (cast, preview, panel, awards, calendar, house) + cast+preview + all-inputs-together (2)
// + earlier-run linear and step (2) + forked step cuts 72 and 78 (2) + flop and rave tails for earlier-run linear and step (4)
// + combined panel+earlier-run step and linear (2) + Show Score: full-pull primary, restricted variant, three secondary specs, primary flop and hit tails (7) + combined with Show Score (1) = 26.
const N_PRIMARY_TESTS = 26;
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const maeOf = (p) => RF.mean(p.map((q) => Math.abs(q.y - q.pred)));

const V1 = RF.FEATURE_NAMES;
const G = V2.V2_GROUPS;
const base = walk(V1);
function compare(label, names, subsetFn, kind, variant) {
  const w = walk(names, variant);
  if (w.length !== base.length || w.some((q, i) => q.id !== base[i].id)) throw new Error('walk-forward rows misaligned between models');
  const idx = base.map((_, i) => i).filter((i) => !subsetFn || subsetFn(base[i]));
  const A = idx.map((i) => w[i]); const B = idx.map((i) => base[i]);
  if (A.length < 20) return { input: label, kind, shows: A.length, verdict: 'cannot be established (fewer than 20 evaluated shows carry this input)' };
  const ci = diffCI(A, B); const ciAdj = diffCI(A, B, 2000, 0.05 / N_PRIMARY_TESTS);
  const d = maeOf(A) - maeOf(B);
  const verdict = r2(ci[1]) < 0 ? 'helps' : r2(ci[0]) > 0 ? 'hurts' : 'no effect'; // judged on the rounded interval: a hundredth of a point is not an effect
  const tail = (pred) => { const ix = A.map((_, i) => i).filter((i) => pred(A[i].y)); const a = ix.map((i) => A[i]); const b = ix.map((i) => B[i]); if (a.length < 10) return null;
    const c1 = diffCI(a, b); const c2 = diffCI(a, b, 2000, 0.05 / N_PRIMARY_TESTS); return { n: a.length, maeWithout: r2(maeOf(b)), maeWith: r2(maeOf(a)), diffCI95: c1.map(r2), diffCI95Bonferroni: c2.map(r2), survivesCorrection: r2(c2[1]) < 0 }; };
  return { input: label, kind, shows: A.length, missUnder55: tail((y) => y < 55), missMiddle55to82: tail((y) => y >= 55 && y < 83), miss83Plus: tail((y) => y >= 83), maeWithout: r2(maeOf(B)), maeWith: r2(maeOf(A)), maeCategoryMean: r2(RF.mean(A.map((q) => Math.abs(q.y - q.base)))),
    diff: r2(d), diffCI95: ci.map(r2), diffCI95Bonferroni: ciAdj.map(r2), bonferroniTests: N_PRIMARY_TESTS, survivesCorrection: r2(ciAdj[1]) < 0, verdict };
}
const hasAud = (p) => p.has.audience; const hasCast = (p) => p.has.cast; const hasPrev = (p) => p.has.preview;
const results = [];
results.push(compare('Opening-night cast (all six cast features)', [...V1, ...G.cast], null, 'primary'));
results.push(compare('Preview signals (length, capacity/price/gross trend, gross level)', [...V1, ...G.preview], null, 'primary'));
results.push(compare('Cast + preview signals together', [...V1, ...G.cast, ...G.preview], null, 'primary'));
results.push(compare('Cast, shows with an opening cast on file only', [...V1, ...G.cast], hasCast, 'primary-subset'));
results.push(compare('Preview signals, shows with preview data only', [...V1, ...G.preview], hasPrev, 'primary-subset'));
// Show Score, full pull. Primary spec stated above before grading; secondary specs counted in the correction family.
results.push(compare('Show Score PRIMARY: shrunk pre-opening member mean, full population', [...V1, 'audScore'], null, 'primary'));
results.push(compare('Show Score primary, restricted to shows whose kept reviews reach within 7 days of the cutoff (others count as no data)', [...V1, 'audScore'], null, 'primary', 'R'));
results.push(compare('Show Score primary, only shows with dated member reviews', [...V1, 'audScore'], hasAud, 'primary-subset'));
results.push(compare('Show Score secondary (a): share of ratings at or below 60', [...V1, 'audLow'], null, 'secondary', 'S'));
results.push(compare('Show Score secondary (b): floor rule, only moves down when below the earlier shows median', [...V1, 'audBelow'], null, 'secondary', 'S'));
results.push(compare('Show Score secondary (c): mean plus review count', [...V1, ...G.audience], null, 'secondary'));
const X = EX.EXTRA_GROUPS;
const EG = ER.ER_GROUPS; const hasEr = (p) => p.has.earlierRun;
results.push(compare('Earlier-run web reviews, linear (shrunk mean gap, has flag)', [...V1, ...EG.linear], null, 'primary'));
results.push(compare('Earlier-run web reviews, step at 75 (below / at or above)', [...V1, ...EG.step], null, 'primary'));
results.push(compare('Earlier-run, step at 72 (forked cut)', [...V1, ...EG.step], null, 'primary', '72'));
results.push(compare('Earlier-run, step at 78 (forked cut)', [...V1, ...EG.step], null, 'primary', '78'));
results.push(compare('Earlier-run linear, shows with earlier-run reviews only', [...V1, ...EG.linear], hasEr, 'primary-subset'));
results.push(compare('Earlier-run linear, shows WITHOUT an own earlier production in our data', [...V1, ...EG.linear], (p) => p.has.earlierRun && !p.prior, 'primary-subset'));
results.push(compare('Earlier-run linear, shows WITH an own earlier production in our data', [...V1, ...EG.linear], (p) => p.has.earlierRun && p.prior, 'primary-subset'));
results.push(compare('Trouble list (undated, exploratory only, not usable for forecasting)', [...V1, ...EG.trouble], null, 'exploratory'));
// overlap with the existing earlier-production input (priorRun from our own data)
const wb = walk(V1);
const erRows = wb.filter((p) => p.has.earlierRun);
const bothOwnAndEr = erRows.filter((p) => p.prior).length;
const tryoutOnly = erRows.filter((p) => !p.prior).length;
const overlap = { evaluatedShows: wb.length, withEarlierRunWebReviews: erRows.length, withOwnEarlierProduction: wb.filter((p) => p.prior).length, bothEarlierRunAndOwnProduction: bothOwnAndEr, earlierRunOnly: tryoutOnly,
  correlationShrunkWebMeanVsOwnPriorGap: (() => { const evalIds = new Set(wb.map((p) => p.id)); const a = rows.filter((r) => evalIds.has(r.t.id) && r.has.earlierRun && r.has.ownPrior); if (a.length < 5) return null; const mx = RF.mean(a.map((r) => r.x.erDev)); const my = RF.mean(a.map((r) => r.x.priorRun)); let sxy = 0; let sxx = 0; let syy = 0; for (const r of a) { sxy += (r.x.erDev - mx) * (r.x.priorRun - my); sxx += (r.x.erDev - mx) ** 2; syy += (r.x.priorRun - my) ** 2; } return { n: a.length, r: r2(sxy / Math.sqrt(sxx * syy)) }; })() };
console.error('earlier-run overlap', JSON.stringify(overlap));
const hasAw = (p) => p.has.awards; const hasPanel = (p) => p.has.panel;
results.push(compare('Panel: per-critic forecasts with tier weights (all critics, then same type)', [...V1, ...X.panel], null, 'primary'));
results.push(compare('Panel, shows with an active panel only', [...V1, ...X.panel], hasPanel, 'primary-subset'));
results.push(compare('Awards earned by earlier productions of the same title', [...V1, ...X.awards], null, 'primary'));
results.push(compare('Awards, shows with an earlier production that has honours', [...V1, ...X.awards], hasAw, 'primary-subset'));
results.push(compare('Calendar: spring crush and month of year', [...V1, ...X.calendar], null, 'primary'));
results.push(compare('Nonprofit-run house flag', [...V1, ...X.venueType], null, 'primary'));
results.push(compare('Every input together (cast, preview, panel, awards, calendar, house)', [...V1, ...G.cast, ...G.preview, ...X.panel, ...X.awards, ...X.calendar, ...X.venueType], null, 'primary'));
// combined model (parent request): per-critic panel + earlier-run + Show Score audience, one before/after number. Combined rows are tests in their own right and count in the correction family.
results.push(compare('Combined: panel + earlier-run (step at 75)', [...V1, ...X.panel, ...EG.step], null, 'combined'));
results.push(compare('Combined: panel + earlier-run (linear)', [...V1, ...X.panel, ...EG.linear], null, 'combined'));
results.push(compare('Combined: panel + earlier-run (step) + Show Score primary, full population', [...V1, ...X.panel, ...EG.step, 'audScore'], null, 'combined'));
results.push(compare('Combined: panel + earlier-run + Show Score audience, shows with member reviews only', [...V1, ...X.panel, ...EG.step, ...G.audience], hasAud, 'combined-subset'));
results.push(compare('Combined: panel + earlier-run (step), shows with member reviews only (same shows, no audience)', [...V1, ...X.panel, ...EG.step], hasAud, 'combined-subset'));
for (const f of [...G.cast, ...G.preview, ...EX.EXTRA_FEATURE_NAMES]) results.push(compare(`feature: ${f}`, [...V1, f], null, 'exploratory'));

// Best model = v1 unless a primary full-population candidate has a Bonferroni-corrected interval entirely below zero.
const winners = results.filter((r) => r.kind === 'primary' && r.survivesCorrection && r.shows === base.length).sort((a, b) => a.maeWith - b.maeWith);
const bestCombined = winners[0] || { input: 'None: v1 (today\'s formula) stays best', shows: base.length, maeWith: r2(maeOf(base)), verdict: 'no input helps' };
// ---- floor: how low the miss could go if the panel's own sampling noise were the only error ----
// For each evaluated show, resample its critics (one vote per outlet+critic, tier weights) with replacement
// and measure |resampled score - full score|. This is the spread from WHICH critics happen to review.
const FLOOR_B = 200; const Rf = rng(7347); const floors = [];
const critByShow = new Map();
for (const [key, list] of byCritic) for (const q of list) { if (!critByShow.has(q.showId)) critByShow.set(q.showId, new Map()); const m = critByShow.get(q.showId); if (!m.has(key)) m.set(key, q); }
for (const r of rows) {
  const m = critByShow.get(r.t.id); if (!m || m.size < 8) continue;
  const v = [...m.values()]; const wm = (xs) => xs.reduce((s, q) => s + q.weight * q.score, 0) / xs.reduce((s, q) => s + q.weight, 0);
  const full = wm(v); let acc = 0;
  for (let b = 0; b < FLOOR_B; b++) { const draw = []; for (let i = 0; i < v.length; i++) draw.push(v[Math.floor(Rf() * v.length)]); acc += Math.abs(wm(draw) - full); }
  floors.push(acc / FLOOR_B);
}
const floorBoot = RF.mean(floors);
let v1file = null; try { v1file = J('data/audit/review-forecast-backtest.json').walkForward; } catch { /* optional */ }
const reliability = v1file ? { source: 'v1 walk-forward (data/audit/review-forecast-backtest.json)', coverage80: v1file.coverage80, avgWidth80: v1file.avgWidth80, tierHitModel: v1file.bandHitModel, tierHitCategoryMean: v1file.bandHitCategoryMean, tierHitPriorElseMean: v1file.bandHitPriorElseMean } : null;
const out = {
  generatedAt: new Date().toISOString(), card: 'BRO-7347', market: MARKET, floor: FLOOR, today: TODAY,
  protocol: 'Walk-forward by season, ridge lambda 20, getCriticScore target, season-clustered bootstrap seed 7314 B=2000. diff = MAE with minus MAE without; negative is better. Verdict helps only if the 95% interval is entirely below zero.',
  baselineV1: { n: base.length, maeV1: r2(maeOf(base)), maeCategoryMean: r2(RF.mean(base.map((q) => Math.abs(q.y - q.base)))) },
  coverage: { evaluated: rows.length, withOpeningCast: rows.filter((r) => r.has.cast).length, withPreviewData: rows.filter((r) => r.has.preview).length, withAudienceCapture: rows.filter((r) => r.has.audience).length },
  leakage: { rowsChecked: prov.checked, perturbation: { checked: sampled, moved }, lagDays: RF.LAG_DAYS },
  showScoreMembers: memRaw ? { showsTried: Object.keys(memRaw.shows).length, withFiveOrMorePreOpening: Object.keys(audience).filter((k) => memRaw.shows[k]).length, paidFetches: 0, directRequests: memRaw.directRequestsTotal || null } : null,
  wayback: audRaw ? { showsTried: Object.keys(audRaw.shows).length, withCaptureBeforeOpening: Object.values(audRaw.shows).filter((v) => (v.captureTimestampsBeforeOpening || []).length).length, parsed: Object.keys(audRaw.shows).filter((k) => (audRaw.shows[k].captures || []).some((c) => c.score != null)).length, paidFetches: audRaw.paidFetches || 0 } : null,
  multipleComparisons: `Bonferroni over ${N_PRIMARY_TESTS} tests (6 single-group primary tests, cast+preview, all inputs together, earlier-run linear and step, two forked cuts, flop and rave tails, three combined models, seven Show Score tests). Per-feature rows are exploratory and uncorrected, so a lone exploratory "helps" would not count.`,
  floor: { shows: floors.length, bootstrapMissCriticSampling: r2(floorBoot), ifFullPanelIsItselfADraw: r2(floorBoot * Math.SQRT2), method: 'resample each show\'s critics (one vote per outlet+critic, real tier weights), mean |resample - full|; the second number scales by sqrt(2) because the observed panel is itself one draw. Neither is a hard limit; it estimates the part of the miss that comes from which critics happened to review.' },
  reliability,
  earlierRunOverlap: overlap,
  earlierRun: { source: 'research agents scored web reviews of the earlier run (regional, Off-Broadway, West End) found dated before first preview; the model uses only those dated on or before opening minus 3 days (the lag every input uses). Scores are agent-assigned after the Broadway verdict was known: noisy, hindsight risk the date filter cannot remove', showsInFile: Object.keys(erRaw.reviews).length, reviewsInFile: Object.values(erRaw.reviews).reduce((s, l) => s + l.length, 0), partialDatesReadAsLastDayOfPeriod: true, cutDeclared: ER.ER_CUT, forkedCuts: [72, 78], troubleListUndated: true },
  inputs: results,
  notTestable: [
    { input: 'Show Score audience score (Wayback capture before opening)', verdict: 'cannot be dated at usable coverage', why: 'archive.org availability lookups found no pre-opening capture for 30 shows (one season). Unproven coverage, not proof of absence. Replaced by the dated member-review route, which is tested above on a 54-show pilot.' },
    { input: 'Mezzanine (separate audience components)', verdict: 'forward-only', why: 'Stored Mezzanine data is production aggregates with no per-rating dates, so no pre-opening value can be rebuilt for past shows. It can only be recorded going forward. Theatr was not swept (no committed sampling): untested, not disproven.' },
    { input: 'Broadway.com audience score', verdict: 'untested (no dated source found)', why: 'Not swept (no committed sampling); the one paid fetch of the pilot found no audience rating field on the page read. Untested, not disproven.' },
    { input: 'BroadwayWorld board chatter before opening', verdict: 'cannot be dated', why: 'Wayback holds only board front pages and indexes. Thread URLs carry no show name, so per-show pre-opening thread counts cannot be rebuilt for a backtest.' },
    { input: 'Producer track record', verdict: 'cannot be dated', why: 'No producers field in data/commercial.json or any stored file; an IBDB scrape is a new paid source (owner call).' },
    { input: 'Opening date pushed, discount and lottery presence', verdict: 'cannot be dated', why: 'No stored original opening date (5 openingDateNote entries in shows.json) and no dated discount or lottery history.' },
    { input: 'Google Trends in the preview window', verdict: 'not attempted', why: 'Trends serves a bot wall to fetchPage; bypass is ruled out by the card.' },
    { input: 'Out-of-town critic scores', verdict: 'partly used, extension tested above', why: 'priorRun uses an earlier production of the same title only when we hold its Critic Score (97 of 341 evaluated shows). The web earlier-run input extends coverage to 179 shows (123 with nothing of our own); see the earlier-run rows.' },
  ],
  bestCombinedPrimary: bestCombined || null,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`wrote ${path.relative(ROOT, OUT)}`);
for (const r of results) console.log(`${r.kind.padEnd(14)} ${r.input.padEnd(70)} n=${r.shows} ${r.maeWithout ?? ''} -> ${r.maeWith ?? ''} CI ${JSON.stringify(r.diffCI95 ?? '')} ${r.verdict}`);
console.log('baseline', JSON.stringify(out.baselineV1), JSON.stringify(out.coverage));
