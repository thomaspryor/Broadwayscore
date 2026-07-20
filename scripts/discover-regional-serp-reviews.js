#!/usr/bin/env node
/**
 * discover-regional-serp-reviews.js — SERP review discovery for regional
 * (pre-Broadway tryout) shows, beyond aggregator (BWW/Playbill Verdict) roundups.
 *
 * Regional shows only get reviews that happen to land in a roundup article.
 * gather-reviews.js's isLikelyTourReview() guard (review-guards.js:741) has no
 * carve-out for market='regional' showIds and would reject exactly the local
 * coverage (BroadwayWorld city subdirectories, local papers) that IS the
 * legitimate signal for a regional tryout — so nothing else searches for it.
 * Dolly Nashville proof: BroBible + Bethany Writes were page-1 Google results
 * invisible to the pipeline until found manually 2026-07-19 (Notion 3a3637c5).
 *
 * Pipeline per show:
 *   1. Build one SERP query: "{title}" review {city} (city parsed from venue).
 *   2. serpQuery() from lib/url-discovery.js — Bright Data first, ScrapingBee
 *      fallback, date-windowed to the show's run to avoid cross-production noise.
 *   3. Filter results to URLs whose domain resolves unambiguously to a
 *      REGISTERED outlet (outlet-registry.json) — unregistered domains are
 *      logged as candidates for manual onboarding, never auto-ingested.
 *   4. Skip URLs the show already has a review file for (idempotent).
 *   5. urlLooksLikeReview() sanity filter (rejects /tag/, /ticket, etc).
 *   6. Ingest survivors via ingest-review-from-url.js (same guard chain as the
 *      /submit-review form — operatorTrust:false, subject to all content guards).
 *
 * Usage:
 *   node scripts/discover-regional-serp-reviews.js [--show=ID] [--dry-run]
 *
 * Cost: one SERP query per show (~7 shows in the pool = 7 queries). Bright
 * Data is the default primary provider (see url-discovery.js), so ScrapingBee
 * usage should stay near zero. The workflow sets SERP_SB_MAX_CALLS_PER_RUN to
 * bound worst-case batch-wide SERP cost — SB_CREDIT_BUDGET only bounds the
 * page-fetch inside each spawned ingest-review-from-url.js subprocess (resets
 * per-process, does not accumulate across shows/candidates).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { serpQuery, calculateDateWindow } = require('./lib/url-discovery');
const { urlLooksLikeReview } = require('./lib/review-guards');
const { _parseDomain, _buildDomainMap } = require('./lib/outlet-canonicalize');
const { validateSerpCandidate } = require('./lib/serp-candidate-validator');

// Hard cap on ingest subprocess wall time. A slow/paywalled fetch (WSJ took
// ~2min in testing) must not be allowed to eat the workflow's 20-min budget
// across every show in the pool — one bad URL fails, the rest still run.
const INGEST_TIMEOUT_MS = 3 * 60 * 1000;

const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'regional-serp-discovery.json');

const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const showFilter = getArg('show');
const dryRun = hasFlag('dry-run');

// A show stays in the discovery pool while open, or for ~15 months after
// closing (or after opening, if closingDate is unknown) — long enough to
// cover the Dolly-style case where the transfer/rescore lag is many months,
// short enough that the pool doesn't grow unbounded as regional history
// accumulates (little-bear-ridge-road-2024, closed 2+ years, drops out).
const POOL_WINDOW_DAYS = 450;

function ageInDays(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function cityFromVenue(venue) {
  if (!venue || typeof venue !== 'string') return null;
  // "Venue Name, City, ST" — city is the second-to-last comma segment.
  const parts = venue.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 2];
}

function getExistingUrls(showId) {
  const urls = new Set();
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return urls;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (data.url) urls.add(data.url.toLowerCase().replace(/\/$/, ''));
    } catch {
      // skip unreadable file
    }
  }
  return urls;
}

function normalizeUrl(url) {
  return (url || '').toLowerCase().replace(/\/$/, '');
}

// Roundup/aggregation pages (BWW "Review Roundup", Playbill "Read the Reviews")
// and audience-reaction pieces are not single-critic reviews. The downstream
// write path (review-file-writer.js isRoundupPageAsReview) already excludes
// roundup pages from scoring, but skipping them here avoids a wasted fetch and
// an outlet--critic slot claimed by a page that isn't a review at all.
const NON_REVIEW_MARKERS = /\b(review roundup|critics? sound off|read the reviews|what critics? (?:are|is) saying|reactions?|reacts? to)\b/i;

function looksLikeAggregationOrReaction(url, title) {
  return NON_REVIEW_MARKERS.test(title || '') || NON_REVIEW_MARKERS.test(decodeURIComponent(url || ''));
}

function resolveRegisteredOutlet(url) {
  const domain = _parseDomain(url);
  if (!domain) return null;
  const { domainToOutlet, ambiguous } = _buildDomainMap();
  if (ambiguous.has(domain)) return null;
  return domainToOutlet[domain] || null;
}

function selectRegionalShows() {
  const showsData = require(path.join(ROOT, 'data', 'shows.json'));
  return showsData.shows.filter((s) => {
    if (s.market !== 'regional') return false;
    if (showFilter) return s.id === showFilter;
    if (s.status === 'open' || s.status === 'previews') return true;
    const age = Math.min(ageInDays(s.closingDate), s.closingDate ? Infinity : ageInDays(s.openingDate));
    return age <= POOL_WINDOW_DAYS;
  });
}

function ingestUrl(showId, url, outletId) {
  if (dryRun) {
    console.log(`  [dry-run] would ingest ${outletId}: ${url}`);
    return { action: 'dry-run' };
  }
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(__dirname, 'ingest-review-from-url.js'), `--show=${showId}`, `--url=${url}`, `--outlet=${outletId}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: INGEST_TIMEOUT_MS }
    );
    if (/✅ Created/.test(out)) return { action: 'new', log: out };
    if (/✅ Updated/.test(out)) return { action: 'updated', log: out };
    return { action: 'skipped', log: out };
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    const reason = e.signal === 'SIGTERM' ? `timed out after ${INGEST_TIMEOUT_MS / 1000}s` : (e.stderr || e.message).split('\n')[0];
    console.log(`  ✗ ingest failed for ${url}: ${reason}`);
    return { action: 'error', log: output };
  }
}

async function processShow(show) {
  const city = cityFromVenue(show.venue);
  if (!city) {
    console.log(`⚠️  ${show.id}: could not parse city from venue "${show.venue}" — skipping`);
    return { showId: show.id, skipped: 'no-city' };
  }

  const query = `"${show.title}" review ${city}`;
  console.log(`\n${show.id} — query: ${query}`);

  const dateRange = calculateDateWindow(show);
  const results = await serpQuery(query, { nbResults: 10, dateRange, preferSpeed: false });

  if (!results || results.length === 0) {
    console.log('  (no SERP results)');
    return { showId: show.id, query, candidates: 0, ingested: [], newOutletCandidates: [] };
  }

  const existingUrls = getExistingUrls(show.id);
  const ingested = [];
  const newOutletCandidates = [];
  let skippedExisting = 0;
  let skippedUnregistered = 0;
  let skippedNotReview = 0;

  for (const r of results) {
    const url = r.url;
    if (!url) continue;
    const norm = normalizeUrl(url);
    if (existingUrls.has(norm)) {
      skippedExisting++;
      continue;
    }
    if (!urlLooksLikeReview(url, show.title) || looksLikeAggregationOrReaction(url, r.title)) {
      skippedNotReview++;
      continue;
    }
    // Cross-market / wrong-production hard-marker check (same guard collect-outlet-reviews.js
    // and gather-reviews.js's SERP path rely on) — cheap, synchronous, no network cost.
    const validation = validateSerpCandidate({ show, candidate: { url, title: r.title } });
    if (!validation.ok) {
      console.log(`  · rejected by validateSerpCandidate (${validation.reason}): ${url}`);
      skippedNotReview++;
      continue;
    }
    const outletId = resolveRegisteredOutlet(url);
    if (!outletId) {
      const domain = _parseDomain(url);
      console.log(`  · unregistered domain (candidate for onboarding): ${domain} — ${url}`);
      newOutletCandidates.push({ url, domain, title: r.title || null });
      skippedUnregistered++;
      continue;
    }

    console.log(`  → candidate: ${outletId} — ${url}`);
    const result = ingestUrl(show.id, url, outletId);
    if (result.action === 'new' || result.action === 'updated') {
      console.log(`    ✅ ${result.action}: ${outletId}`);
      ingested.push({ url, outletId, action: result.action });
    } else if (result.action === 'dry-run') {
      ingested.push({ url, outletId, action: 'dry-run' });
    } else {
      console.log(`    (${result.action})`);
    }
  }

  console.log(
    `  summary: ${ingested.length} ingested, ${skippedExisting} already-known, ` +
    `${skippedUnregistered} unregistered-domain, ${skippedNotReview} not-review-shaped`
  );

  return {
    showId: show.id,
    query,
    candidates: results.length,
    ingested,
    newOutletCandidates,
    skippedExisting,
    skippedUnregistered,
    skippedNotReview,
  };
}

async function main() {
  const shows = selectRegionalShows();
  console.log(`Regional SERP discovery — ${shows.length} show(s) in pool${dryRun ? ' (dry-run)' : ''}`);
  if (shows.length === 0) {
    console.log(showFilter ? `No regional show found matching --show=${showFilter}` : 'No regional shows in the discovery window.');
    return;
  }

  // One show's failure (SERP provider exception, etc.) must not abort the
  // whole run — the audit log and rebuild trigger for every other show's
  // real ingests would be lost with it.
  const perShow = [];
  for (const show of shows) {
    try {
      perShow.push(await processShow(show));
    } catch (e) {
      console.error(`✗ ${show.id} failed: ${e.message}`);
      perShow.push({ showId: show.id, error: e.message });
    }
  }

  const totalIngested = perShow.reduce((n, s) => n + (s.ingested ? s.ingested.length : 0), 0);
  const totalCandidateOutlets = perShow.reduce((n, s) => n + (s.newOutletCandidates ? s.newOutletCandidates.length : 0), 0);
  console.log(`\nDone. ${totalIngested} review(s) ingested across ${shows.length} show(s). ${totalCandidateOutlets} unregistered-outlet candidate(s) logged.`);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(
      AUDIT_PATH,
      JSON.stringify({ lastRun: new Date().toISOString(), shows: perShow }, null, 2)
    );
    console.log(`Audit log written: ${path.relative(ROOT, AUDIT_PATH)}`);
  }
}

main().catch((e) => {
  console.error('Regional SERP discovery failed:', e.stack || e.message);
  process.exit(1);
});
