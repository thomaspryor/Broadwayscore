#!/usr/bin/env node
'use strict';
/**
 * Flag reviews that were scored UNANCHORED (llm-v6) but now carry a high-reliability
 * published star, so they get re-scored in ANCHORED mode. Backfills ALL West End /
 * off-West-End shows (the anchored markets) corpus-wide — closing the opening-night
 * late-arriving-star race (see scripts/lib/late-star-anchor.js).
 *
 * Sets needsRescore=true + rescoreReason='late-star-anchor'. Then run:
 *   ANCHORED_BANDS_PILOT unnecessary for WE/OWE (auto-anchored):
 *   npx tsx scripts/llm-scoring/index.ts --needs-rescore --rescore-reason=late-star-anchor
 *
 * Usage: node scripts/flag-late-star-reanchor.js [--apply] [--limit=N]
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { needsLateStarReanchor } = require('./lib/late-star-anchor');
const { safeWriteReview } = require('./lib/review-write-guard');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
const ROOT = path.join(__dirname, '..');

// Show market by id (authoritative — don't trust a category field on the review).
const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const marketById = new Map(showsArr.map(s => [s.id, s.market || s.category]));
const titleById = new Map(showsArr.map(s => [s.id, s.title]));

let flagged = 0;
const byShow = {};
for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', '*', '*.json'))) {
  const showId = path.basename(path.dirname(f));
  const category = marketById.get(showId);
  if (category !== 'west-end' && category !== 'off-west-end') continue; // anchored markets only
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (d.needsRescore === true) continue; // already queued
  // Pass show title + filePath so isIncludableForRebuild (inside needsLateStarReanchor)
  // can run its full gate — excludes duplicates / consent-wall stubs the scorer rejects.
  const show = titleById.get(showId) ? { title: titleById.get(showId) } : undefined;
  const verdict = needsLateStarReanchor(d, { category, show, filePath: f });
  if (!verdict) continue;
  byShow[showId] = (byShow[showId] || 0) + 1;
  flagged++;
  if (APPLY) {
    d.needsRescore = true;
    d.rescoreReason = 'late-star-anchor';
    d.lateStarAnchorBand = `${verdict.band.floor}-${verdict.band.ceiling} (${verdict.starsRaw})`;
    safeWriteReview(f, d, { force: true });
  }
  if (LIMIT && flagged >= LIMIT) break;
}
console.log(`${APPLY ? 'Flagged' : 'Would flag'} ${flagged} llm-v6 WE/OWE reviews with a late high-reliability star, across ${Object.keys(byShow).length} shows:`);
for (const [s, n] of Object.entries(byShow).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${s}`);
if (!APPLY) console.log('\n(dry run — pass --apply to write needsRescore flags)');
