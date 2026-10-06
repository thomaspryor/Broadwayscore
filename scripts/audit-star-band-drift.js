#!/usr/bin/env node
'use strict';
/**
 * audit-star-band-drift.js (BRO-4770) — corpus inventory of star-publishing
 * reviews in ANCHORED_MARKETS whose LLM score is not anchored to the star's band.
 *
 * Counts, using the canonical predicates (no hand-rolled star logic):
 *   unanchored    needsLateStarReanchor(): high-reliability star, no llmScore.band
 *                 (exactly the set scripts/flag-late-star-reanchor.js flags)
 *   outOfBand     anchored/other files whose llmScore.score sits outside the
 *                 star's band by more than TOL points (humanScoreOutsideStarBand
 *                 predicate), human/adjudicated overrides excluded
 *   alreadyQueued files with needsRescore=true (not counted above)
 *
 * Usage: node scripts/audit-star-band-drift.js [--tol=2] [--json=PATH]
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage:\n  node scripts/audit-star-band-drift.js [--tol=2] [--json=PATH]\n  --help, -h   print this usage and exit'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { needsLateStarReanchor } = require('./lib/late-star-anchor');
const { humanScoreOutsideStarBand } = require('./lib/human-score-star-guard');
const { shouldUseAnchoredMode } = require('./lib/star-reliability');

const ROOT = path.join(__dirname, '..');
const tolArg = process.argv.find(a => a.startsWith('--tol='));
const TOL = tolArg ? Number(tolArg.split('=')[1]) : 2;
const jsonArg = process.argv.find(a => a.startsWith('--json='));

const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = new Map(showsArr.filter(s => s && s.id).map(s => [s.id, s]));

const out = { scanned: 0, alreadyQueued: 0, unanchored: [], outOfBand: [] };
for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', '*', '*.json'))) {
  const showId = path.basename(path.dirname(f));
  const show = showById.get(showId);
  if (!show) continue;
  const category = show.market || show.category;
  if (!shouldUseAnchoredMode({ category, envFlag: false })) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  out.scanned++;
  const rel = `${showId}/${path.basename(f)}`;
  if (d.needsRescore === true) { out.alreadyQueued++; continue; }
  if (needsLateStarReanchor(d, { category, show, filePath: f })) { out.unanchored.push(rel); continue; }
  const s = d.llmScore && d.llmScore.score;
  if (typeof s === 'number' && d.humanReviewScore == null && d.adjudicatedScore == null) {
    const v = humanScoreOutsideStarBand(d, s);
    if (v && (s < v.floor - TOL || s > v.ceiling + TOL)) out.outOfBand.push(`${rel} score=${s} star=${v.starsRaw} band=${v.floor}-${v.ceiling}`);
  }
}
console.log(`scanned=${out.scanned} alreadyQueued=${out.alreadyQueued} unanchored=${out.unanchored.length} outOfBand=${out.outOfBand.length}`);
if (jsonArg) fs.writeFileSync(jsonArg.split('=')[1], JSON.stringify(out, null, 2));
