'use strict';

/**
 * cost-index-backtest.js — the BRO-4989 cost-index backtest (pure core of
 * scripts/backtest-cost-index.js). Predicts each later public weekly cost
 * figure from the same show's earlier one, carried by the Broadway cost index.
 */

const fs = require('fs');
const path = require('path');
const { carry } = require('./cost-for-week');

const DATA = path.join(__dirname, '..', '..', 'data');
const MAX_MEDIAN_ERROR = 0.15;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {Record<string, object[]>} series - slug -> anchors
 * @returns {{ pairs: object[], bounds: object[], medianAbsError: number|null }}
 */
function backtest(series) {
  const pairs = [];
  const bounds = [];
  for (const [slug, list] of Object.entries(series)) {
    const xs = (list || [])
      .filter((a) => a.dateBasis !== 'migrated' && a.kind === 'running-cost')
      .sort((a, b) => a.asOf.localeCompare(b.asOf));
    for (let i = 1; i < xs.length; i++) {
      // Predict from the nearest earlier point figure (a floor cannot predict).
      const from = [...xs.slice(0, i)].reverse().find((a) => a.bound !== 'min');
      const to = xs[i];
      if (!from || from.asOf === to.asOf) continue;
      const predicted = Math.round(carry(from.amount, from.asOf, to.asOf));
      const row = { slug, from: `${from.asOf} $${from.amount}`, to: `${to.asOf} $${to.amount}`, predicted };
      if (to.bound === 'min') bounds.push({ ...row, ok: predicted >= to.amount });
      else pairs.push({ ...row, error: Math.round((predicted / to.amount - 1) * 1000) / 1000 });
    }
  }
  return { pairs, bounds, medianAbsError: median(pairs.map((p) => Math.abs(p.error))) };
}

function loadSeries() {
  const seeds = JSON.parse(fs.readFileSync(path.join(DATA, 'cost-anchor-seeds.json'), 'utf8'));
  const series = { ...seeds.anchors, ...seeds.uncatalogued };
  try {
    const comm = JSON.parse(fs.readFileSync(path.join(DATA, 'commercial.json'), 'utf8'));
    for (const [slug, rec] of Object.entries(comm.shows || comm)) {
      const hist = (rec.costHistory || []).filter((a) => a.dateBasis !== 'migrated');
      if (hist.length >= 2) series[slug] = [...(series[slug] || []), ...hist];
    }
  } catch { /* commercial.json is private; seeds alone still backtest */ }
  return series;
}

module.exports = { backtest, loadSeries, median, MAX_MEDIAN_ERROR };
