#!/usr/bin/env node
'use strict';
/**
 * Store star ratings that are printed in a review's own text but were never
 * recorded in originalScore (BRO-4486). Backstop for every write path; the
 * review-file-writer.js does the same at write time. Runs before
 * flag-late-star-reanchor.js in enrich-reviews.yml, which then re-anchors
 * files already scored without the star.
 *
 * Usage: node scripts/capture-published-stars.js [--apply] [--limit=N]
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { capturePublishedStar } = require('./lib/published-star-capture');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `capture-published-stars.js — Store star ratings printed in review text but missing from originalScore.

Usage:
  node scripts/capture-published-stars.js [options]
  node scripts/capture-published-stars.js --help, -h    print this usage and exit

Options:
  --apply      write the captured ratings (default: dry run)
  --limit=N    stop after N captures
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
const ROOT = path.join(__dirname, '..');

const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showById = new Map((Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || [])).map(s => [s.id, s]));

let captured = 0;
const byOutlet = {};
for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', '*', '*.json'))) {
  const showId = path.basename(path.dirname(f));
  // _-prefixed folders (_superseded-misattributed, _pending) and files are not reviews of a show.
  if (showId.startsWith('_') || path.basename(f).startsWith('_')) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (!capturePublishedStar(d, { show: showById.get(showId), filePath: f })) continue;
  captured++;
  byOutlet[d.outletId] = (byOutlet[d.outletId] || 0) + 1;
  console.log(`  ${path.relative(path.join(ROOT, 'data', 'review-texts'), f)}: ${d.originalScore} (${d.originalScoreSource}), scored ${d.assignedScore ?? '-'} ${d.scoreSource || ''}`);
  if (APPLY) safeWriteReview(f, d, { force: true });
  if (LIMIT && captured >= LIMIT) break;
}

console.log(`${APPLY ? 'Captured' : 'Would capture'} ${captured} published star rating(s) from review text.`);
for (const [o, n] of Object.entries(byOutlet).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${o}`);
if (!APPLY) console.log('\n(dry run — pass --apply to write)');
