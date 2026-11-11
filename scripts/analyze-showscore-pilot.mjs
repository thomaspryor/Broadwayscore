#!/usr/bin/env node
/**
 * analyze-showscore-pilot.mjs (BRO-7347): grade the pre-opening Show Score member-review pilot against
 * the v1 walk-forward forecast. Research only. Reads per-show numbers (no review text, no names).
 *
 * Method: correction model on the v1 residual (actual - forecast) with ONE feature, the shrunk pre-opening
 * member mean (n*mean + 10*85)/(n+10) minus 85. Expanding window by opening date: each show is corrected by
 * a fit on pilot shows that opened at least 21 days earlier (min 12 training shows). Reports overall, flop
 * (actual < 55) and hit (actual >= 83) miss, with a season-clustered paired bootstrap (seed 7314, B=2000).
 *
 * Usage: node scripts/analyze-showscore-pilot.mjs --members=<json> [--backtest=data/audit/review-forecast-backtest.json] [--out=path]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const MEM = arg('members', path.join(ROOT, 'data/audit/review-forecast-v2-showscore-members.json'));
const BT = arg('backtest', path.join(ROOT, 'data/audit/review-forecast-backtest.json'));
const OUT = arg('out', null);
const MIN_TRAIN = 12; const MIN_N = 5; const PRIOR_N = 10; const CENTER = 85; const GAP_DAYS = 21;

const mem = JSON.parse(fs.readFileSync(MEM, 'utf8')).shows;
const bt = JSON.parse(fs.readFileSync(BT, 'utf8')).predictionsWalkForward;
const season = (iso) => { const y = +iso.slice(0, 4); return +iso.slice(5, 7) >= 6 ? y : y - 1; };
const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 864e5;

const rows = bt.filter((p) => mem[p.id] && mem[p.id].n != null && mem[p.id].n >= MIN_N)
  .map((p) => { const m = mem[p.id]; return { id: p.id, opened: p.opened, season: season(p.opened), actual: p.actual, f: p.forecast, cat: p.categoryMean, x: (m.n * m.mean + PRIOR_N * CENTER) / (m.n + PRIOR_N) - CENTER, n: m.n, res: p.actual - p.forecast }; })
  .sort((a, b) => (a.opened < b.opened ? -1 : 1));

function fit1(tr) {
  const mx = tr.reduce((s, r) => s + r.x, 0) / tr.length; const my = tr.reduce((s, r) => s + r.res, 0) / tr.length;
  let num = 0; let den = 0; for (const r of tr) { num += (r.x - mx) * (r.res - my); den += (r.x - mx) ** 2; }
  const lam = 20; const b = num / (den + lam); return { a: my - b * mx, b };
}
const out = [];
for (const r of rows) {
  const tr = rows.filter((q) => day(q.opened) <= day(r.opened) - GAP_DAYS);
  if (tr.length < MIN_TRAIN) continue;
  const m = fit1(tr); out.push({ ...r, g: r.f + m.a + m.b * r.x, b: m.b });
}
const mae = (a, f) => (a.length ? a.reduce((s, r) => s + Math.abs(r.actual - r[f]), 0) / a.length : null);
function boot(a, B = 2000) {
  let seed = 7314; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const by = {}; for (const r of a) (by[r.season] = by[r.season] || []).push(r);
  const ks = Object.keys(by); const d = [];
  for (let i = 0; i < B; i++) { let s = 0; let n = 0; for (let j = 0; j < ks.length; j++) { for (const r of by[ks[Math.floor(rnd() * ks.length)]]) { s += Math.abs(r.actual - r.g) - Math.abs(r.actual - r.f); n++; } } d.push(s / n); }
  d.sort((x, y) => x - y); return [Math.round(d[Math.floor(B * 0.025)] * 100) / 100, Math.round(d[Math.floor(B * 0.975)] * 100) / 100];
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const grp = (name, a) => ({ group: name, n: a.length, v1Miss: r2(mae(a, 'f')), withAudienceMiss: r2(mae(a, 'g')), categoryMeanMiss: r2(mae(a.map((r) => ({ ...r, c: r.cat })), 'c')), diff: r2(mae(a, 'g') - mae(a, 'f')), diffCI95: a.length >= 8 ? boot(a) : null });
const res = {
  pilotShowsWithData: rows.length, evaluated: out.length,
  coverage: { showsInFile: Object.keys(mem).length, withFiveOrMoreBeforeCutoff: rows.length, medianN: rows.length ? rows.map((r) => r.n).sort((a, b) => a - b)[rows.length >> 1] : null },
  correlationWithResidual: (() => { const a = rows; if (a.length < 3) return null; const mx = a.reduce((s, r) => s + r.x, 0) / a.length; const my = a.reduce((s, r) => s + r.res, 0) / a.length; let sxy = 0; let sxx = 0; let syy = 0; for (const r of a) { sxy += (r.x - mx) * (r.res - my); sxx += (r.x - mx) ** 2; syy += (r.res - my) ** 2; } return r2(sxy / Math.sqrt(sxx * syy)); })(),
  groups: [grp('all evaluated', out), grp('flops (actual < 55)', out.filter((r) => r.actual < 55)), grp('hits (actual >= 83)', out.filter((r) => r.actual >= 83)), grp('middle (55 to 82)', out.filter((r) => r.actual >= 55 && r.actual < 83))],
  note: 'Expanding-window correction of the v1 forecast residual by the shrunk pre-opening member mean; pilot sample is tail-weighted, so absolute misses are not the population miss.',
};
if (OUT) fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
