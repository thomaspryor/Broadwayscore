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
 *   publishedOutOfBand (BRO-4839) the score actually PUBLISHED in data/reviews.json contradicts the critic's own
 *                 high-reliability rating (or every model's unanimous bucket), whatever produced it: adjudication,
 *                 human override, relayed rating. Joined to the review-text file by showId + normalised URL, in ALL
 *                 markets. This is the check the llmScore-only inventory above could not make.
 *
 * Usage: node scripts/audit-star-band-drift.js [--tol=2] [--json=PATH] [--strict]
 *   --strict   exit 1 when any publishedOutOfBand row exists (CI/health use once the backlog is triaged)
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage:\n  node scripts/audit-star-band-drift.js [--tol=2] [--json=PATH] [--strict]\n  --strict     exit 1 when a published score is out of band, or when no published score could be joined\n  --help, -h   print this usage and exit'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { needsLateStarReanchor } = require('./lib/late-star-anchor');
const { humanScoreOutsideStarBand } = require('./lib/human-score-star-guard');
const { shouldUseAnchoredMode } = require('./lib/star-reliability');
const { publishedScoreViolation } = require('./lib/published-score-star-band');
const { canonicalizeUrlForDedup } = require('./lib/review-guards');

const ROOT = path.join(__dirname, '..');
const tolArg = process.argv.find(a => a.startsWith('--tol='));
const TOL = tolArg ? Number(tolArg.split('=')[1]) : 2;
const jsonArg = process.argv.find(a => a.startsWith('--json='));

const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = new Map(showsArr.filter(s => s && s.id).map(s => [s.id, s]));

// Published scores: reviews.json is the source of truth for what the site shows.
const published = new Map();
try {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reviews.json'), 'utf8'));
  for (const r of doc.reviews || []) {
    if (!r || !r.showId || !r.url || typeof r.assignedScore !== 'number') continue;
    published.set(`${r.showId}|${canonicalizeUrlForDedup(r.url)}`, { score: r.assignedScore, source: r.scoreSource || 'unknown' });
  }
} catch { /* no reviews.json: the published check reports 0 joined rows, which the summary line makes visible */ }

const out = { scanned: 0, alreadyQueued: 0, unanchored: [], outOfBand: [], publishedJoined: 0, publishedOutOfBand: [] };
for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', '*', '*.json'))) {
  const showId = path.basename(path.dirname(f));
  const show = showById.get(showId);
  if (!show) continue;
  const category = show.market || show.category;
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const rel = `${showId}/${path.basename(f)}`;
  // Published-score check first: it applies in every market, unlike the anchored-market inventory below.
  const pub = d.url ? published.get(`${showId}|${canonicalizeUrlForDedup(d.url)}`) : null;
  if (pub) {
    out.publishedJoined++;
    const v = publishedScoreViolation(d, pub.score, { tol: TOL });
    if (v) out.publishedOutOfBand.push({ file: rel, score: pub.score, source: pub.source, kind: v.kind, detail: v.detail });
  }
  if (!shouldUseAnchoredMode({ category, envFlag: false })) continue;
  out.scanned++;
  if (d.needsRescore === true) { out.alreadyQueued++; continue; }
  if (needsLateStarReanchor(d, { category, show, filePath: f })) { out.unanchored.push(rel); continue; }
  const s = d.llmScore && d.llmScore.score;
  if (typeof s === 'number' && d.humanReviewScore == null && d.adjudicatedScore == null) {
    const v = humanScoreOutsideStarBand(d, s);
    if (v && (s < v.floor - TOL || s > v.ceiling + TOL)) out.outOfBand.push(`${rel} score=${s} star=${v.starsRaw} band=${v.floor}-${v.ceiling}`);
  }
}
const bySource = {};
for (const r of out.publishedOutOfBand) bySource[r.source] = (bySource[r.source] || 0) + 1;
console.log(`scanned=${out.scanned} alreadyQueued=${out.alreadyQueued} unanchored=${out.unanchored.length} outOfBand=${out.outOfBand.length}`);
console.log(`published: joined=${out.publishedJoined} outOfBand=${out.publishedOutOfBand.length} bySource=${JSON.stringify(bySource)}`);
if (jsonArg) fs.writeFileSync(jsonArg.split('=')[1], JSON.stringify(out, null, 2));
if (process.argv.includes('--strict') && (out.publishedOutOfBand.length || out.publishedJoined === 0)) process.exit(1);
