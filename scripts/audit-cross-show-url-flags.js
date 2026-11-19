#!/usr/bin/env node
'use strict';
/**
 * audit-cross-show-url-flags.js (BRO-7815): list review files whose
 * "Same URL correctly belongs in <other>" wrongProduction flag is contradicted
 * by the file's own evidence (rules: classifyCrossShowUrlFlag in
 * scripts/lib/url-cross-production.js). Such a flag hides a real review.
 *
 * Advisory: exits 0 unless --strict (CLAUDE.md §19). Files a person already
 * read and kept flagged are listed in data/audit/cross-show-url-flags-reviewed.json
 * ({ "<show>/<file>.json": "<why the flag stands>" }) and are not reported again.
 *
 *   node scripts/audit-cross-show-url-flags.js [--show=a,b] [--json] [--strict] [--all]
 *
 * --all also prints suspects already in the reviewed list.
 * Env: REVIEW_TEXTS_DIR, SHOWS_JSON_PATH, CROSS_SHOW_URL_REVIEWED_PATH.
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { classifyCrossShowUrlFlag } = require('./lib/url-cross-production');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log('audit-cross-show-url-flags.js [--show=a,b] [--json] [--strict] [--all]');
  process.exit(0);
}
const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS = process.env.SHOWS_JSON_PATH || path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWED = process.env.CROSS_SHOW_URL_REVIEWED_PATH
  || path.join(__dirname, '..', 'data', 'audit', 'cross-show-url-flags-reviewed.json');
const onlyShows = arg('show') ? new Set(arg('show').split(',')) : null;

const showsRaw = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
const byId = {};
for (const s of Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || Object.values(showsRaw)) if (s && s.id) byId[s.id] = s;
let reviewed = {};
try { reviewed = JSON.parse(fs.readFileSync(REVIEWED, 'utf8')); } catch { /* none yet */ }

let scanned = 0;
let flagged = 0;
const suspects = [];
for (const showId of listShowDirs(ROOT)) {
  if (showId.startsWith('_')) continue;
  if (onlyShows && !onlyShows.has(showId)) continue;
  let names = [];
  try { names = fs.readdirSync(path.join(ROOT, showId)); } catch { continue; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    scanned++;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(ROOT, showId, name), 'utf8')); } catch { continue; }
    const r = classifyCrossShowUrlFlag(data, byId[showId], byId[data.wrongProductionNote ? (String(data.wrongProductionNote).match(/belongs in (\S+)/) || [])[1] : '']);
    if (!r.flagged) continue;
    flagged++;
    if (!r.suspect) continue;
    const key = `${showId}/${name}`;
    suspects.push({ file: key, otherShowId: r.otherShowId, publishDate: data.publishDate || null, reasons: r.reasons, reviewed: Object.prototype.hasOwnProperty.call(reviewed, key) });
  }
}
try { assertCorpusScanned(scanned, { gate: !onlyShows, label: ROOT }); } catch (e) {
  if (e instanceof CorpusNotScannedError) { console.error(`::error::${e.message}`); process.exit(1); }
  throw e;
}

const fresh = suspects.filter((s) => !s.reviewed);
const shown = argv.includes('--all') ? suspects : fresh;
if (argv.includes('--json')) {
  console.log(JSON.stringify({ scanned, flagged, suspects: suspects.length, unreviewed: fresh.length, items: shown }, null, 2));
} else {
  console.log(`cross-show URL flags: ${flagged} files carry "Same URL correctly belongs in"; ${suspects.length} contradicted by their own evidence (${fresh.length} not yet reviewed).`);
  for (const s of shown) {
    console.log(`  ${s.reviewed ? '(reviewed) ' : ''}${s.file} -> ${s.otherShowId} | date=${s.publishDate} | ${s.reasons.join(', ')}`);
  }
  if (fresh.length) {
    console.log('Read each text. Wrong flag: clear it with scripts/new-fix-plan.js --review-edit=<file>:wrongProduction=false. Flag stands: add the file to data/audit/cross-show-url-flags-reviewed.json with the reason.');
  }
}
if (argv.includes('--strict') && fresh.length) process.exit(1);
