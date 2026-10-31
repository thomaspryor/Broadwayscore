#!/usr/bin/env node
/**
 * Snapshot audience grades for Tony nominees at a fixed point in time.
 *
 * Tony predictions backtest depends on knowing what audience scores looked
 * like AT TONY VOTING TIME, not years later (when winners have accumulated
 * post-Tony halo ratings). This script captures a snapshot we can use for
 * future evaluation.
 *
 * Usage:
 *   node scripts/snapshot-audience-grades.js                       # current Tony season
 *   node scripts/snapshot-audience-grades.js --season=2025-26
 *   node scripts/snapshot-audience-grades.js --tag=pre-noms        # custom tag (default: ISO date)
 *   node scripts/snapshot-audience-grades.js --include-eligible    # also capture all season-eligible BWY shows (not just current Tony nominees)
 *
 * Output:
 *   data/audience-snapshots/{season}-{tag}.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argMap = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const TONY_CATS = ['Best Musical','Best Play','Best Revival of a Musical','Best Revival of a Play'];
const CAT_SET = new Set(TONY_CATS);

function currentTonySeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  // Tony season X-Y: eligibility runs ~May Y-1 through ~April Y; ceremony in June Y.
  // After June, the next season starts. Before June, current season is (year-1)-year.
  if (month < 6) return `${year-1}-${String(year).slice(2)}`;
  return `${year}-${String(year+1).slice(2)}`;
}

const targetSeason = argMap.season || currentTonySeason();
const tag = argMap.tag || new Date().toISOString().slice(0, 10);

console.log(`Snapshotting audience grades for Tony season ${targetSeason}, tag: ${tag}`);

const awards = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/awards.json'), 'utf8'));
const buzz = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audience-buzz.json'), 'utf8'));
const showsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));

const showsArr = Array.isArray(showsJson) ? showsJson : (showsJson.shows || []);
const titleById = {};
for (const sh of showsArr) {
  if (sh.id && sh.title) titleById[sh.id] = sh.title;
}

const showsObj = awards.shows || awards;
const buzzByShow = buzz.shows || {};

// Tony nominees in 4 main categories for the target season
const nominees = [];
for (const [showId, sh] of Object.entries(showsObj)) {
  const t = sh && sh.tony;
  if (!t || t.season !== targetSeason) continue;
  const noms = (t.nominatedFor || []).filter(c => CAT_SET.has(c));
  if (noms.length === 0) continue;
  for (const cat of noms) {
    nominees.push({ showId, title: titleById[showId] || null, category: cat });
  }
}

// If --include-eligible, also include all Broadway shows opening in season window.
// This is useful pre-nominations when Tony nominees aren't known yet.
let eligibleShows = [];
if (argMap['include-eligible']) {
  const seasonStart = parseInt(targetSeason.split('-')[0]);
  for (const sh of showsArr) {
    if (!sh.openingDate) continue;
    const opened = new Date(sh.openingDate);
    if (isNaN(opened.getTime())) continue;
    // Eligibility window: roughly May Y-1 through April Y for season Y-1/Y
    const inWindow =
      (opened.getFullYear() === seasonStart && opened.getMonth() >= 4) ||
      (opened.getFullYear() === seasonStart + 1 && opened.getMonth() <= 4);
    if (inWindow) eligibleShows.push(sh);
  }
  console.log(`Including ${eligibleShows.length} season-eligible shows by opening date`);
}

if (nominees.length === 0 && eligibleShows.length === 0) {
  console.warn(`No Tony nominees or season-eligible shows found for ${targetSeason}.`);
  console.warn(`If pre-nominations: pass --include-eligible to capture all season shows.`);
  process.exit(0);
}

// Build snapshot — one entry per unique showId
const snapshotShows = {};
const allShowIds = new Set([
  ...nominees.map(n => n.showId),
  ...eligibleShows.map(s => s.id),
]);

for (const showId of allShowIds) {
  const buzzData = buzzByShow[showId];
  const tonyNoms = (showsObj[showId] && showsObj[showId].tony && showsObj[showId].tony.nominatedFor) || [];
  const tonyNomsInMain = tonyNoms.filter(c => CAT_SET.has(c));
  const entry = {
    title: titleById[showId] || null,
    tonyCategoriesNominated: tonyNomsInMain,
    combinedScore: buzzData ? (buzzData.combinedScore ?? null) : null,
    designation: buzzData ? (buzzData.designation ?? null) : null,
    sources: {},
  };
  if (buzzData && buzzData.sources) {
    for (const src of ['showScore','mezzanine','theatr','broadwayCom','reddit']) {
      const s = buzzData.sources[src];
      if (s) {
        entry.sources[src] = {
          score: s.score ?? null,
          reviewCount: s.reviewCount ?? null,
        };
      }
    }
  }
  snapshotShows[showId] = entry;
}

const snapshot = {
  _meta: {
    snapshotAt: new Date().toISOString(),
    snapshotTag: tag,
    tonySeason: targetSeason,
    sourceLastUpdated: buzz._meta && buzz._meta.lastUpdated,
    nomineeCount: nominees.length,
    eligibleShowCount: eligibleShows.length,
    totalShows: Object.keys(snapshotShows).length,
    note: 'Audience grades captured at this point in time. Tony Predictions backtest evaluation should read THIS snapshot rather than live audience-buzz.json (which accumulates post-Tony halo ratings). Re-running on the same day overwrites; tag distinct snapshots with --tag.',
  },
  shows: snapshotShows,
};

const outDir = path.join(ROOT, 'data/audience-snapshots');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${targetSeason}-${tag}.json`);
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

console.log(`\nWrote: ${outPath}`);
console.log(`  Tony nominees in 4 main cats: ${nominees.length}`);
console.log(`  Season-eligible shows:        ${eligibleShows.length}`);
console.log(`  Total shows captured:         ${Object.keys(snapshotShows).length}`);
const withSS = Object.values(snapshotShows).filter(s => s.sources.showScore).length;
const withMz = Object.values(snapshotShows).filter(s => s.sources.mezzanine).length;
const withTh = Object.values(snapshotShows).filter(s => s.sources.theatr).length;
const withRd = Object.values(snapshotShows).filter(s => s.sources.reddit).length;
const withBC = Object.values(snapshotShows).filter(s => s.sources.broadwayCom).length;
console.log(`  Show Score data:    ${withSS}`);
console.log(`  Mezzanine data:     ${withMz}`);
console.log(`  Theatr data:        ${withTh}`);
console.log(`  Reddit data:        ${withRd}`);
console.log(`  Broadway.com data:  ${withBC}`);
