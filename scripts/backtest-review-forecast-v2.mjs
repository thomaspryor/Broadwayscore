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
const EA = require('./lib/review-forecast-v2-earlier-audience.js'); // BRO-7369
const EC = require('./lib/review-forecast-v2-earlier-critics.js'); // BRO-7369 A, B, C-gap

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const FLOOR = 10; const SETTLE_DAYS = 21; const MIN_PRIOR_SHOWS = 30; const MARKET = 'broadway';
if (process.argv.includes('--help') || process.argv.includes('-h')) { // BRO-7369: a help flag must never run (and overwrite) the backtest
  console.log('Usage: node scripts/backtest-review-forecast-v2.mjs [--audience=path] [--members=path] [--out=path] [--today=YYYY-MM-DD] [--freeze=path] [--nightly-combined] [--earlier-audience[=path]]\n'
    + '  Walk-forward backtest of pre-opening forecast inputs (BRO-7347). --earlier-audience (BRO-7369) adds the earlier-production Show Score audience tests,\n'
    + '  extends the correction family by those tests, and writes data/audit/review-forecast-inputs-v2-earlier-audience.json unless --out is given.');
  process.exit(0);
}
const EA_ON = process.argv.some((a) => a === '--earlier-audience' || a.startsWith('--earlier-audience='));
const TODAY = arg('today', new Date().toISOString().slice(0, 10));
const OUT = arg('out', path.join(ROOT, EA_ON ? 'data/audit/review-forecast-inputs-v2-earlier-audience.json' : 'data/audit/review-forecast-inputs-v2.json'));
const FREEZE = arg('freeze', null); // BRO-7357: write the frozen Show Score mean-plus-n model the nightly pilot uses
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
const allReviews = J('data/reviews.json').reviews;
// BRO-7369: every dated, scored, in-production review per show with its effective tier weight and T1 flag (wrongProduction / wrongShow / roundup reviews excluded, as in the composite)
const reviewsByShow = new Map();
for (const r of allReviews) {
  if (r.assignedScore == null || !r.publishDate || !r.outletId || r.wrongProduction || r.wrongShow || r.isRoundupArticle) continue;
  const s = poolById[r.showId]; const day = RF.toDay(r.publishDate); if (!s || day == null) continue;
  if (!reviewsByShow.has(r.showId)) reviewsByShow.set(r.showId, []);
  reviewsByShow.get(r.showId).push({ day, score: r.assignedScore, w: OT.getEffectiveWeight(r.outletId, { showCategory: s.category }), t1: OT.getTier(r.outletId, { showCategory: s.category }) === 1 });
}
for (const r of allReviews) {
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
    // leakage guard on the member data itself: nothing newer than opening minus the lag may be kept
    if (m.newest && m.cutoff && m.newest > m.cutoff) throw new Error(`LEAKAGE: ${id} member review ${m.newest} is after cutoff ${m.cutoff}`);
    if (m.n >= MEM_MIN && m.newest) audience[id] = { date: m.newest, score: (m.n * m.mean + 10 * 85) / (m.n + 10), reviewCount: m.n };
  }
}
// earlier-run review scores gathered from the web (scores + dates only), dated before first preview
const erRaw = J('data/audit/review-forecast-v2-earlier-run-compact.json');
// BRO-7369: earlier-production Show Score member ratings (Off-Broadway / London pages, or the earlier part of a shared page), each dated before the Broadway first preview
const EA_FILE = arg('earlier-audience', path.join(ROOT, 'data/audit/review-forecast-v2-earlier-audience.json'));
const earlierAudience = {}; const earlierAudienceConfirmed = {}; let eaRaw = null;
if (EA_ON && fs.existsSync(EA_FILE)) {
  eaRaw = JSON.parse(fs.readFileSync(EA_FILE, 'utf8'));
  for (const [id, rec] of Object.entries(eaRaw.shows || {})) {
    const s0 = poolById[id]; if (!s0) continue;
    for (const [key, dest] of [['pooled', earlierAudience], ['confirmedPooled', earlierAudienceConfirmed]]) {
      const a = rec[key]; if (!a || !(a.n > 0)) continue;
      if (a.newest > EA.earlierCutoff(s0)) throw new Error(`LEAKAGE: ${id} earlier-audience rating ${a.newest} is after cutoff ${EA.earlierCutoff(s0)}`);
      dest[id] = a;
    }
  }
}
const ctx = { pool, weeks, origins, poolById, castIndex, audience, awards, panel: { byCritic }, earlierRun: erRaw.reviews, troubleSet: new Set(erRaw.trouble || []), earlierAudience, reviewsByShow };
// transfer = an earlier production of the same title outside Broadway in our data, or earlier-run reviews on file; chosen independently of the new input
const nonBwayOpenings = new Map();
for (const s of shows) { if (s.category === 'broadway' || !s.openingDate) continue; const k = RF.titleKey(s.title); if (!nonBwayOpenings.has(k)) nonBwayOpenings.set(k, []); nonBwayOpenings.get(k).push(s.openingDate); }
const isTransfer = (t) => (nonBwayOpenings.get(RF.titleKey(t.title)) || []).some((d) => d < t.openingDate) || !!(erRaw.reviews[t.id] && erRaw.reviews[t.id].length);

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
  const ea = EA.buildEarlierAudienceFeatures(t, ctx);
  EA.assertNoLeakageEarlierAudience(t, ea.provenance);
  const eaC = EA.buildEarlierAudienceFeatures(t, { ...ctx, earlierAudience: earlierAudienceConfirmed });
  const ec = EC.buildEarlierCriticsFeatures(t, ctx, f.mu);
  EC.assertNoLeakageEarlierCritics(t, ec.provenance);
  rows.push({ t, season: RF.seasonStartYear(t.openingDate), x: { ...f.x, ...v.x, ...e.x, ...er.x, ...ea.x, ...ec.x }, x72: er72.x, x78: er78.x, xEAC: eaC.x, has: { ...v.has, ...e.has, ...er.has, ...ea.has, ...ec.has, ownPrior: f.priorScore != null, transfer: isTransfer(t) }, mu: f.mu, y: t.score });
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
  // earlier-critics (BRO-7369): flip every review dated after the earlier-production cutoff and every show that opened after it, rebuild
  const ecCut = RF.toDay(EA.earlierCutoff(r.t));
  const cpRv = new Map([...reviewsByShow].map(([k, l]) => [k, l.map((q) => (q.day > ecCut ? { ...q, score: 100 - q.score, w: 9, t1: true } : q))]));
  const cpEc = pool.map((q) => (RF.toDay(q.openingDate) > ecCut ? { ...q, score: 100 - q.score, rc: 99 } : q));
  const ec2 = EC.buildEarlierCriticsFeatures(r.t, { ...ctx, pool: cpEc, reviewsByShow: cpRv }, r.mu);
  if (EC.EC_FEATURE_NAMES.some((k) => ec2.x[k] !== r.x[k])) moved++;
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
const XVAR = { S: (r) => r.xS, R: (r) => r.xR, EAC: (r) => r.xEAC };

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
  if (a.length !== b.length || a.some((p, i) => p.y !== b[i].y || p.season !== b[i].season)) throw new Error('diffCI: prediction arrays are not aligned');
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
const NIGHTLY_COMBINED = process.argv.includes('--nightly-combined'); // BRO-7357: adds one test (Show Score + panel, no web-collected earlier-run), so the family is 27
const EA_NEW_TESTS = 23; // BRO-7369: input alone vs v1 (all, transfers), increment over v2 (all, transfers), increment over v2 on confirmed pages only
const N_PRIMARY_TESTS = (NIGHTLY_COMBINED ? 27 : 26) + (EA_ON ? EA_NEW_TESTS : 0);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const maeOf = (p) => RF.mean(p.map((q) => Math.abs(q.y - q.pred)));

const V1 = RF.FEATURE_NAMES;
const G = V2.V2_GROUPS;
const base = walk(V1);
// ext.baseNames: compare against another feature set (default v1), e.g. the landed v2 spec; ext.family: a subset row that is still one of the declared correction-family tests
const baseWalks = new Map();
const baseFor = (names) => { const k = names.join(','); if (!baseWalks.has(k)) baseWalks.set(k, walk(names)); return baseWalks.get(k); };
function compare(label, names, subsetFn, kind, variant, ext = {}) {
  const w = walk(names, variant);
  const bw = ext.baseNames ? baseFor(ext.baseNames) : base;
  if (w.length !== bw.length || w.some((q, i) => q.id !== bw[i].id)) throw new Error('walk-forward rows misaligned between models');
  const idx = bw.map((_, i) => i).filter((i) => !subsetFn || subsetFn(bw[i]));
  const A = idx.map((i) => w[i]); const B = idx.map((i) => bw[i]);
  if (A.length < 20) return { input: label, kind, shows: A.length, verdict: 'cannot be established (fewer than 20 evaluated shows carry this input)' };
  const ci = diffCI(A, B); const ciAdj = diffCI(A, B, 2000, 0.05 / N_PRIMARY_TESTS);
  const d = maeOf(A) - maeOf(B);
  const verdict = r2(ci[1]) < 0 ? 'helps' : r2(ci[0]) > 0 ? 'hurts' : 'no effect'; // judged on the rounded interval: a hundredth of a point is not an effect
  const tail = (pred) => { const ix = A.map((_, i) => i).filter((i) => pred(A[i].y)); const a = ix.map((i) => A[i]); const b = ix.map((i) => B[i]); if (a.length < 10) return null;
    const c1 = diffCI(a, b); const c2 = diffCI(a, b, 2000, 0.05 / N_PRIMARY_TESTS); return { n: a.length, maeWithout: r2(maeOf(b)), maeWith: r2(maeOf(a)), diffCI95: c1.map(r2), diffCI95Bonferroni: c2.map(r2), survivesCorrection: subsetFn && !ext.family ? null : r2(c2[1]) < 0 }; };
  return { input: label, kind, shows: A.length, missUnder55: tail((y) => y < 55), missMiddle55to82: tail((y) => y >= 55 && y < 83), miss83Plus: tail((y) => y >= 83), maeWithout: r2(maeOf(B)), maeWith: r2(maeOf(A)), maeCategoryMean: r2(RF.mean(A.map((q) => Math.abs(q.y - q.base)))),
    diff: r2(d), diffCI95: ci.map(r2), diffCI95Bonferroni: ciAdj.map(r2), bonferroniTests: N_PRIMARY_TESTS, survivesCorrection: subsetFn && !ext.family ? null : r2(ciAdj[1]) < 0, inCorrectionFamily: !subsetFn || !!ext.family, verdict };
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
if (NIGHTLY_COMBINED) results.push(compare('Nightly-safe combined: panel + Show Score mean plus n (no earlier-run)', [...V1, ...X.panel, ...G.audience], null, 'combined'));
// BRO-7357 (2): panel increment over Show Score ALONE, paired on the same rows and the same walk-forward. Report-only. The Bonferroni interval is shown for reference against the same N_PRIMARY_TESTS family the other combined forms use; the decision rule is the plain 95% CI.
let panelIncrement = null;
if (NIGHTLY_COMBINED) {
  const wSS = walk([...V1, ...G.audience]); const wCB = walk([...V1, ...X.panel, ...G.audience]);
  if (wSS.length !== wCB.length || wSS.some((q, i) => q.id !== wCB[i].id)) throw new Error('panel increment: walk-forward rows misaligned');
  const inc = (idx, label) => { const A = idx.map((i) => wCB[i]); const B = idx.map((i) => wSS[i]); const ci = diffCI(A, B); const ciAdj = diffCI(A, B, 2000, 0.05 / N_PRIMARY_TESTS);
    return { subset: label, shows: A.length, maeShowScoreOnly: r2(maeOf(B)), maeShowScorePlusPanel: r2(maeOf(A)), diff: r2(maeOf(A) - maeOf(B)), diffCI95: ci.map(r2), diffCI95Bonferroni: ciAdj.map(r2), excludesZero: r2(ci[1]) < 0 || r2(ci[0]) > 0, direction: r2(ci[1]) < 0 ? 'panel helps' : r2(ci[0]) > 0 ? 'panel hurts' : 'no detectable increment' }; };
  const all = wSS.map((_, i) => i);
  panelIncrement = { note: 'diff = MAE(Show Score + panel) minus MAE(Show Score alone), same rows, same walk-forward, season-clustered bootstrap seed 7314 B=2000; negative is better', all: inc(all, 'all evaluated shows'), withMemberReviews: inc(all.filter((i) => base[i].has.audience), 'shows with dated member reviews') };
  console.log('PANEL INCREMENT', JSON.stringify(panelIncrement));
}
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

// ---- BRO-7369: earlier-production Show Score audience. Specs declared before any result was seen: ONE feature, eaScore (shrunk member mean, k=10 toward 85, minus 85, 0 when none),
// full population, in the v1 ridge/residual frame; the increment is measured against the LANDED v2 spec (v1 + audScore + audCount). The new tests join the correction family (EA_NEW_TESTS, checked at runtime).
// "Transfers" = an earlier non-Broadway production of the same title in shows.json or earlier-run reviews on file, picked without looking at the new input.
// Decision rule: the input is added to the nightly pilot only if the increment over v2 (all shows) has a Bonferroni-corrected interval entirely below zero.
let transferModel = null; const V2SPEC = [...V1, ...G.audience]; const hasEA = (p) => p.has.earlierAudience; const isTr = (p) => p.has.transfer;
const EA_ROWS_FROM = results.length;
if (EA_ON) {
  results.push(compare('Earlier-production audience vs v1: shrunk member mean, all shows', [...V1, 'eaScore'], null, 'primary'));
  results.push(compare('Earlier-production audience vs v1: transfers only', [...V1, 'eaScore'], isTr, 'primary-subset', undefined, { family: true }));
  results.push(compare('Earlier-production audience INCREMENT over landed v2 (v1 + Show Score mean and n): all shows', [...V2SPEC, 'eaScore'], null, 'primary', undefined, { baseNames: V2SPEC }));
  results.push(compare('Earlier-production audience INCREMENT over landed v2: transfers only', [...V2SPEC, 'eaScore'], isTr, 'primary-subset', undefined, { baseNames: V2SPEC, family: true }));
  results.push(compare('Earlier-production audience INCREMENT over landed v2, confirmed pages only (no guessed slugs): all shows', [...V2SPEC, 'eaScore'], null, 'primary', 'EAC', { baseNames: V2SPEC }));
  // exploratory (not in the family): shows that carry the input, and the flag variant
  results.push(compare('Earlier-production audience vs v1, only shows that carry it', [...V1, 'eaScore'], hasEA, 'exploratory-subset'));
  results.push(compare('Earlier-production audience increment over v2, only shows that carry it', [...V2SPEC, 'eaScore'], hasEA, 'exploratory-subset', undefined, { baseNames: V2SPEC }));
  results.push(compare('Earlier-production audience increment over v2, flag plus score', [...V2SPEC, ...EA.EA_GROUPS.flag], null, 'exploratory', undefined, { baseNames: V2SPEC }));
  results.push(compare('Earlier-production audience increment over v2, transfers that carry it', [...V2SPEC, 'eaScore'], (p) => isTr(p) && hasEA(p), 'exploratory-subset', undefined, { baseNames: V2SPEC }));
  // ---- BRO-7369 A, B, C-gap: the site's own earlier-production critic scores. Each input: vs v1 (all, transfers), increment over v2 (all, transfers) = 4 family tests. Declared before grading. ----
  const hasEC = (p) => p.has.earlierCritics; const hasT1 = (p) => p.has.earlierT1; const hasGap = (p) => p.has.earlierCritics && p.has.earlierAudience;
  const SPECS = [
    ['A: own earlier-production critic score (count-shrunk gap, opened before first preview)', EC.EC_GROUPS.a, hasEC],
    ['B: tier-weighted earlier-production score from reviews dated by the cutoff', EC.EC_GROUPS.bW, hasEC],
    ['B: Tier-1-only earlier-production score', EC.EC_GROUPS.bT1, hasT1],
    ['C-gap: earlier-production audience minus earlier-production critics', EC.EC_GROUPS.cGap, hasGap],
  ];
  for (const [lab, g, carry] of SPECS) {
    results.push(compare(`${lab} vs v1: all shows`, [...V1, ...g], null, 'primary'));
    results.push(compare(`${lab} vs v1: transfers only`, [...V1, ...g], isTr, 'primary-subset', undefined, { family: true }));
    results.push(compare(`${lab} INCREMENT over landed v2: all shows`, [...V2SPEC, ...g], null, 'primary', undefined, { baseNames: V2SPEC }));
    results.push(compare(`${lab} INCREMENT over landed v2: transfers only`, [...V2SPEC, ...g], isTr, 'primary-subset', undefined, { baseNames: V2SPEC, family: true }));
    results.push(compare(`${lab} INCREMENT over landed v2: only shows that carry it`, [...V2SPEC, ...g], carry, 'exploratory-subset', undefined, { baseNames: V2SPEC }));
  }
  // ---- D: one combined transfer model = v2 + best of A / B + earlier-production audience (eaScore). The A-vs-B pick is made on the walk-forward predictions of seasons up to the MEDIAN walk season only (selection set), before any interval is computed; the later seasons are the clean test. ----
  const walkSeasons = [...new Set(base.map((q) => q.season))].sort((a, b) => a - b); const SEL = walkSeasons[Math.floor(walkSeasons.length / 2) - 1];
  const selMae = (g) => { const w = walk([...V2SPEC, ...g]).filter((q) => q.season <= SEL); return maeOf(w); };
  const cands = [['A', EC.EC_GROUPS.a], ['B-weighted', EC.EC_GROUPS.bW], ['B-T1', EC.EC_GROUPS.bT1]].map(([k, g]) => ({ k, g, mae: selMae(g) })).sort((a, b) => a.mae - b.mae);
  const pick = cands[0]; transferModel = { selectionSeasonsThrough: SEL, picked: pick.k, selectionMae: cands.map((c) => ({ input: c.k, mae: r2(c.mae) })), features: [...V2SPEC, ...pick.g, 'eaScore'] };
  const D = transferModel.features;
  results.push(compare(`D: TRANSFER MODEL (v2 + ${pick.k} + earlier audience) INCREMENT over landed v2: all shows`, D, null, 'primary', undefined, { baseNames: V2SPEC }));
  results.push(compare(`D: TRANSFER MODEL INCREMENT over landed v2: transfers only`, D, isTr, 'primary-subset', undefined, { baseNames: V2SPEC, family: true }));
  results.push(compare(`D: TRANSFER MODEL vs v1: all shows`, D, null, 'exploratory'));
  results.push(compare(`D: TRANSFER MODEL INCREMENT over v2, seasons after the selection set (clean test): all shows`, D, (p) => p.season > SEL, 'exploratory-subset', undefined, { baseNames: V2SPEC }));
  results.push(compare(`D: TRANSFER MODEL INCREMENT over v2, seasons after the selection set: transfers only`, D, (p) => p.season > SEL && isTr(p), 'exploratory-subset', undefined, { baseNames: V2SPEC }));
}
if (EA_ON) { // the Bonferroni family must equal the rows declared in it: fail loudly if a test is added or dropped without updating EA_NEW_TESTS
  const declared = results.slice(EA_ROWS_FROM).filter((r) => r.kind === 'primary' || r.kind === 'primary-subset').length;
  if (declared !== EA_NEW_TESTS) throw new Error(`correction family mismatch: ${declared} new in-family rows, EA_NEW_TESTS=${EA_NEW_TESTS}`);
}

// ---- BRO-7357: freeze the nightly v2 shadow model (v1 features + audScore + audCount, fit on the full evaluated set) ----
if (FREEZE) {
  const names = [...V1, ...G.audience];
  const fit = rows.filter((r) => r.mu != null);
  const toTrain = (rs) => rs.map((r) => ({ x: r.x, y: r.y - r.mu }));
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const model = RF.fitRidge(toTrain(fit), names);
  const resid = [];
  for (const s of seasonsOf(fit)) {
    const tr = fit.filter((r) => r.season !== s); const te = fit.filter((r) => r.season === s);
    if (tr.length < 60) continue;
    const m = RF.fitRidge(toTrain(tr), names);
    for (const r of te) resid.push(r.y - clamp(r.mu + RF.predictRidge(m, r.x)));
  }
  resid.sort((a, b) => a - b);
  const frozen = { modelVersion: 'rf-v2-showscore-meann-2026-11-11', spec: 'v1 features + audScore (shrunk Show Score mean, k=10 toward 85, minus 85) + audCount (log(n+1) - log 60); ridge lambda ' + RF.RIDGE_LAMBDA, fitRows: fit.length, residualQ10: RF.quantile(resid, 0.1), residualQ90: RF.quantile(resid, 0.9), shrinkK: 10, shrinkCenter: 85, model };
  fs.writeFileSync(FREEZE, JSON.stringify(frozen, null, 1) + '\n');
  console.error(`froze v2 model on ${fit.length} rows -> ${FREEZE}`);
}
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
  generatedAt: new Date().toISOString(), card: EA_ON ? 'BRO-7369' : 'BRO-7347', market: MARKET, floor: FLOOR, today: TODAY,
  protocol: 'Walk-forward by season, ridge lambda 20, getCriticScore target, season-clustered bootstrap seed 7314 B=2000. diff = MAE with minus MAE without; negative is better. Verdict helps only if the 95% interval is entirely below zero.',
  baselineV1: { n: base.length, maeV1: r2(maeOf(base)), maeCategoryMean: r2(RF.mean(base.map((q) => Math.abs(q.y - q.base)))) },
  coverage: { evaluated: rows.length, withOpeningCast: rows.filter((r) => r.has.cast).length, withPreviewData: rows.filter((r) => r.has.preview).length, withAudienceCapture: rows.filter((r) => r.has.audience).length },
  leakage: { rowsChecked: prov.checked, perturbation: { checked: sampled, moved }, lagDays: RF.LAG_DAYS },
  showScoreMembers: memRaw ? { showsTried: Object.keys(memRaw.shows).length, withAtLeastOnePreOpeningMemberReview: Object.keys(audience).filter((k) => memRaw.shows[k]).length, paidFetches: 0, directRequests: memRaw.directRequestsTotal || null } : null,
  wayback: audRaw ? { showsTried: Object.keys(audRaw.shows).length, withCaptureBeforeOpening: Object.values(audRaw.shows).filter((v) => (v.captureTimestampsBeforeOpening || []).length).length, parsed: Object.keys(audRaw.shows).filter((k) => (audRaw.shows[k].captures || []).some((c) => c.score != null)).length, paidFetches: audRaw.paidFetches || 0 } : null,
  multipleComparisons: `Bonferroni over ${N_PRIMARY_TESTS} tests (6 single-group primary tests, cast+preview, all inputs together, earlier-run linear and step, two forked cuts, flop and rave tails, three combined models, seven Show Score tests). Per-feature rows are exploratory and uncorrected, so a lone exploratory "helps" would not count.`,
  floor: { shows: floors.length, bootstrapMissCriticSampling: r2(floorBoot), ifFullPanelIsItselfADraw: r2(floorBoot * Math.SQRT2), method: 'resample each show\'s critics (one vote per outlet+critic, real tier weights), mean |resample - full|; the second number scales by sqrt(2) because the observed panel is itself one draw. Neither is a hard limit; it estimates the part of the miss that comes from which critics happened to review.' },
  reliability,
  earlierRunOverlap: overlap,
  earlierRun: { source: 'research agents scored web reviews of the earlier run (regional, Off-Broadway, West End) found dated before first preview; the model uses only those dated on or before opening minus 3 days (the lag every input uses). Scores are agent-assigned after the Broadway verdict was known: noisy, hindsight risk the date filter cannot remove', showsInFile: Object.keys(erRaw.reviews).length, reviewsInFile: Object.values(erRaw.reviews).reduce((s, l) => s + l.length, 0), partialDatesReadAsLastDayOfPeriod: true, cutDeclared: ER.ER_CUT, forkedCuts: [72, 78], troubleListUndated: true },
  panelIncrement,
  inputs: results,
  notTestable: [
    { input: 'Show Score audience score (Wayback capture before opening)', verdict: 'cannot be dated at usable coverage', why: 'archive.org availability lookups found no pre-opening capture for 30 shows (one season). Unproven coverage, not proof of absence. Replaced by the dated member-review route, which is tested above on the full 341-show pull (coverage: none of the 2025 and 2026 shows has dated member reviews).' },
    { input: 'Mezzanine (separate audience components)', verdict: 'forward-only', why: 'Stored Mezzanine data is production aggregates with no per-rating dates, so no pre-opening value can be rebuilt for past shows. It can only be recorded going forward. Theatr was not swept (no committed sampling): untested, not disproven.' },
    { input: 'Broadway.com audience score', verdict: 'untested (no dated source found)', why: 'Not swept (no committed sampling); the one paid fetch of the pilot found no audience rating field on the page read. Untested, not disproven.' },
    { input: 'BroadwayWorld board chatter before opening', verdict: 'cannot be dated', why: 'Wayback holds only board front pages and indexes. Thread URLs carry no show name, so per-show pre-opening thread counts cannot be rebuilt for a backtest.' },
    { input: 'Producer track record', verdict: 'cannot be dated', why: 'No producers field in data/commercial.json or any stored file; an IBDB scrape is a new paid source (owner call).' },
    { input: 'Opening date pushed, discount and lottery presence', verdict: 'cannot be dated', why: 'No stored original opening date (5 openingDateNote entries in shows.json) and no dated discount or lottery history.' },
    { input: 'Google Trends in the preview window', verdict: 'not attempted', why: 'Trends serves a bot wall to fetchPage; bypass is ruled out by the card.' },
    { input: 'Out-of-town critic scores', verdict: 'partly used, extension tested above', why: 'priorRun uses an earlier production of the same title only when we hold its Critic Score (97 of 341 evaluated shows). The web earlier-run input extends coverage to 179 shows (123 with nothing of our own); see the earlier-run rows.' },
  ],
  bestCombinedPrimary: bestCombined || null,
  ...(EA_ON ? { earlierAudience: (() => {
    const evalIds = new Set(rows.map((r) => r.t.id)); const ev = Object.entries((eaRaw && eaRaw.shows) || {}).filter(([id]) => evalIds.has(id));
    const kindOf = (u) => (/\/uk\/london\//.test(u || '') ? 'london' : /\/off-broadway-shows\//.test(u || '') ? 'off-broadway' : 'shared-page');
    const cov = { evaluatedShows: rows.length, transfers: rows.filter((r) => r.has.transfer).length, withEarlierAudience: rows.filter((r) => r.has.earlierAudience).length,
      transfersWithEarlierAudience: rows.filter((r) => r.has.transfer && r.has.earlierAudience).length, withEarlierAudienceConfirmedPagesOnly: Object.keys(earlierAudienceConfirmed).filter((id) => evalIds.has(id)).length,
      bySourceType: { 'shared-page': 0, 'off-broadway': 0, london: 0 }, medianRatingsPerCoveredShow: null, outOfTownOrLondonDatedSource: 'London Show Score pages are probed when mapped; out-of-town (regional) productions have no dated audience source in our data' };
    const ns = [];
    for (const [id, rec] of ev) { if (!rec.pooled) continue; ns.push(rec.pooled.n); const seen = new Set(); for (const x of rec.sources || []) if (x.n > 0 && !x.duplicateOf) seen.add(x.kind === 'shared-page' ? 'shared-page' : kindOf(x.url)); for (const k of seen) cov.bySourceType[k] += 1; }
    ns.sort((a, b) => a - b); cov.medianRatingsPerCoveredShow = ns.length ? ns[Math.floor(ns.length / 2)] : null;
    const inc = results.find((r) => /INCREMENT over landed v2 \(v1 \+ Show Score mean and n\): all shows/.test(r.input));
    cov.decision = { rule: 'add to the nightly pilot only if the increment over v2 (all shows) has a Bonferroni-corrected 95% interval entirely below zero', correctionFamilyTests: N_PRIMARY_TESTS,
      incrementOverV2: inc ? { maeV2: inc.maeWithout, maeV2PlusEarlierAudience: inc.maeWith, diff: inc.diff, diffCI95: inc.diffCI95, diffCI95Bonferroni: inc.diffCI95Bonferroni } : null, addToPilot: !!(inc && inc.diffCI95Bonferroni && inc.diffCI95Bonferroni[1] < 0) };
    // BRO-7369 A, B, C-gap, D coverage and the extended decision: every INCREMENT-over-v2 row on all shows that sits in the correction family
    cov.earlierCritics = { withEarlierProduction: rows.filter((r) => r.has.earlierCritics).length, withTier1Reviews: rows.filter((r) => r.has.earlierT1).length,
      withEarlierAudienceAndCritics: rows.filter((r) => r.has.earlierCritics && r.has.earlierAudience).length, transfersWithEarlierProduction: rows.filter((r) => r.has.transfer && r.has.earlierCritics).length,
      byMarket: Object.fromEntries([...EC.EARLIER_CATEGORIES].map((c) => [c, rows.filter((r) => r.has.earlierCritics && (EC.findEarlier(r.t, ctx, EA.earlierCutoff(r.t)) || {}).category === c).length])),
      note: 'v1 already carries the latest earlier production score as priorRun; these tests measure what that does not use (count shrinkage, before-first-preview filter, tier weighting, T1-only, audience-minus-critics gap)' };
    cov.transferModel = transferModel;
    cov.decision.candidates = results.filter((r) => r.inCorrectionFamily && (r.kind === 'primary' || r.kind === 'primary-subset') && /INCREMENT over (landed )?v2: all shows|INCREMENT over landed v2 \(v1.*all shows|confirmed pages only/.test(r.input)).map((r) => ({ input: r.input, diff: r.diff, diffCI95Bonferroni: r.diffCI95Bonferroni, addToPilot: !!(r.diffCI95Bonferroni && r.diffCI95Bonferroni[1] < 0) }));
    cov.decision.addToPilotAny = cov.decision.candidates.some((c) => c.addToPilot);
    return cov;
  })() } : {}),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`wrote ${path.relative(ROOT, OUT)}`);
for (const r of results) console.log(`${r.kind.padEnd(14)} ${r.input.padEnd(70)} n=${r.shows} ${r.maeWithout ?? ''} -> ${r.maeWith ?? ''} CI ${JSON.stringify(r.diffCI95 ?? '')} ${r.verdict}`);
console.log('baseline', JSON.stringify(out.baselineV1), JSON.stringify(out.coverage));
