#!/usr/bin/env node
'use strict';
/**
 * audit-stale-slot-squatters.js (BRO-5501): report review-text files that
 * silently cost a show a good review (rules: scripts/lib/stale-slot-squatters.js).
 * Advisory: exits 0 unless --strict (CLAUDE.md §19: new gates land advisory first).
 *
 *   node scripts/audit-stale-slot-squatters.js [--show=a,b] [--min-year=2026] [--json] [--strict]
 *
 * Env: REVIEW_TEXTS_DIR, SHOWS_JSON_PATH.
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { findDroppedByWrongTwin, findStaleSlotSquatters, normalizeUrl: norm } = require('./lib/stale-slot-squatters');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log('audit-stale-slot-squatters.js [--show=a,b] [--min-year=2026] [--json] [--strict] [--all]');
  process.exit(0);
}
const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS = process.env.SHOWS_JSON_PATH || path.join(__dirname, '..', 'data', 'shows.json');
const onlyShows = arg('show') ? arg('show').split(',') : null;
const minYear = Number(arg('min-year') || 2026);

const shows = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
const byId = {};
for (const s of Array.isArray(shows) ? shows : shows.shows || Object.values(shows)) if (s && s.id) byId[s.id] = s;

const tree = new Map();
const urlOwners = new Map();
let scanned = 0;
for (const showId of listShowDirs(ROOT)) {
  if (showId.startsWith('_')) continue;
  const dir = path.join(ROOT, showId);
  const files = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      files.push({ file: f, data });
      scanned++;
      if (data.url) {
        const k = norm(data.url);
        if (!urlOwners.has(k)) urlOwners.set(k, new Set());
        urlOwners.get(k).add(showId);
      }
    } catch { /* unreadable file: skip */ }
  }
  tree.set(showId, files);
}
try { assertCorpusScanned(scanned, { gate: true, label: ROOT }); } catch (e) {
  if (e instanceof CorpusNotScannedError) { console.error(`::error::${e.message}`); process.exit(1); }
  throw e;
}

const REVIEWS = process.env.REVIEWS_JSON_PATH || path.join(__dirname, '..', 'data', 'reviews.json');
const haveOutlet = new Set();
try {
  const rj = JSON.parse(fs.readFileSync(REVIEWS, 'utf8'));
  for (const r of Array.isArray(rj) ? rj : rj.reviews || []) if (r && r.showId && r.outletId) haveOutlet.add(`${r.showId}|${r.outletId}`);
} catch { /* no reviews.json: cannot tell, so keep every finding */ }
const slotEmpty = (showId, f) => !haveOutlet.size || !haveOutlet.has(`${showId}|${(f.outletId || String(f.file).split('--')[0])}`);

const found = [];
for (const [showId, files] of tree) {
  if (onlyShows && !onlyShows.includes(showId)) continue;
  const show = byId[showId];
  if (!show || !show.openingDate || Number(String(show.openingDate).slice(0, 4)) < minYear) continue;
  for (const r of findDroppedByWrongTwin(files)) if (argv.includes('--all') || slotEmpty(showId, { ...r, outletId: (files.find((x) => x.file === r.file).data || {}).outletId })) found.push({ showId, ...r });
  for (const r of findStaleSlotSquatters(files, show, urlOwners, showId)) if (argv.includes('--all') || slotEmpty(showId, r)) found.push({ showId, ...r });
}
if (argv.includes('--json')) console.log(JSON.stringify({ scanned, count: found.length, found }, null, 2));
else {
  console.log(`Scanned ${scanned} files; ${found.length} finding(s) in shows opening ${minYear}+.`);
  for (const f of found) console.log(`  ${f.kind} ${f.showId}/${f.file}${f.twin ? ` -> ${f.twin} (${f.twinFlag})` : ` ${f.publishDate} ${f.url}`}`);
}
if (argv.includes('--strict') && found.length) process.exit(1);
