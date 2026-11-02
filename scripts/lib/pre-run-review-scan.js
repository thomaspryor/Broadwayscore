#!/usr/bin/env node
'use strict';
/**
 * pre-run-review-scan.js (BRO-6811) — reviews dated long before the show's first preview.
 *
 * Scan rule: (show start - publishDate) > --days (default 180), show start = previewsStartDate || openingDate.
 * Each show is classed by what legitimises (or not) the old rows:
 *   opera-unflagged   opera show whose priorRuns link has no explicit inheritReviews (owner rule BRO-6767: should be false)
 *   carried-by-link   rows tagged inheritedFromShowId, or dated inside a priorRuns window that carries (transfer / return)
 *   uncovered         old rows with no priorRuns window covering them: candidates for a wrongProduction fix
 * Usage: node scripts/lib/pre-run-review-scan.js [--days=180] [--json]
 */
const path = require('path');
const DAY = 86400000;

function classify({ shows, reviews, days = 180 }) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const per = new Map();
  for (const r of reviews) {
    const s = byId.get(r.showId);
    if (!s || !r.publishDate) continue;
    const start = Date.parse(s.previewsStartDate || s.openingDate || '');
    const pub = Date.parse(r.publishDate);
    if (!Number.isFinite(start) || !Number.isFinite(pub)) continue;
    if ((start - pub) / DAY <= days) continue;
    const runs = Array.isArray(s.priorRuns) ? s.priorRuns : [];
    const inWindow = runs.find((p) => p && p.openingDate && pub >= Date.parse(p.openingDate) - 30 * DAY
      && (!p.closingDate || pub <= Date.parse(p.closingDate) + 60 * DAY));
    let cls;
    if (s.type === 'opera' && runs.some((p) => p && p.id && typeof p.inheritReviews !== 'boolean')) cls = 'opera-unflagged';
    else if (r.inheritedFromShowId || inWindow) cls = 'carried-by-link';
    else cls = 'uncovered';
    const e = per.get(s.id) || { showId: s.id, type: s.type || null, hasPriorRuns: runs.length > 0, rows: 0, inherited: 0, cls: {}, outlets: [] };
    e.rows++; if (r.inheritedFromShowId) e.inherited++;
    e.cls[cls] = (e.cls[cls] || 0) + 1;
    if (e.outlets.length < 4) e.outlets.push(`${r.outletId}:${String(r.publishDate).slice(0, 10)}`);
    per.set(s.id, e);
  }
  return [...per.values()].sort((a, b) => b.rows - a.rows);
}

module.exports = { classify };

if (require.main === module) {
  const { hasHelpFlag } = require('./cli-help.js');
  if (hasHelpFlag(process.argv)) { console.log('Usage: node scripts/lib/pre-run-review-scan.js [--days=180] [--json]'); process.exit(0); }
  const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
  const root = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const sj = require(path.join(root, 'shows.json'));
  const rj = require(path.join(root, 'reviews.json'));
  const out = classify({ shows: sj.shows || sj, reviews: Array.isArray(rj) ? rj : rj.reviews, days: Number(arg('days', 180)) });
  if (process.argv.includes('--json')) console.log(JSON.stringify(out));
  else {
    console.log(`${out.reduce((n, e) => n + e.rows, 0)} reviews over ${out.length} shows`);
    for (const e of out) console.log(`${String(e.rows).padStart(4)}  ${e.showId}  [${e.type || '-'}${e.hasPriorRuns ? ',priorRuns' : ''}] inh=${e.inherited} ${JSON.stringify(e.cls)} ${e.outlets.join(' ')}`);
  }
}
