#!/usr/bin/env node
'use strict';
/**
 * backfill-html-only-ratings.js (BRO-4770 B) — recover star ratings that exist
 * only in the page HTML for review files created by the submit-review-form /
 * url-ingest path BEFORE BRO-4764 (scripts/lib/ingest-html-score.js), which left
 * originalScore null so the review was scored unanchored by the LLM alone.
 *
 * Candidates: ANCHORED_MARKETS shows, source/sources includes
 * 'submit-review-form', originalScore blank, no aggregatorStars, not
 * originalScoreCleared, an outlet WITH a registered extractor (generic
 * extractors never run, so page chrome cannot invent a rating).
 * For each: fetchPage(url) -> recoverScoreFromHtml -> setExtractedScore, then
 * needsRescore=true / rescoreReason='late-star-anchor' (rescoreCompletedAt
 * deleted) so the anchored drain re-scores it.
 *
 * Needs scraper keys, so it is run from CI (.github/workflows/star-band-backfill.yml).
 *
 * Usage: node scripts/backfill-html-only-ratings.js [--apply] [--limit=N] [--per-outlet=N] [--show=ID]
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage:\n  node scripts/backfill-html-only-ratings.js [--apply] [--limit=N] [--per-outlet=N] [--show=ID]\n  --help, -h   print this usage and exit'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { fetchPage } = require('./lib/scraper');
const { recoverScoreFromHtml, existingHasScoreSignal } = require('./lib/ingest-html-score');
const { setExtractedScore } = require('./lib/score-routing');
const { shouldUseAnchoredMode } = require('./lib/star-reliability');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
const showArg = process.argv.find(a => a.startsWith('--show='));
const ONLY_SHOW = showArg ? showArg.split('=')[1] : null;
const perOutletArg = process.argv.find(a => a.startsWith('--per-outlet='));
const PER_OUTLET = perOutletArg ? parseInt(perOutletArg.split('=')[1], 10) : 0; // sample N per outlet (diverse dry run)
const seenByOutlet = {};
const ROOT = path.join(__dirname, '..');

const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = new Map(showsArr.filter(s => s && s.id).map(s => [s.id, s]));
const { OUTLET_EXTRACTORS, KNOWN_STAR_OUTLETS } = require('./lib/score-extractors');

function isCandidate(d, show, f) {
  if (!d || !d.url || !d.outletId) return false;
  const srcs = [d.source, ...(Array.isArray(d.sources) ? d.sources : [])];
  if (!srcs.includes('submit-review-form')) return false;
  if (existingHasScoreSignal(d)) return false;
  // Star-publishing outlets only (the canonical KNOWN_STAR_OUTLETS set): an outlet that
  // prints no rating (BroadwayWorld prose, NYT) can only ever report noRating here.
  if (!KNOWN_STAR_OUTLETS.has(d.outletId) || !OUTLET_EXTRACTORS[d.outletId]) return false;
  if (d.humanReviewScore != null || d.adjudicatedScore != null) return false;
  if (!shouldUseAnchoredMode({ category: show.market || show.category, envFlag: false })) return false;
  return !!isIncludableForRebuild(d, show, f);
}

(async () => {
  const stats = { candidates: 0, fetched: 0, fetchFailed: 0, recovered: 0, noRating: 0, written: 0 };
  const recovered = [];
  const noRating = [];
  for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', ONLY_SHOW || '*', '*.json'))) {
    const showId = path.basename(path.dirname(f));
    const show = showById.get(showId);
    if (!show) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!isCandidate(d, show, f)) continue;
    if (PER_OUTLET && (seenByOutlet[d.outletId] || 0) >= PER_OUTLET) continue;
    seenByOutlet[d.outletId] = (seenByOutlet[d.outletId] || 0) + 1;
    if (LIMIT && stats.candidates >= LIMIT) break;
    stats.candidates++;
    let html = null;
    try {
      const r = await fetchPage(d.url, { source: 'backfill-html-only-ratings' });
      html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
    } catch (e) {
      stats.fetchFailed++;
      console.log(`  fetch failed ${showId}/${path.basename(f)}: ${e.message}`);
      continue;
    }
    if (!html || typeof html !== 'string' || html.length < 500) { stats.fetchFailed++; continue; }
    stats.fetched++;
    const rec = recoverScoreFromHtml(html, d.fullText || '', d.outletId, show.title);
    if (!rec) { stats.noRating++; noRating.push(`${showId}/${path.basename(f)} [${d.outletId}] ${d.url}`); continue; }
    stats.recovered++;
    recovered.push(`${showId}/${path.basename(f)}  ${rec.originalScore} (${rec.normalizedScore}) [${rec.source}]`);
    if (!APPLY) continue;
    const routed = setExtractedScore(d, { value: rec.originalScore, normalizedValue: rec.normalizedScore, source: rec.source });
    d.scoreExtractedFrom = 'scraped-html';
    d.scoreRecoveredAt = new Date().toISOString();
    if (routed.field === 'originalScore') {
      d.needsRescore = true;
      d.rescoreReason = 'late-star-anchor';
      delete d.rescoreCompletedAt;
      d.rescoreFlaggedAt = new Date().toISOString();
    }
    safeWriteReview(f, d, { force: true });
    stats.written++;
  }
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...stats }));
  for (const r of recovered) console.log('  RECOVERED ' + r);
for (const r of noRating.slice(0, 40)) console.log('  no-rating ' + r);
})();
