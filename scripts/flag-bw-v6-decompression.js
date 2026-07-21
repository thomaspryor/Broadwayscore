#!/usr/bin/env node
'use strict';
/**
 * Component 2 of the NYC anchored-bands rollout (Notion card
 * 39a637c5416f8137a105f2c88ea166ee): flag pure-LLM Broadway/Off-Broadway
 * reviews — no critic star/grade detected, so Component 1's
 * flag-late-star-reanchor.js never touches them — that were ensemble-scored
 * BEFORE broadway/off-broadway joined ANCHORED_MARKETS (src/config/scoring.ts,
 * 2026-07-20). Those reviews were scored under the pre-anchored path, which
 * compresses the top end (a 5/5-rave-equivalent text tops out ~89). Re-running
 * them through the now-anchored scorer produces an unanchored V6 ensemble call
 * (scoreSource='llm-v6', see ensemble-scorer.ts:414-430) that uses the full
 * 0-100 range.
 *
 * Selection (must stay disjoint from Component 1 — this only catches the
 * NO-BAND-DETECTED complement):
 *   - category in ('broadway', 'off-broadway') — WE/OWE got this fix 2026-05-16.
 *   - already ensemble-scored (llmScore.score + ensembleData present) — an
 *     unscored review drains through the normal --needs-rescore-less queue
 *     and will pick up V6 automatically; nothing to backfill.
 *   - scoreSource NOT already 'anchored-v6' / 'llm-v6' — already on the new path.
 *   - detectBandFromReviewFile finds NO band — a detectable star means
 *     Component 1 owns this file (or already re-anchored it).
 *   - not needsRescore already (don't clobber an existing queue reason).
 *   - not humanReviewScore / adjudicatedScore (human wins, never disturbed).
 *   - isIncludableForRebuild (canonical inclusion gate — same as the scorer).
 *
 * Sets needsRescore=true + rescoreReason='bw-v6-decompression'. Then run:
 *   npx tsx scripts/llm-scoring/index.ts --needs-rescore --rescore-reason=bw-v6-decompression
 *
 * Usage: node scripts/flag-bw-v6-decompression.js [--apply] [--limit=N]
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { detectBandFromReviewFile } = require('./lib/star-reliability');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
const ROOT = path.join(__dirname, '..');

const BW_MARKETS = new Set(['broadway', 'off-broadway']);
const ALREADY_V6 = new Set(['anchored-v6', 'llm-v6']);

const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const marketById = new Map(showsArr.map(s => [s.id, s.market || s.category]));
const titleById = new Map(showsArr.map(s => [s.id, s.title]));

let flagged = 0;
let scanned = 0;
const byShow = {};
for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', '*', '*.json'))) {
  const showId = path.basename(path.dirname(f));
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  // Fall back to the review file's own embedded category when the show is
  // missing from shows.json (renamed slug, deleted show, mid-migration) —
  // mirrors needsLateStarReanchor's ctx.category fallback in
  // lib/late-star-anchor.js so an orphaned show dir isn't silently skipped.
  const category = marketById.has(showId) ? marketById.get(showId) : d.category;
  if (!BW_MARKETS.has(category)) continue;
  scanned++;
  if (d.needsRescore === true) continue; // already queued (e.g. Component 1)
  if (ALREADY_V6.has(d.scoreSource)) continue; // already on the new path
  if (!(d.llmScore && typeof d.llmScore.score === 'number' && d.ensembleData)) continue; // not yet ensemble-scored
  if (d.humanReviewScore != null || d.adjudicatedScore != null) continue; // human/adjudicated wins
  const det = detectBandFromReviewFile(d);
  if (det && det.band) continue; // has a detectable star — Component 1's territory
  const show = titleById.get(showId) ? { title: titleById.get(showId) } : undefined;
  if (!isIncludableForRebuild(d, show, f)) continue;
  byShow[showId] = (byShow[showId] || 0) + 1;
  flagged++;
  if (APPLY) {
    d.needsRescore = true;
    d.rescoreReason = 'bw-v6-decompression';
    delete d.rescoreCompletedAt;
    safeWriteReview(f, d, { force: true });
  }
  if (LIMIT && flagged >= LIMIT) break;
}
console.log(`${APPLY ? 'Flagged' : 'Would flag'} ${flagged} pure-LLM BW/OWE reviews for V6 decompression rescore (scanned ${scanned} BW/OWE files), across ${Object.keys(byShow).length} shows:`);
for (const [s, n] of Object.entries(byShow).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}  ${s}`);
if (Object.keys(byShow).length > 25) console.log(`  ... and ${Object.keys(byShow).length - 25} more shows`);
if (!APPLY) console.log('\n(dry run — pass --apply to write needsRescore flags)');
