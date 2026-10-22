#!/usr/bin/env node
/**
 * audit-star-bands.js: full-coverage check that every review with an N/5 star
 * rating scores inside its CLAUDE.md §3 band (1/5 0-30, 2/5 31-50, 3/5 51-70,
 * 4/5 71-90, 5/5 91-100; half stars accept the union of both neighbours).
 * No model calls, no review text. Per cohort (BRO-5951). `--json` for rows.
 */
'use strict';
const fs = require('fs');
const path = require('path');
if (require('./lib/cli-help.js').hasHelpFlag(process.argv.slice(2))) { console.log('audit-star-bands.js [--json]: star rating vs score-band check per historical cohort (read-only)'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const BANDS = { 1: [0, 30], 2: [31, 50], 3: [51, 70], 4: [71, 90], 5: [91, 100] };

function starsOf(r) {
  const m = /^\s*(\d(?:\.\d)?)\s*\/\s*5\b/.exec(String(r.originalRating == null ? '' : r.originalRating));
  return m ? Number(m[1]) : null;
}
function bandFor(stars) {
  const lo = Math.floor(stars); const hi = Math.ceil(stars);
  if (!BANDS[lo] && !BANDS[hi]) return null;
  const a = BANDS[lo] || BANDS[hi]; const b = BANDS[hi] || BANDS[lo];
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}
function cohortOf(show) {
  if (!show) return 'unknown';
  const ds = String(show.discoverySource || '');
  if (ds.startsWith('we-historical')) return `we-${show.season}`;
  if (Array.isArray(show.tags) && show.tags.includes('historical')) return show.category === 'off-broadway' ? 'ob-historical' : 'bw-historical';
  return `other-${show.market || 'bw'}`;
}
function audit(reviews, shows) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const per = {}; const bad = [];
  for (const r of reviews) {
    const stars = starsOf(r); if (stars == null) continue;
    const band = bandFor(stars); if (!band) continue;
    const c = cohortOf(byId.get(r.showId)); const p = (per[c] = per[c] || { starred: 0, outOfBand: 0 });
    p.starred++;
    if (r.assignedScore < band[0] || r.assignedScore > band[1]) { p.outOfBand++; bad.push({ cohort: c, showId: r.showId, outletId: r.outletId, url: r.url, stars, score: r.assignedScore, band, scoreSource: r.scoreSource }); }
  }
  return { per, bad };
}
module.exports = { starsOf, bandFor, cohortOf, audit };

if (require.main === module) {
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8')).reviews;
  const sj = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const { per, bad } = audit(reviews, Array.isArray(sj) ? sj : sj.shows);
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ per, bad }, null, 1)); process.exit(0); }
  for (const [c, p] of Object.entries(per).sort()) console.log(`${c}\tstarred ${p.starred}\tout of band ${p.outOfBand} (${((100 * p.outOfBand) / p.starred).toFixed(1)}%)`);
  const bySrc = {}; for (const b of bad) bySrc[b.scoreSource] = (bySrc[b.scoreSource] || 0) + 1;
  console.log('out-of-band by scoreSource', JSON.stringify(bySrc));
}
