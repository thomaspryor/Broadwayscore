#!/usr/bin/env node
'use strict';
/**
 * BRO-5081 review fact-check, step 1: draw the stratified sample.
 *
 * Universe = reviews that count on the live site: rows in the slim show files
 * (public/data/shows/{id}.json `rv`, the input to the published `cs`) joined to
 * data/reviews.json and to their review-text file. Two strata:
 *   we-historical  shows with discoverySource we-historical:* (WOS/TR backfill)
 *   bw-historical  Broadway-category shows that opened before 2022
 * Weighted toward T1/T2 (weights 4/2/1), at most 3 picks per show, fixed seed.
 * Each pick records its draw weight so rates can be re-weighted to the stratum.
 *
 * venue-write-guard-ok: copies show.venue into the audit sample for the checkers' prompt; never written to shows.json.
 *
 * Usage: node scripts/review-factcheck/sample.js [--seed=5081] [--n=150] [--out=data/audit/review-factcheck/sample.json]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const SEED = Number(args.seed || 5081);
const N = Number(args.n || 150);
const OUT = path.resolve(ROOT, args.out || 'data/audit/review-factcheck/sample.json');
const TIER_WEIGHT = { 1: 4, 2: 2, 3: 1, 4: 1 };
const PER_SHOW_CAP = 3;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stratumOf(show) {
  if (String(show.discoverySource || '').startsWith('we-historical')) return 'we-historical';
  // Intentionally NOT isBroadwayCategory: that treats a missing category as
  // Broadway, and this stratum must be only rows explicitly filed as Broadway.
  if (show.market === 'broadway' && show.category === 'broadway' && show.openingDate && show.openingDate < '2022-01-01') return 'bw-historical';
  return null;
}

const normUrl = u => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

function main() {
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8')).reviews;
  const byShowUrl = new Map();
  const keyOf = (showId, url, outlet, critic) => url ? `${showId}|${normUrl(url)}` : `${showId}||${String(outlet).toLowerCase()}|${String(critic).toLowerCase()}`;
  for (const r of reviews) byShowUrl.set(keyOf(r.showId, r.url, r.outlet, r.criticName), r);

  const universe = { 'we-historical': [], 'bw-historical': [] };
  for (const show of shows) {
    const stratum = stratumOf(show);
    if (!stratum) continue;
    const slimPath = path.join(ROOT, 'public/data/shows', show.id + '.json');
    if (!fs.existsSync(slimPath)) continue;
    const slim = JSON.parse(fs.readFileSync(slimPath, 'utf8'));
    if (typeof slim.cs !== 'number') continue;
    const dir = path.join(ROOT, 'data/review-texts', show.id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    let fileIndex = null;
    for (const rv of slim.rv || []) {
      if (typeof rv.s !== 'number') continue;
      const row = byShowUrl.get(keyOf(show.id, rv.u, rv.o, rv.cn));
      if (!row) continue;
      if (!fileIndex) {
        fileIndex = new Map();
        for (const f of files) {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            fileIndex.set(keyOf(show.id, j.url, j.outlet, j.criticName), f);
          } catch { /* unreadable file: skip */ }
        }
      }
      universe[stratum].push({
        showId: show.id, showTitle: show.title, venue: show.venue, openingDate: show.openingDate,
        stratum, tier: rv.t || 3, outlet: rv.o, outletId: row.outletId, criticName: rv.cn,
        publishDate: rv.d, score: rv.s, bucket: rv.b, scoreSource: row.scoreSource,
        originalRating: row.originalRating || null, url: rv.u || null, reviewFile: fileIndex.get(keyOf(show.id, rv.u, rv.o, rv.cn)) || null,
      });
    }
  }

  const rand = mulberry32(SEED);
  const sample = [];
  const population = {};
  for (const [stratum, rows] of Object.entries(universe)) {
    rows.sort((a, b) => (a.showId + a.url).localeCompare(b.showId + b.url));
    population[stratum] = { total: rows.length, byTier: {} };
    for (const r of rows) population[stratum].byTier[r.tier] = (population[stratum].byTier[r.tier] || 0) + 1;
    // Efraimidis-Spirakis weighted sampling without replacement.
    const keyed = rows.map(r => ({ r, k: Math.pow(rand(), 1 / (TIER_WEIGHT[r.tier] || 1)) })).sort((a, b) => b.k - a.k);
    const perShow = {};
    let taken = 0;
    for (const { r } of keyed) {
      if (taken >= N) break;
      if ((perShow[r.showId] || 0) >= PER_SHOW_CAP) continue;
      perShow[r.showId] = (perShow[r.showId] || 0) + 1;
      sample.push({ sampleId: `${stratum === 'we-historical' ? 'WE' : 'BW'}-${String(taken + 1).padStart(3, '0')}`, ...r, drawWeight: TIER_WEIGHT[r.tier] || 1 });
      taken++;
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ seed: SEED, perStratum: N, tierWeights: TIER_WEIGHT, perShowCap: PER_SHOW_CAP, generatedAt: new Date().toISOString(), population, sample }, null, 2) + '\n');
  const summary = {};
  for (const s of sample) summary[s.stratum + ' T' + s.tier] = (summary[s.stratum + ' T' + s.tier] || 0) + 1;
  console.log(JSON.stringify({ out: path.relative(ROOT, OUT), population, sampled: sample.length, summary, missingFile: sample.filter(s => !s.reviewFile).length }, null, 2));
}

if (require.main === module) main();
module.exports = { stratumOf, mulberry32, normUrl };
