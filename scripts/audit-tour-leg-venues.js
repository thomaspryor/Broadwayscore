#!/usr/bin/env node
/**
 * audit-tour-leg-venues.js — report-only corpus audit for BRO-2278.
 *
 * For every West End / Off-West End show with a declared venue, runs
 * production-verifier.js's findOtherTourLegVenue over each review-text file
 * that is not already excluded (wrongProduction / wrongShow / isNonReview) and
 * reports the ones that place the production at a different UK touring or
 * regional venue: reviews of another leg of a tour sitting on this show page.
 * Writes nothing. Clearing or flagging a hit is a hand-verified data fix.
 *
 * Usage:
 *   node scripts/audit-tour-leg-venues.js [--show=ID] [--json] [--context]
 *   --context  also print ~240 chars of review text around each match
 *              (review text: only through cloud-run-script's sealed output)
 * Exit 0 always (report-only), 1 when the corpus could not be read.
 */
'use strict';

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { findOtherTourLegVenue, declaredRunVenues } = require('./lib/production-verifier');

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR
  ? path.resolve(process.env.REVIEW_TEXTS_DIR)
  : path.join(ROOT, 'data', 'review-texts');
const SHOWS_PATH = process.env.SHOWS_PATH || path.join(ROOT, 'data', 'shows.json');
const UK_CATEGORIES = new Set(['west-end', 'off-west-end']);

function isExcluded(d) {
  return d.wrongProduction === true || d.wrongShow === true || d.isNonReview === true;
}

function audit({ showFilter = null } = {}) {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = (Array.isArray(raw) ? raw : raw.shows)
    .filter((s) => UK_CATEGORIES.has(s.category) && s.venue && (!showFilter || s.id === showFilter));
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) throw new Error(`review-texts not found at ${REVIEW_TEXTS_DIR}`);
  let scanned = 0;
  const hits = [];
  for (const show of shows) {
    const dir = path.join(REVIEW_TEXTS_DIR, show.id);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => isReviewTextFile(f)); } catch { continue; }
    for (const file of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (isExcluded(d)) continue;
      const text = d.fullText || d.excerpt;
      if (!text) continue;
      scanned++;
      const m = findOtherTourLegVenue(text, show.venue, declaredRunVenues(show));
      if (m) hits.push({ showId: show.id, file, showVenue: show.venue, matchedVenue: m.otherVenue, context: m.context });
    }
  }
  return { shows: shows.length, scanned, hits };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  const showArg = argv.find((a) => a.startsWith('--show='));
  let res;
  try { res = audit({ showFilter: showArg ? showArg.slice(7) : null }); } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
  const withContext = argv.includes('--context');
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...res, hits: res.hits.map((h) => (withContext ? h : { ...h, context: undefined })) }, null, 2));
    return;
  }
  const showsHit = new Set(res.hits.map((h) => h.showId));
  console.log(`Tour-leg venue audit: ${res.scanned} included review file(s) across ${res.shows} WE/OWE show(s); ${res.hits.length} hit(s) on ${showsHit.size} show(s).`);
  for (const h of res.hits) {
    console.log(`  ${h.showId}/${h.file}  names "${h.matchedVenue}" (show venue: ${h.showVenue})`);
    if (withContext) console.log(`      …${h.context}…`);
  }
}

if (require.main === module) main();
module.exports = { audit };
