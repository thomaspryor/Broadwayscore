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
const ctx = { pool, weeks, origins, poolById, castIndex, audience };

const targets = shows.filter((s) => poolById[s.id] && s.category === MARKET && poolById[s.id].rc >= FLOOR && (s.type === 'play' || s.type === 'musical')
  && !s.noReviewsExpected && !s.cancelledBeforeOpening && RF.toDay(s.openingDate) <= RF.toDay(TODAY) - SETTLE_DAYS).map((s) => poolById[s.id]);

const rows = []; const prov = { checked: 0 };
for (const t of targets) {
  const f = RF.buildFeatures(t, { pool, weeks, origins }, { floor: FLOOR });
  RF.assertNoLeakage(t, f.provenance);
  const v = V2.buildV2Features(t, ctx, { floor: FLOOR });
  V2.assertNoLeakageV2(t, v.provenance); prov.checked++;
  if (f.mu == null || f.baselineN < MIN_PRIOR_SHOWS) continue;
  rows.push({ t, season: RF.seasonStartYear(t.openingDate), x: { ...f.x, ...v.x }, has: v.has, mu: f.mu, y: t.score });
}
console.error(`evaluated rows ${rows.length}; v2 leakage-checked ${prov.checked}; cast ${rows.filter((r) => r.has.cast).length}, preview ${rows.filter((r) => r.has.preview).length}, audience ${rows.filter((r) => r.has.audience).length}`);

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
}
console.error(`perturbation self-check: ${sampled} shows, ${moved} v2 features moved`);
if (moved) { console.error('FAIL: v2 features depend on post-opening data'); process.exit(2); }

// ---- model plumbing (identical to v1) ----
const seasonsOf = (rs) => [...new Set(rs.map((r) => r.season))].sort((a, b) => a - b);
const fitOn = (rs, names) => RF.fitRidge(rs.map((r) => ({ x: r.x, y: r.y - r.mu })), names);
const predictRow = (m, r) => Math.max(0, Math.min(100, r.mu + RF.predictRidge(m, r.x)));
function walk(names) {
  const out = [];
  for (const s of seasonsOf(rows)) {
    const train = rows.filter((r) => r.season < s); const test = rows.filter((r) => r.season === s);
    if (train.length < 150 || !test.length) continue;
    const m = fitOn(train, names);
    for (const r of test) out.push({ id: r.t.id, season: s, y: r.y, pred: predictRow(m, r), base: r.mu, has: r.has });
  }
  return out;
}
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function diffCI(a, b, B = 2000) { // a, b: aligned prediction arrays; CI of MAE(a) - MAE(b), seasons resampled
  const by = {};
  a.forEach((p, i) => { (by[p.season] = by[p.season] || []).push(Math.abs(p.y - p.pred) - Math.abs(b[i].y - b[i].pred)); });
  const ks = Object.keys(by); const R = rng(7314); const ds = [];
  for (let k = 0; k < B; k++) { let s = 0; let n = 0; for (let i = 0; i < ks.length; i++) { const v = by[ks[Math.floor(R() * ks.length)]]; s += v.reduce((x, y) => x + y, 0); n += v.length; } ds.push(s / n); }
  ds.sort((x, y) => x - y);
  return [RF.quantile(ds, 0.025), RF.quantile(ds, 0.975)];
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const maeOf = (p) => RF.mean(p.map((q) => Math.abs(q.y - q.pred)));

const V1 = RF.FEATURE_NAMES;
const G = V2.V2_GROUPS;
const base = walk(V1);
function compare(label, names, subsetFn, kind) {
  const w = walk(names);
  if (w.length !== base.length || w.some((q, i) => q.id !== base[i].id)) throw new Error('walk-forward rows misaligned between models');
  const idx = base.map((_, i) => i).filter((i) => !subsetFn || subsetFn(base[i]));
  const A = idx.map((i) => w[i]); const B = idx.map((i) => base[i]);
  if (A.length < 20) return { input: label, kind, shows: A.length, verdict: 'cannot be established (fewer than 20 evaluated shows carry this input)' };
  const ci = diffCI(A, B);
  const d = maeOf(A) - maeOf(B);
  const verdict = ci[1] < 0 ? 'helps' : ci[0] > 0 ? 'hurts' : 'no effect';
  return { input: label, kind, shows: A.length, maeWithout: r2(maeOf(B)), maeWith: r2(maeOf(A)), maeCategoryMean: r2(RF.mean(A.map((q) => Math.abs(q.y - q.base)))),
    diff: r2(d), diffCI95: ci.map(r2), verdict };
}
const rowsOf = {}; // walk-forward index helpers use base ids
const hasAud = (p) => p.has.audience; const hasCast = (p) => p.has.cast; const hasPrev = (p) => p.has.preview;
const results = [];
results.push(compare('Opening-night cast (all six cast features)', [...V1, ...G.cast], null, 'primary'));
results.push(compare('Preview signals (length, capacity/price/gross trend, gross level)', [...V1, ...G.preview], null, 'primary'));
results.push(compare('Cast + preview signals together', [...V1, ...G.cast, ...G.preview], null, 'primary'));
results.push(compare('Cast, shows with an opening cast on file only', [...V1, ...G.cast], hasCast, 'primary-subset'));
results.push(compare('Preview signals, shows with preview data only', [...V1, ...G.preview], hasPrev, 'primary-subset'));
results.push(compare('Show Score audience score before opening (Wayback capture)', [...V1, ...G.audience], hasAud, 'primary-subset'));
for (const f of [...G.cast, ...G.preview]) results.push(compare(`feature: ${f}`, [...V1, f], null, 'exploratory'));

// Best model = v1 unless a primary full-population candidate has a 95% interval entirely below zero.
const winners = results.filter((r) => r.kind === 'primary' && r.verdict === 'helps' && r.shows === base.length).sort((a, b) => a.maeWith - b.maeWith);
const bestCombined = winners[0] || { input: 'None: v1 (today\'s formula) stays best', shows: base.length, maeWith: r2(maeOf(base)), verdict: 'no input helps' };
const out = {
  generatedAt: new Date().toISOString(), card: 'BRO-7347', market: MARKET, floor: FLOOR, today: TODAY,
  protocol: 'Walk-forward by season, ridge lambda 20, getCriticScore target, season-clustered bootstrap seed 7314 B=2000. diff = MAE with minus MAE without; negative is better. Verdict helps only if the 95% interval is entirely below zero.',
  baselineV1: { n: base.length, maeV1: r2(maeOf(base)), maeCategoryMean: r2(RF.mean(base.map((q) => Math.abs(q.y - q.base)))) },
  coverage: { evaluated: rows.length, withOpeningCast: rows.filter((r) => r.has.cast).length, withPreviewData: rows.filter((r) => r.has.preview).length, withAudienceCapture: rows.filter((r) => r.has.audience).length },
  leakage: { rowsChecked: prov.checked, perturbation: { checked: sampled, moved }, lagDays: RF.LAG_DAYS },
  wayback: audRaw ? { showsTried: Object.keys(audRaw.shows).length, withCaptureBeforeOpening: Object.values(audRaw.shows).filter((v) => (v.captureTimestampsBeforeOpening || []).length).length, parsed: Object.keys(audience).length, paidFetches: audRaw.paidFetches || 0 } : null,
  multipleComparisons: 'Three primary groups were declared in advance; per-feature rows are exploratory and uncorrected, so a lone exploratory "helps" would not count.',
  inputs: results,
  notTestable: [
    { input: 'Show Score audience score and review count (Wayback capture before opening)', verdict: 'cannot be dated at usable coverage', why: 'archive.org availability found no capture dated before opening for any of the first 30 shows swept (2 of 24 in the earlier pilot). Fewer than 20 shows can carry it, so no with/without comparison is possible.' },
    { input: 'Mezzanine, Theatr (separate audience components)', verdict: 'cannot be dated', why: 'Mezzanine stored data is production aggregates with no review dates. Theatr: 0 of 20 sampled show pages have a Wayback capture before opening.' },
    { input: 'Broadway.com audience score', verdict: 'cannot be dated', why: '6 of 20 sampled show pages have an earlier capture, but the one capture read (1 paid fetch) carries no audience rating field.' },
    { input: 'BroadwayWorld board chatter before opening', verdict: 'cannot be dated', why: 'Wayback holds only board front pages and indexes. Thread URLs carry no show name, so per-show pre-opening thread counts cannot be rebuilt for a backtest.' },
    { input: 'Producer track record', verdict: 'cannot be dated', why: 'No producers field in data/commercial.json or any stored file; an IBDB scrape is a new paid source (owner call).' },
    { input: 'Opening date pushed, discount and lottery presence', verdict: 'cannot be dated', why: 'No stored original opening date (2 openingDateNote entries only) and no dated discount or lottery history.' },
    { input: 'Google Trends in the preview window', verdict: 'not attempted', why: 'Trends serves a bot wall to fetchPage; bypass is ruled out by the card.' },
    { input: 'Out-of-town critic scores', verdict: 'already used', why: 'priorRun takes the latest earlier production of the same title in any category (pool is all categories), including regional and West End runs.' },
  ],
  bestCombinedPrimary: bestCombined || null,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`wrote ${path.relative(ROOT, OUT)}`);
for (const r of results) console.log(`${r.kind.padEnd(14)} ${r.input.padEnd(70)} n=${r.shows} ${r.maeWithout ?? ''} -> ${r.maeWith ?? ''} CI ${JSON.stringify(r.diffCI95 ?? '')} ${r.verdict}`);
console.log('baseline', JSON.stringify(out.baselineV1), JSON.stringify(out.coverage));
