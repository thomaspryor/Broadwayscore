#!/usr/bin/env node
/**
 * discover-tour-stop-reviews.js — find local reviews of each national tour
 * stop (BRO-4656).
 *
 * A tour is reviewed by the papers of whichever city it is playing, during
 * that engagement. For each due stop (lib/tour-stop-discovery.js: stops opened
 * in the last 4 weeks, weekly; plus a capped backfill of older stops not yet
 * searched to completion, newest first, at most 3 attempts) this runs one SERP query, "<title>" review <city>,
 * windowed to the engagement, and ingests the surviving results into the tour
 * through ingest-review-from-url.js (the same guard chain as every other
 * single-URL ingest).
 *
 * Candidate filters, in order: URL already on the tour, its Broadway parent or
 * a sibling tour; a social, ticketing or UGC domain (isBlockedReviewUrl); not
 * review-shaped or a roundup; a screen version or video page (Wicked: For Good
 * played during the Buffalo stop); validateSerpCandidate's wrong-production
 * markers; tourCandidateIsTour (an overseas edition, a non-review page such as an
 * interview or press item, or the New York company's review; a local review
 * need not say "tour", BRO-4931);
 * a registered outlet, or an unregistered one whose result title names the
 * show and says "review" (ingested under a provisional outlet id).
 *
 * Ingest gets --date-window: a page whose extracted publish date is missing or
 * outside the stop (a week before opening to a month after closing) is skipped
 * before any write, so a review of an earlier visit or another production
 * never lands. The writer's tour-family date guard and the daily tour sweep's
 * integrity pass (sweep-tour-reviews.js) still apply after that.
 *
 * The weekly regional job (discover-regional-serp-reviews.js) still runs one
 * "<title>" national tour review query per tour for registered outlets; it
 * catches launch reviews whose headline names no city. This job owns the
 * per-city search and the provisional-outlet policy for tours.
 *
 * State: data/audit/tour-stop-discovery.json (stop keys with date, done,
 * attempts; URLs refused for good; last run summary).
 *
 * Usage:
 *   node scripts/discover-tour-stop-reviews.js [--show=TOUR_ID] [--backfill=60]
 *     [--max-minutes=35] [--max-ingests=80] [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { serpQuery } = require('./lib/url-discovery');
const { tourCandidateIsTour, normalizeUrl, looksLikeAggregationOrReaction, resolveRegisteredOutlet } = require('./lib/regional-serp-discovery');
const { urlLooksLikeReview } = require('./lib/review-guards');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { validateSerpCandidate } = require('./lib/serp-candidate-validator');
const { serpCensusPreflight } = require('./lib/serp-census-preflight');
const { selectDueStops, buildStopQuery, buildStopDateRange, stopDateWindowArg, looksLikeScreenVersion, unregisteredLooksLikeStopReview } = require('./lib/tour-stop-discovery');
const { isBroadwayCategory } = require('./lib/venue-classification');
const { toursOfTitle } = require('./lib/tour-family');

// Same per-ingest wall-time cap as discover-regional-serp-reviews.js.
const INGEST_TIMEOUT_MS = 3 * 60 * 1000;

const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const STATE_PATH = path.join(ROOT, 'data', 'audit', 'tour-stop-discovery.json');

const USAGE = 'Usage: node scripts/discover-tour-stop-reviews.js [--show=TOUR_ID] [--backfill=60] [--max-minutes=35] [--max-ingests=80] [--dry-run]';
const args = process.argv.slice(2);
if (require('./lib/cli-help.js').hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
const getArg = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};
const showFilter = getArg('show', null);
const dryRun = args.includes('--dry-run');
const backfill = Number(getArg('backfill', '60'));
const maxMinutes = Number(getArg('max-minutes', '35'));
const maxIngests = Number(getArg('max-ingests', '80'));

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}

function filesOf(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => path.join(dir, f));
}

// URLs already held by the tour, its parent, any other Broadway or parent-market
// production of that title (Beetlejuice tour reviews sat on beetlejuice-2022
// and -2025, the sweep's sources) or any sibling tour: a result already filed
// elsewhere in the family is not a new review.
function familyUrls(show, shows) {
  const ids = new Set([show.id]);
  // Sibling tours of the title are family whether or not the tour has a parent
  // (a standalone tour, BRO-4931, has only these).
  for (const t of toursOfTitle(show.title, shows)) ids.add(t.id);
  if (show.tourOf) {
    ids.add(show.tourOf);
    const parent = shows.find((s) => s.id === show.tourOf);
    const title = parent && String(parent.title || '').trim().toLowerCase();
    const parentCategory = parent && (parent.category || 'broadway');
    for (const s of shows) {
      if (s.tourOf === show.tourOf) ids.add(s.id);
      else if (title && s.category !== 'tour' && ((s.category || 'broadway') === parentCategory || isBroadwayCategory(s)) && String(s.title || '').trim().toLowerCase() === title) ids.add(s.id);
    }
  }
  const urls = new Set();
  for (const id of ids) {
    for (const f of filesOf(id)) {
      const d = readJson(f, null);
      if (d && d.url) urls.add(normalizeUrl(d.url));
    }
  }
  return urls;
}

// ingest-review-from-url.js with the stop's --date-window, so a page dated
// outside the engagement (or undated) is skipped before anything is written.
function ingest(showId, url, outletId, stop) {
  const argv = [path.join(__dirname, 'ingest-review-from-url.js'), `--show=${showId}`, `--url=${url}`, `--date-window=${stopDateWindowArg(stop)}`];
  if (outletId) argv.push(`--outlet=${outletId}`);
  try {
    const out = execFileSync(process.execPath, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: INGEST_TIMEOUT_MS });
    if (/✅ Created/.test(out)) return 'new';
    if (/✅ Updated/.test(out)) return 'updated';
    if (/outside --date-window/.test(out)) return 'out-of-window';
    return 'skipped';
  } catch (e) {
    const reason = e.signal === 'SIGTERM' ? `timed out after ${INGEST_TIMEOUT_MS / 1000}s` : String(e.stderr || e.message).split('\n')[0];
    console.log(`    ✗ ingest failed: ${reason}`);
    return 'error';
  }
}

// One stop's search. `complete` is false when the ingest cap or the run's
// deadline cut it short, or an ingest failed (fetch failure, guard refusal),
// so the stop is retried next run (lib MAX_ATTEMPTS). `refused` holds URLs
// ingest skipped for good (dated outside the stop, or skipped by the writer):
// they are not fetched again for REFUSED_TTL_DAYS.
// A refusal is retried after REFUSED_TTL_DAYS: an undated page counts as
// out-of-window, and a date the extractor misses today it may read later.
const REFUSED_TTL_DAYS = 90;
function isRefused(day) {
  const t = Date.parse(day || '');
  return !Number.isNaN(t) && Date.now() - t < REFUSED_TTL_DAYS * 86400000;
}

async function searchStop({ show, stop }, shows, budget, refused, deadline) {
  const query = buildStopQuery(show, stop);
  if (!query) return { searched: false };
  const results = await serpQuery(query, { nbResults: 10, dateRange: buildStopDateRange(stop), preferSpeed: false });
  if (results == null) return { searched: false, serpFailed: true, query };
  const known = familyUrls(show, shows);
  const row = { query, candidates: results.length, ingested: [], outOfWindow: 0, errors: 0, complete: true };
  for (const r of results) {
    const norm = normalizeUrl(r.url);
    if (!r.url || known.has(norm) || isRefused(refused[norm])) continue;
    // Social, ticketing and UGC pages (a Facebook post, a Reddit thread) are
    // refused by ingest anyway; dropping them here keeps them off the cap.
    if (isBlockedReviewUrl(r.url) || !urlLooksLikeReview(r.url, show.title) || looksLikeAggregationOrReaction(r.url, r.title) || looksLikeScreenVersion(r)) continue;
    const candidate = { url: r.url, title: r.title, snippet: r.description };
    if (!validateSerpCandidate({ show, candidate }).ok || !tourCandidateIsTour(show, candidate)) continue;
    const outletId = resolveRegisteredOutlet(r.url);
    if (!outletId && !unregisteredLooksLikeStopReview(show, r)) continue;
    if (budget.ingests >= maxIngests || Date.now() > deadline) { row.complete = false; break; }
    budget.ingests++;
    if (dryRun) {
      console.log(`  [dry-run] would ingest ${outletId || '(provisional)'}: ${r.url}`);
      row.ingested.push({ url: r.url, outletId: outletId || null, action: 'dry-run' });
      continue;
    }
    console.log(`  → ${outletId || '(provisional)'}: ${r.url}`);
    const action = ingest(show.id, r.url, outletId, stop);
    if (action === 'new' || action === 'updated') {
      known.add(norm);
      row.ingested.push({ url: r.url, outletId: outletId || null, action });
    } else if (action === 'error') {
      row.errors++;
      row.complete = false;
    } else {
      if (action === 'out-of-window') row.outOfWindow++;
      refused[norm] = new Date().toISOString().slice(0, 10);
      console.log(`    (${action})`);
    }
  }
  return { searched: true, ...row };
}

async function main() {
  const preflight = serpCensusPreflight(process.env, {
    disableVar: null,
    consequence: 'Every tour stop would be recorded as searched with 0 results and never searched again. Refusing to run.',
    workflowHint: '.github/workflows/discover-tour-stop-reviews.yml',
  });
  if (!preflight.ok) {
    console.error(`::error::tour-stop discovery preflight failed — ${preflight.reason}`);
    process.exit(1);
  }

  const shows = require(path.join(ROOT, 'data', 'shows.json')).shows;
  const schedules = (readJson(path.join(ROOT, 'data', 'tour-schedules.json'), {}) || {}).tours || {};
  const state = readJson(STATE_PATH, {});
  state.searched = state.searched || {};
  state.refused = state.refused || {};
  const tours = shows.filter((s) => s.market === 'tour' && (!showFilter || s.id === showFilter));
  const due = selectDueStops(tours, schedules, state.searched, { backfill });
  console.log(`Tour-stop discovery — ${tours.length} tour(s), ${due.length} stop(s) due (${due.filter((d) => d.why === 'recent').length} recent)${dryRun ? ' (dry-run)' : ''}`);

  const deadline = Date.now() + maxMinutes * 60 * 1000;
  const budget = { ingests: 0 };
  const runRows = [];
  let serpFailures = 0;
  for (const item of due) {
    if (Date.now() > deadline) { console.log(`⏱  ${maxMinutes}-minute budget reached; the rest wait for the next run.`); break; }
    if (budget.ingests >= maxIngests) { console.log(`Ingest cap ${maxIngests} reached; the rest wait for the next run.`); break; }
    console.log(`\n${item.show.id} @ ${item.stop.city} (${item.stop.start} to ${item.stop.end}, ${item.why})`);
    let res;
    try {
      res = await searchStop(item, shows, budget, state.refused, deadline);
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      res = { searched: false, error: e.message };
    }
    if (res.serpFailed) serpFailures++;
    if (res.searched && !dryRun) {
      const prev = state.searched[item.key] || {};
      state.searched[item.key] = {
        at: new Date().toISOString().slice(0, 10), done: res.complete,
        attempts: (prev.attempts || 0) + 1, candidates: res.candidates, ingested: (prev.ingested || 0) + res.ingested.length,
      };
    }
    runRows.push({ key: item.key, why: item.why, ...res });
  }

  const attempted = runRows.length;
  const ingested = runRows.reduce((n, r) => n + ((r.ingested || []).filter((i) => i.action === 'new').length), 0);
  const outOfWindow = runRows.reduce((n, r) => n + (r.outOfWindow || 0), 0);
  console.log(`\nDone. ${attempted} stop(s) searched, ${ingested} new review(s), ${outOfWindow} skipped as dated outside their stop.`);
  if (attempted > 0 && serpFailures === attempted) {
    console.error(`::error::SERP provider chain failed for all ${attempted} stop(s) — not writing state.`);
    process.exit(1);
  }
  if (serpFailures > 0) console.warn(`::warning::SERP provider failure for ${serpFailures}/${attempted} stop(s)`);
  // The workflow rebuilds only when a review file was written.
  const written = runRows.reduce((n, r) => n + ((r.ingested || []).filter((i) => i.action === 'new' || i.action === 'updated').length), 0);
  if (process.env.GITHUB_OUTPUT && !dryRun) fs.appendFileSync(process.env.GITHUB_OUTPUT, `written=${written}\n`);
  if (!dryRun) {
    state.lastRun = { at: new Date().toISOString(), searched: attempted, ingested, outOfWindow, stops: runRows.filter((r) => (r.ingested || []).length || r.error) };
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Tour-stop discovery failed:', e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { familyUrls };
