#!/usr/bin/env node
/**
 * audit-outlet-tiers.js — outlet tier audit (BRO-4907, 2026-10).
 *
 * Read-only: never writes src/config/outlet-tiers.json. Proposed tier moves
 * are simulated against an in-memory copy (scripts/lib/outlet-tier-audit.js
 * loadScorerWithTiers).
 *
 * Usage:
 *   node scripts/audit-outlet-tiers.js --stats-out=<file.json>
 *       Volume stats for every configured outlet + every unconfigured outlet
 *       with >= --min-reviews (default 5). Input for writing justifications.
 *   node scripts/audit-outlet-tiers.js --signals-out=<file.json>
 *       Volume stats plus non-volume evidence per outlet (Show Score pickup,
 *       agreement with T1/T2 consensus, critic crossover). Input for research.
 *   node scripts/audit-outlet-tiers.js --justifications=<file.json> \
 *       --csv=<out.csv> --impact-out=<out.json>
 *       Merge stats with justifications/proposals, write the CSV, and
 *       simulate the critic-score impact of every proposed move.
 *
 * Justifications file: { "<outletId>": { "proposedNyc": 1-4, "proposedLondon": 1-4,
 *   "justification": "...", "sources": ["https://..."] } }
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const {
  computeOutletStats,
  computeQualitySignals,
  corpusYearTotals,
  regionOf,
  resolveCurrentTier,
  simulateImpact,
} = require('./lib/outlet-tier-audit');

const ROOT = path.join(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const MIN_REVIEWS = Number(args['min-reviews'] || 5);

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function loadInputs() {
  const reviewsRaw = readJson('data/reviews.json');
  const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : reviewsRaw.reviews;
  const showsRaw = readJson('data/shows.json');
  const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
  const regRaw = readJson('data/outlet-registry.json');
  const registry = regRaw.outlets || regRaw;
  const tiersConfig = readJson('src/config/outlet-tiers.json');
  return { reviews, shows, registry, tiersConfig };
}

function buildSignals({ reviews, shows, registry, tiersConfig }) {
  const { normalizeOutlet } = require('./lib/review-normalization');
  const showScore = readJson('data/show-score.json');
  const categoryByShow = Object.fromEntries(shows.map(s => [s.id, s.category]));
  return computeQualitySignals({
    reviews,
    showScoreShows: showScore.shows || {},
    normalizeOutlet,
    categoryByShow,
    tierOf: (id, region) => resolveCurrentTier(id, tiersConfig, registry)[region],
  });
}

function buildRows({ reviews, shows, registry, tiersConfig }) {
  const categoryByShow = Object.fromEntries(shows.map(s => [s.id, s.category]));
  const yearTotals = corpusYearTotals(reviews);
  const stats = computeOutletStats(reviews, { categoryByShow, yearTotals });
  const ids = new Set(Object.keys(tiersConfig));
  for (const [id, s] of stats) if (s.total >= MIN_REVIEWS) ids.add(id);
  const rows = [];
  for (const id of ids) {
    const s = stats.get(id) || {
      outletId: id, total: 0, dated: 0, undated: 0, first: null, last: null, activeYears: 0,
      meanPerYear: null, medianPerYear: null, medianPerMonth: null, normalizedShare: null,
      share2015_19: null, share2022plus: null, count2015_19: 0, count2022plus: 0,
      nycReviews: 0, londonReviews: 0, perYear: {},
    };
    const cfg = tiersConfig[id] || {};
    const reg = registry[id] || {};
    rows.push({
      ...s,
      name: cfg.name || reg.displayName || id,
      domain: reg.domain || null,
      region: reg.region || null,
      current: resolveCurrentTier(id, tiersConfig, registry),
    });
  }
  rows.sort((a, b) => (b.normalizedShare || 0) - (a.normalizedShare || 0));
  return { rows, yearTotals };
}

const CSV_COLUMNS = [
  'outletId', 'name', 'tierSource', 'currentTierNyc', 'currentTierLondon',
  'proposedTierNyc', 'proposedTierLondon', 'change', 'total', 'dated', 'undated',
  'first', 'last', 'activeYears', 'meanPerYear', 'medianPerYear', 'medianPerMonth',
  'normalizedShare', 'share2015_19', 'share2022plus', 'nycReviews', 'londonReviews',
  'justification', 'sources',
];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmt(n, digits) {
  return n == null ? '' : Number(n.toFixed(digits));
}

function changeLabel(row, j) {
  const c = row.current;
  if (j.proposedNyc === c.nyc && j.proposedLondon === c.london) {
    return c.source === 'config' ? 'keep' : `keep (${c.source})`;
  }
  const up = j.proposedNyc < c.nyc || j.proposedLondon < c.london;
  const down = j.proposedNyc > c.nyc || j.proposedLondon > c.london;
  const dir = up && down ? 'regional split' : up ? 'move up' : 'move down';
  return c.source === 'config' ? dir : `configure (${dir})`;
}

function toCsv(rows, justifications) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const j = justifications[r.outletId];
    lines.push([
      r.outletId, r.name, r.current.source, r.current.nyc, r.current.london,
      j.proposedNyc, j.proposedLondon, changeLabel(r, j), r.total, r.dated, r.undated,
      r.first, r.last, r.activeYears, fmt(r.meanPerYear, 2), fmt(r.medianPerYear, 1),
      fmt(r.medianPerMonth, 1), fmt(r.normalizedShare, 5), fmt(r.share2015_19, 5),
      fmt(r.share2022plus, 5), r.nycReviews, r.londonReviews, j.justification,
      (j.sources || []).join(' '),
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

function publishedScore(showId) {
  // Same field and rounding as getCriticScore() in scripts/lib/canonical-critic-scores.ts.
  const p = path.join(ROOT, 'public', 'data', 'shows', `${showId}.json`);
  if (!fs.existsSync(p)) return null;
  const cs = JSON.parse(fs.readFileSync(p, 'utf8')).cs;
  return typeof cs === 'number' ? Math.round(cs) : null;
}

function summarize(moved) {
  const abs = moved.map(m => Math.abs(m.delta));
  return {
    showsMoved: moved.length,
    showsMovedOnePointPlus: moved.filter(m => Math.round(m.after) !== Math.round(m.before)).length,
    maxAbsDelta: abs.length ? Math.max(...abs) : 0,
    meanAbsDelta: abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : 0,
  };
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    const src = fs.readFileSync(__filename, 'utf8');
    console.log(src.slice(src.indexOf(' * Usage:'), src.indexOf(' */')).replace(/^ \* ?/gm, ''));
    return;
  }
  const inputs = loadInputs();
  const { rows, yearTotals } = buildRows(inputs);

  if (args['stats-out']) {
    fs.writeFileSync(args['stats-out'], JSON.stringify({ yearTotals, rows }, null, 2));
    console.log(`wrote ${rows.length} outlet rows to ${args['stats-out']}`);
    return;
  }

  if (args['signals-out']) {
    const signals = buildSignals(inputs);
    const merged = rows.map(r => {
      const { perYear, ...rest } = r;
      return { ...rest, ...(signals.get(r.outletId) || {}) };
    });
    fs.writeFileSync(args['signals-out'], JSON.stringify(merged, null, 2));
    console.log(`wrote ${merged.length} outlet rows with signals to ${args['signals-out']}`);
    return;
  }

  if (!args.justifications) {
    console.error('need --stats-out=<file> or --justifications=<file>');
    process.exit(1);
  }
  const justifications = JSON.parse(fs.readFileSync(args.justifications, 'utf8'));
  const missing = rows.filter(r => {
    const j = justifications[r.outletId];
    const validTier = t => Number.isInteger(t) && t >= 1 && t <= 4;
    return !j || !j.justification || !j.justification.trim() || !validTier(j.proposedNyc) || !validTier(j.proposedLondon);
  });
  if (missing.length) {
    console.error(`${missing.length} outlets lack a justification or an integer 1-4 proposedNyc/proposedLondon: ${missing.slice(0, 20).map(r => r.outletId).join(', ')}`);
    process.exit(1);
  }

  if (args.csv) {
    fs.writeFileSync(args.csv, toCsv(rows, justifications));
    console.log(`wrote ${rows.length} rows to ${args.csv}`);
  }

  const proposals = rows
    .filter(r => {
      const j = justifications[r.outletId];
      return j.proposedNyc !== r.current.nyc || j.proposedLondon !== r.current.london;
    })
    .map(r => ({
      outletId: r.outletId,
      name: r.name,
      change: changeLabel(r, justifications[r.outletId]),
      fromNyc: r.current.nyc,
      fromLondon: r.current.london,
      nyc: justifications[r.outletId].proposedNyc,
      london: justifications[r.outletId].proposedLondon,
    }));

  const perProposal = proposals.map(p => {
    const moved = simulateImpact({ ...inputs, proposals: [p] });
    return { ...p, ...summarize(moved) };
  });
  const combined = simulateImpact({ ...inputs, proposals });
  const topMovers = [...combined]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 25)
    .map(m => ({ ...m, published: publishedScore(m.showId) }));

  const impact = {
    generatedAt: new Date().toISOString(),
    method: 'scripts/lib/compute-critic-score.js on data/reviews.json, in-memory tier swap',
    perProposal,
    combined: summarize(combined),
    topMovers,
  };
  if (args['impact-out']) fs.writeFileSync(args['impact-out'], JSON.stringify(impact, null, 2));
  console.log(`${proposals.length} proposed moves; combined: ${JSON.stringify(impact.combined)}`);
}

if (require.main === module) main();

module.exports = { buildRows, buildSignals, toCsv, changeLabel, CSV_COLUMNS };
