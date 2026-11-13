#!/usr/bin/env node
/**
 * predict-critic-score.js (BRO-7314): forward-in-time backtest of a pre-opening
 * critic score forecast. NOTHING is published; output is JSON for the owner Artifact.
 *   node scripts/predict-critic-score.js [--from=2023-01-01] [--json=path] [--next]
 */
const fs = require('fs');
const path = require('path');
const { forecast, peopleOf, band, cohortKey, mean } = require('./lib/critic-score-forecast');

const ROOT = path.join(__dirname, '..');
function loadRows() {
  const s = require(path.join(ROOT, 'data/shows.json'));
  const shows = Array.isArray(s) ? s : s.shows;
  const dir = path.join(ROOT, 'public/data/shows');
  const rows = [];
  for (const x of shows) {
    if (!x.openingDate || !['broadway', 'off-broadway', 'west-end'].includes(x.category)) continue;
    if (!['musical', 'play'].includes(x.type)) continue;
    let score = null;
    try { score = JSON.parse(fs.readFileSync(path.join(dir, x.id + '.json'), 'utf8')).cs; } catch { /* no slim */ }
    rows.push({ id: x.id, title: x.title, openingDate: x.openingDate, category: x.category, type: x.type,
      isRevival: !!x.isRevival, originalProductionId: x.originalProductionId || null, people: peopleOf(x),
      hasPriorRuns: !!(x.priorRuns && x.priorRuns.length) || !!x.transferOf,
      score: typeof score === 'number' ? score : null, status: x.status });
  }
  return rows;
}

function backtest(rows, from, opts = {}) {
  const scored = rows.filter((r) => r.score != null);
  const test = scored.filter((r) => r.openingDate >= from);
  const out = [];
  for (const t of test) {
    const f = forecast(t, scored, opts);
    if (!f) continue;
    const past = scored.filter((h) => h.openingDate < t.openingDate);
    const cm = mean(past.filter((h) => h.category === t.category && h.type === t.type).map((h) => h.score));
    if (cm == null) continue; // no baseline available: skip rather than score as 0
    out.push({ id: t.id, title: t.title, opening: t.openingDate, category: t.category, type: t.type, actual: t.score,
      pred: f.pred, catMean: cm, priorScore: f.priorScore, basis: f.basis, nEffects: f.nEffects, hasPriorRuns: !!t.hasPriorRuns });
  }
  return out;
}

function metrics(rs) {
  const mae = (k) => mean(rs.map((r) => Math.abs(r[k] - r.actual)));
  const hit = (k) => mean(rs.map((r) => (band(r[k]) === band(r.actual) ? 1 : 0)));
  const within10 = (k) => mean(rs.map((r) => (Math.abs(r[k] - r.actual) <= 10 ? 1 : 0)));
  const m = { n: rs.length, maeModel: mae('pred'), maeCategoryMean: mae('catMean'),
    bandHitModel: hit('pred'), bandHitCategoryMean: hit('catMean'),
    within10Model: within10('pred'), within10CategoryMean: within10('catMean') };
  const wp = rs.filter((r) => r.priorScore != null && !r.hasPriorRuns); // priorRuns shows fold earlier reviews into actual
  if (wp.length) {
    const mp = mean(wp.map((r) => Math.abs(r.priorScore - r.actual)));
    m.priorRun = { n: wp.length, maePriorRun: mp, maeModel: mean(wp.map((r) => Math.abs(r.pred - r.actual))),
      maeCategoryMean: mean(wp.map((r) => Math.abs(r.catMean - r.actual))) };
  }
  // calibration: bins of predicted score
  const bins = {};
  for (const r of rs) { const b = Math.floor(r.pred / 5) * 5; (bins[b] ||= []).push(r); }
  m.calibration = Object.keys(bins).sort((a, b) => a - b).map((b) => ({ predBin: `${b}-${+b + 4}`, n: bins[b].length,
    meanPred: mean(bins[b].map((r) => r.pred)), meanActual: mean(bins[b].map((r) => r.actual)) }));
  // Shows with priorRuns/transfers fold earlier-run reviews into `actual`; report a disjoint-review subset too.
  const clean = rs.filter((r) => !r.hasPriorRuns);
  m.cleanSubset = { n: clean.length, maeModel: mean(clean.map((r) => Math.abs(r.pred - r.actual))),
    maeCategoryMean: mean(clean.map((r) => Math.abs(r.catMean - r.actual))) };
  m.bySegment = {};
  for (const c of [...new Set(rs.map((r) => r.category))]) {
    const g = rs.filter((r) => r.category === c);
    m.bySegment[c] = { n: g.length, maeModel: mean(g.map((r) => Math.abs(r.pred - r.actual))),
      maeCategoryMean: mean(g.map((r) => Math.abs(r.catMean - r.actual))) };
  }
  return m;
}

if (require.main === module) {
  const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
  const rows = loadRows();
  const from = arg('from', '2023-01-01');
  const res = backtest(rows, from);
  const m = metrics(res);
  const outPath = arg('json', '/tmp/bro7314/backtest.json');
  const today = new Date().toISOString().slice(0, 10);
  const scored = rows.filter((r) => r.score != null);
  const next = rows.filter((r) => r.openingDate >= today && r.score == null).map((t) => {
    const f = forecast(t, scored); return f && { id: t.id, title: t.title, opening: t.openingDate, category: t.category, pred: Math.round(f.pred), band: band(f.pred), basis: f.basis };
  }).filter(Boolean);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ from, metrics: m, results: res, next }, null, 1));
  console.log(JSON.stringify(m, null, 1));
  console.log('next openings forecast:', next.length);
}
module.exports = { backtest, metrics, loadRows };
