#!/usr/bin/env node
/**
 * Rebuild the critic-vs-audience divergence dataset that powers
 * /research/critic-audience-divergence-2026.
 *
 * Reads the slim show files (public/data/shows/{id}.json) + shows.json and
 * writes public/data/research/critic-audience-divergence-2026.json.
 *
 * The page derives all rendered stats (title count, mean gap, tables,
 * by-market breakdown) from `rows` at build time, so regenerating this file
 * automatically updates the study. The `summary` block is kept in sync here
 * for external consumers who download the JSON directly.
 *
 * Usage: node scripts/build-divergence-dataset.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOWS_DIR = path.join(ROOT, 'public/data/shows');
const SHOWS_JSON = path.join(ROOT, 'data/shows.json');
const OUT_PATH = path.join(ROOT, 'public/data/research/critic-audience-divergence-2026.json');

// Study scope. Regional feeder-market rows (e.g. pre-Broadway tryouts) are
// excluded — the page's category labels and by-market table only know these
// four, and a stray category silently breaks the "N productions" accounting.
const CATEGORIES = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);
const MIN_CRITIC_REVIEWS = 5;
const MIN_AUDIENCE_SAMPLES = 100;

const { shows } = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
const showById = new Map(shows.map(s => [s.id, s]));

const rows = [];
for (const f of fs.readdirSync(SHOWS_DIR)) {
  if (!f.endsWith('.json')) continue;
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path.join(SHOWS_DIR, f), 'utf8'));
  } catch {
    continue;
  }
  if (typeof d.cs !== 'number' || !d.au || typeof d.au.score !== 'number') continue;
  if (!d.rc || d.rc < MIN_CRITIC_REVIEWS) continue;
  const a = d.au.sources || {};
  const totalAud =
    (a.ss?.c || 0) + (a.mz?.c || 0) + (a.bc?.c || 0) + (a.th?.c || 0) + (a.rd?.c || 0);
  if (totalAud < MIN_AUDIENCE_SAMPLES) continue;
  const meta = showById.get(d.id);
  if (!meta || !CATEGORIES.has(meta.category)) continue;

  rows.push({
    id: d.id,
    slug: meta.slug,
    title: meta.title,
    category: meta.category,
    market: meta.market,
    status: meta.status,
    openingDate: meta.openingDate,
    closingDate: meta.closingDate,
    critic: Math.round(d.cs * 10) / 10,
    audience: Math.round(d.au.score * 10) / 10,
    gap: Math.round((d.au.score - d.cs) * 10) / 10,
    reviewCount: d.rc,
    audienceCount: totalAud,
    audienceSources: {
      showScore: a.ss?.c || null,
      mezzanine: a.mz?.c || null,
      boxOffice: a.bc?.c || null,
      theatre: a.th?.c || null,
      reddit: a.rd?.c || null,
    },
    breakdown: d.bd,
  });
}

// Deterministic file order (same tie-breaking as the page) so regeneration
// with unchanged data produces an identical file.
rows.sort((x, y) => x.id.localeCompare(y.id));

const gaps = rows.map(r => r.gap);
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const summary = {
  generated: new Date().toISOString(),
  source:
    'broadwayscorecard.com — scored critic reviews + audience data from Show-Score, Mezzanine, BroadwayBox, TheatreNYC, Reddit',
  thresholds: `Includes Broadway, Off-Broadway, West End, and Off-West End shows with >=${MIN_CRITIC_REVIEWS} critic reviews and >=${MIN_AUDIENCE_SAMPLES} audience samples`,
  count: rows.length,
  meanGap: Math.round(mean(gaps) * 100) / 100,
  meanAbsGap: Math.round(mean(gaps.map(Math.abs)) * 100) / 100,
  audienceHigherCount: gaps.filter(g => g > 0).length,
  criticHigherCount: gaps.filter(g => g < 0).length,
  byCategory: {},
};
for (const cat of CATEGORIES) {
  const subset = rows.filter(r => r.category === cat);
  if (!subset.length) continue;
  const g = subset.map(r => r.gap);
  summary.byCategory[cat] = {
    count: subset.length,
    meanGap: Math.round(mean(g) * 100) / 100,
    audienceHigher: g.filter(x => x > 0).length,
    criticHigher: g.filter(x => x < 0).length,
  };
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify({ summary, rows }, null, 2));
console.log(`Wrote ${OUT_PATH}`);
console.log(
  `${rows.length} rows | meanGap ${summary.meanGap} | audienceHigher ${summary.audienceHigherCount} | criticHigher ${summary.criticHigherCount}`
);
