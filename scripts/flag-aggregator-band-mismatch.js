#!/usr/bin/env node
'use strict';
/**
 * BRO-866 backfill: flag reviews whose anchored band was computed from the
 * WRONG field. detectBandFromReviewFile() used to check aggregatorStars
 * before originalScore, so a review with both fields set — outlet's own
 * originalScore (dedicated extractor: json-ld, unicode-stars, svg-stars, …)
 * AND a disagreeing aggregatorStars relay (Show Score / WestEndTheatre) —
 * anchored to the RELAY's band instead of the outlet's own rating. Fixed in
 * star-reliability.js (originalScore now checked first); this script finds
 * files that already carry the stale wrong band baked into llmScore.band
 * (detectBandFromReviewFile isn't re-run at read time, only at scoring time)
 * and flags them for re-score.
 *
 * Sets needsRescore=true + rescoreReason='aggregator-band-mismatch'. Then:
 *   npx tsx scripts/llm-scoring/index.ts --needs-rescore --rescore-reason=aggregator-band-mismatch
 *
 * Usage: node scripts/flag-aggregator-band-mismatch.js [--apply] [--limit=N]
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { detectBandFromReviewFile } = require('./lib/star-reliability');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `flag-aggregator-band-mismatch.js — Flag reviews anchored to a stale aggregatorStars-derived band (BRO-866).

Usage:
  node scripts/flag-aggregator-band-mismatch.js [options]
  node scripts/flag-aggregator-band-mismatch.js --help, -h    print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
const ROOT = path.join(__dirname, '..');

let flagged = 0;
const byShow = {};
for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', '*', '*.json'))) {
  const showId = path.basename(path.dirname(f));
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (d.needsRescore === true) continue; // already queued
  if (!d.aggregatorStars) continue;
  if (typeof d.originalScore !== 'string') continue;
  const stampedBand = d.llmScore && d.llmScore.band;
  if (!stampedBand) continue; // never anchored — flag-late-star-reanchor.js's job, not this one
  // Manual/adjudicated verdicts win at read time regardless of the stamped
  // band — rescoring them is wasted spend.
  if (d.humanReviewScore != null) continue;
  if (d.adjudicatedScore != null) continue;
  // Recompute with the FIXED priority (originalScore before aggregatorStars).
  const correct = detectBandFromReviewFile(d);
  if (!correct || !correct.band) continue;
  if (stampedBand.floor === correct.band.floor && stampedBand.ceiling === correct.band.ceiling) continue;
  // Only re-anchor when the outlet's own originalScore is the high-reliability
  // source that should have won — never re-flag onto a low-reliability extraction.
  if (!correct.highReliability) continue;
  if (!isIncludableForRebuild(d, undefined, f)) continue;
  byShow[showId] = (byShow[showId] || 0) + 1;
  flagged++;
  if (APPLY) {
    d.needsRescore = true;
    d.rescoreReason = 'aggregator-band-mismatch';
    d.lateStarAnchorBand = `${correct.band.floor}-${correct.band.ceiling} (${correct.starsRaw})`;
    delete d.rescoreCompletedAt;
    safeWriteReview(f, d, { force: true });
  }
  if (LIMIT && flagged >= LIMIT) break;
}
console.log(`${APPLY ? 'Flagged' : 'Would flag'} ${flagged} reviews anchored to a stale aggregatorStars-derived band, across ${Object.keys(byShow).length} shows:`);
for (const [s, n] of Object.entries(byShow).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${s}`);
if (!APPLY) console.log('\n(dry run — pass --apply to write needsRescore flags)');
