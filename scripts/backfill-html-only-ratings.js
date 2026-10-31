#!/usr/bin/env node
'use strict';
/**
 * backfill-html-only-ratings.js (BRO-4770 B) — recover star ratings that exist
 * only in the page HTML for review files created by the submit-review-form /
 * url-ingest path BEFORE BRO-4764 (scripts/lib/ingest-html-score.js), which left
 * originalScore null so the review was scored unanchored by the LLM alone.
 *
 * Candidates: ANCHORED_MARKETS shows, source/sources includes
 * 'submit-review-form' or 'theatre-record', or never fetched from the outlet
 * (BRO-5081), originalScore blank, no aggregatorStars, not
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
if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage:\n  node scripts/backfill-html-only-ratings.js [--apply] [--limit=N] [--per-outlet=N] [--show=ID] [--time-budget-min=N]\n  --help, -h   print this usage and exit'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { fetchPage } = require('./lib/scraper');
const { recoverScoreFromHtml, existingHasScoreSignal } = require('./lib/ingest-html-score');
const { setExtractedScore } = require('./lib/score-routing');
const { shouldUseAnchoredMode } = require('./lib/star-reliability');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
const showArg = process.argv.find(a => a.startsWith('--show='));
const ONLY_SHOW = showArg ? showArg.split('=')[1] : null;
const perOutletArg = process.argv.find(a => a.startsWith('--per-outlet='));
const PER_OUTLET = perOutletArg ? parseInt(perOutletArg.split('=')[1], 10) : 0; // sample N per outlet (diverse dry run)
const seenByOutlet = {};
const ROOT = path.join(__dirname, '..');

const { OUTLET_EXTRACTORS, KNOWN_STAR_OUTLETS, HOST_GATED_STAR_OUTLETS } = require('./lib/score-extractors');
const { markRescoreNeeded } = require('./lib/rescore-flagging');

// Sources whose stored text cannot carry the printed rating, so the score was
// built from words alone: the review form / url-ingest path before BRO-4764,
// and Theatre Record transcriptions (BRO-5081: the WE historical backfill came
// in this way; 6 of 149 sampled WE reviews sat outside their printed star band).
const STARLESS_TEXT_SOURCES = new Set(['submit-review-form', 'theatre-record']);

function isCandidate(d, show, f) {
  if (!d || !d.url || !d.outletId) return false;
  const srcs = [d.source, ...(Array.isArray(d.sources) ? d.sources : [])];
  // Or a record never fetched from the outlet at all (aggregator excerpt or
  // search stub: no fetchMethod/sourceMethod), whose score likewise never saw
  // the page. Records the collector fetched already had their HTML read.
  const neverFetched = !d.fetchMethod && !d.sourceMethod;
  if (!neverFetched && !srcs.some(s => STARLESS_TEXT_SOURCES.has(s))) return false;
  if (d.scoreExtractedFrom === 'scraped-html') return false;
  // A page already read with no rating found: skip until its marker is 30
  // days old, so batched runs make progress instead of re-reading it.
  if (d.starHtmlCheckedAt && Date.now() - Date.parse(d.starHtmlCheckedAt) < 30 * 864e5) return false;
  if (existingHasScoreSignal(d)) return false;
  // Star-publishing outlets only (the canonical KNOWN_STAR_OUTLETS set, plus
  // outlets whose extractor reads only the one host that prints stars): an
  // outlet that prints no rating (BroadwayWorld prose, NYT) can only ever
  // report noRating here.
  if (!(KNOWN_STAR_OUTLETS.has(d.outletId) || HOST_GATED_STAR_OUTLETS.has(d.outletId)) || !OUTLET_EXTRACTORS[d.outletId]) return false;
  if (d.humanReviewScore != null || d.adjudicatedScore != null) return false;
  if (!shouldUseAnchoredMode({ category: show.market || show.category, envFlag: false })) return false;
  return !!isIncludableForRebuild(d, show, f);
}

// britishtheatre.com moved every review from /review-<slug> to /posts/review-<slug>
// without redirects (old URLs 404, checked 2026-10-11). Pure.
function alternateUrls(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?britishtheatre\.com\/(review-[^/?#]+)\/?$/i);
  return m ? [`https://www.britishtheatre.com/posts/${m[1]}`] : [];
}

if (require.main === module) (async () => {
  // Stop before the job timeout so the push step still runs (a cancelled job
  // pushes nothing). star-band-backfill.yml passes --time-budget-min.
  const budget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));
  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
  const showById = new Map(showsArr.filter(s => s && s.id).map(s => [s.id, s]));
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
    if (budget.exceeded()) { stats.stoppedOnBudget = true; break; }
    if (PER_OUTLET && (seenByOutlet[d.outletId] || 0) >= PER_OUTLET) continue;
    seenByOutlet[d.outletId] = (seenByOutlet[d.outletId] || 0) + 1;
    if (LIMIT && stats.candidates >= LIMIT) break;
    stats.candidates++;
    // The moved url first: a dead old url can still answer with a soft-404
    // page long enough to look like a fetch. Keep the first page that fetched;
    // stop at the first one that yields a rating.
    let html = null;
    let rec = null;
    let lastErr = null;
    for (const u of [...alternateUrls(d.url), d.url]) {
      let page = null;
      try {
        const r = await fetchPage(u, { source: 'backfill-html-only-ratings' });
        page = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
      } catch (e) { lastErr = e; continue; }
      if (!page || typeof page !== 'string' || page.length < 500) continue;
      if (!html) html = page;
      rec = recoverScoreFromHtml(page, d.fullText || '', d.outletId, show.title);
      if (rec) { html = page; break; }
    }
    if (!html) {
      stats.fetchFailed++;
      if (lastErr) console.log(`  fetch failed ${showId}/${path.basename(f)}: ${lastErr.message}`);
      continue;
    }
    stats.fetched++;
    if (!rec) {
      stats.noRating++;
      noRating.push(`${showId}/${path.basename(f)} [${d.outletId}] ${d.url}`);
      if (APPLY) { d.starHtmlCheckedAt = new Date().toISOString(); safeWriteReview(f, d, { force: true }); }
      continue;
    }
    stats.recovered++;
    recovered.push(`${showId}/${path.basename(f)}  ${rec.originalScore} (${rec.normalizedScore}) [${rec.source}]`);
    if (!APPLY) continue;
    const routed = setExtractedScore(d, { value: rec.originalScore, normalizedValue: rec.normalizedScore, source: rec.source });
    d.scoreExtractedFrom = 'scraped-html';
    d.scoreRecoveredAt = new Date().toISOString();
    if (routed.field === 'originalScore') {
      markRescoreNeeded(d, 'late-star-anchor', undefined, { requeue: true });
      delete d.rescoreCompletedAt;
    }
    const res = safeWriteReview(f, d, { force: true });
    if (res && res.wrote === false) { stats.refused = (stats.refused || 0) + 1; continue; }
    stats.written++;
  }
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...stats }));
  for (const r of recovered) console.log('  RECOVERED ' + r);
for (const r of noRating.slice(0, 40)) console.log('  no-rating ' + r);
})();

module.exports = { isCandidate, alternateUrls, STARLESS_TEXT_SOURCES };
