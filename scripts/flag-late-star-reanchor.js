#!/usr/bin/env node
'use strict';
/**
 * Flag reviews that should be re-scored in ANCHORED mode: scored UNANCHORED
 * (llm-v6) with a late-arriving high-reliability star, OR carrying an ensemble
 * LLM verdict under a non-v6 scoreSource stamp (scored pre-v6, or the v6 stamp
 * was overwritten by a later star extraction) so the rebuild serves the flat
 * star conversion instead of a within-band sentiment score. Backfills ALL
 * ANCHORED_MARKETS shows corpus-wide (west-end, off-west-end, broadway,
 * off-broadway) — closing the opening-night late-arriving-star race (see
 * scripts/lib/late-star-anchor.js).
 *
 * Sets needsRescore=true + rescoreReason='late-star-anchor'. Then run:
 *   ANCHORED_BANDS_PILOT unnecessary for ANCHORED_MARKETS (auto-anchored):
 *   npx tsx scripts/llm-scoring/index.ts --needs-rescore --rescore-reason=late-star-anchor
 *
 * 2026-07-20 (NYC rollout): market scoping is no longer hardcoded to WE/OWE
 * here — it defers entirely to needsLateStarReanchor's internal
 * shouldUseAnchoredMode(category) check, which reads the same ANCHORED_MARKETS
 * set (now broadway + off-broadway + west-end + off-west-end) that the
 * scorer itself uses. This file only needs `category` to pass through as
 * context; it never re-implements the market gate.
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
    // A file rescored once before carries rescoreCompletedAt — the workflow's
    // backlog counters skip any flagged file that still has it, so a re-queue
    // without clearing it is invisible to the drain. Same pattern as
    // flag-combined-reviews.js.
    delete d.rescoreCompletedAt;
    safeWriteReview(f, d, { force: true });
  }
  if (LIMIT && flagged >= LIMIT) break;
}
console.log(`${APPLY ? 'Flagged' : 'Would flag'} ${flagged} reviews needing anchored re-score (late star or non-v6 stamp), across ${Object.keys(byShow).length} shows:`);
for (const [s, n] of Object.entries(byShow).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${s}`);
if (!APPLY) console.log('\n(dry run — pass --apply to write needsRescore flags)');
