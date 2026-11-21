#!/usr/bin/env node
/**
 * NYC Theatre Review Roundups Scraper
 *
 * Discovers and extracts review excerpts from newyorkcitytheatre.com roundup pages.
 * These roundups contain excerpts for reviews we may already have URLs for but lack text.
 *
 * Strategy:
 * 1. Google search for each show (2023+): site:newyorkcitytheatre.com "{show title}" reviews
 * 2. Scrape roundup page HTML
 * 3. Extract excerpts by outlet from "The Reviews" section
 * 4. Add nycTheatreExcerpt to existing reviews or create new minimal files
 *
 * Requires: a SERP provider key (SCRAPINGBEE_API_KEY or BRIGHTDATA_TOKEN) for Google searches
 *
 * Output: Updates/creates review files in data/review-texts/{showId}/
 * Archives: Saves HTML to data/aggregator-archive/nyc-theatre/
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { matchTitleToShow, loadShows, titleWordsMatch, buildSiblingCategoriesFromShows } = require('./lib/show-matching');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { checkArchiveCategory } = require('./lib/archive-cache-guard');

const { isUrlYearOutsideWindow } = require('./lib/content-filters');
const { isJunkOutlet } = require('./lib/review-normalization');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { classifyReason, describeSkip } = require('./lib/ingest-skip-classify');
const { isClosedShowEligibleForBatchDiscovery } = require('./lib/discovery-eligibility');
const { createNycTheatreDiscovery } = require('./lib/nyc-theatre-discovery');

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/nyc-theatre');

const { serpQuery } = require('./lib/url-discovery');
const { fetchPage, fetchWithScrapingdog, isChallengeOrGarbage, cleanup: cleanupScraper } = require('./lib/scraper');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `scrape-nyc-theatre-roundups.js — NYC Theatre Review Roundups Scraper.

Usage:
  node scripts/scrape-nyc-theatre-roundups.js [options]
  node scripts/scrape-nyc-theatre-roundups.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

// Memoized showId -> same-title-sibling categories index (BRO-2565, mirroring
// scrape-bww-reviews.js's siblingCategoriesByShowId()) — feeds
// checkArchiveCategory()'s cross-market-sibling check below.
let _siblingCategoriesCache = null;
function siblingCategoriesByShowId() {
  if (_siblingCategoriesCache) return _siblingCategoriesCache;
  _siblingCategoriesCache = buildSiblingCategoriesFromShows(loadShows());
  return _siblingCategoriesCache;
}

// ---------------------------------------------------------------------------
// HTTP helper — every tier (incl. ScrapingBee) lives behind fetchPage() (BRO-32)
// ---------------------------------------------------------------------------

// A provider that answers 200 with a stub is a MISS, not a hit. Verified live
// (BRO-2955): Scrapingdog returns a 154-byte JS-redirect shell for some
// aggregator pages, and isChallengeOrGarbage() only matches Cloudflare
// challenge markers, so that stub sailed through as a successful fetch and
// short-circuited the ScrapingBee/fetchPage tiers this helper is explicitly
// documented to fall through to. Floor matches the callers' own
// already-established "too short to be a real page" thresholds below.
const SD_MIN_HTML_BYTES = 500;

// Scrapingdog attempt before ScrapingBee (BRO-2930): this file called
// ScrapingBee directly with no other tier, so NYC Theatre traffic never
// touched Scrapingdog even after the SD migration — one of the
// direct-provider-call sites in data/audit/direct-provider-calls-baseline.json.
// Purely additive: any SD miss/failure falls straight through to fetchPage().
async function fetchHtmlViaSD(url, renderJs) {
  if (!process.env.SCRAPINGDOG_API_KEY) return null;
  try {
    const raw = await fetchWithScrapingdog(url, { renderJs });
    if (!raw || !raw.content) return null;
    if (isChallengeOrGarbage(raw.content)) return null;
    if (raw.content.length < SD_MIN_HTML_BYTES) return null;
    return raw.content;
  } catch {
    return null;
  }
}

// One pass only: fetchPage() already falls through every paid tier, so an outer
// retry loop would multiply credit spend per URL.
async function fetchHtml(url, renderJs = true, maxRetries = 0) {
  const sdHtml = await fetchHtmlViaSD(url, renderJs);
  if (sdHtml) return sdHtml;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchPage(url, { renderJs });
      if (!result || !result.content) throw new Error('empty fetchPage result');
      return result.content;
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = 3000 * (attempt + 1);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// Stats
const stats = {
  showsSearched: 0,
  showsFound: 0,
  pagesFetched: 0,
  excerptsFounds: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedExisting: 0,
  skippedArchived: 0,
  skippedNegativeCache: 0,
  skippedConflict: 0,
  errors: [],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Parse NYC Theatre roundup page
// ---------------------------------------------------------------------------

const { extractReviewsFromRoundup, KNOWN_OUTLETS } = require('./lib/nyc-theatre-roundup-parser');

// ---------------------------------------------------------------------------
// Save review excerpt
// ---------------------------------------------------------------------------

function saveNycTheatreExcerpt(showId, reviewInfo) {
  const result = createOrMergeReviewFile(showId, {
    outlet: reviewInfo.outlet,
    url: reviewInfo.url,
    source: 'nyc-theatre',
    fields: { nycTheatreExcerpt: reviewInfo.excerpt },
  });

  if (result.action === 'new') stats.newReviews++;
  else if (result.action === 'updated') stats.updatedReviews++;
  else {
    // BRO-205: classify the skip reason instead of special-casing only
    // domain-mismatch/aggregator-url-mismatch and lumping every OTHER
    // conflict (cross-show-url-owned, no-outlet, suspicious-outlet-id,
    // aggregator-url-refinement-refused) into "already exists". The `else`
    // used to file every unrecognised reason under skippedExisting, which
    // reads to the operator as ordinary "already had it" churn while an
    // excerpt was actually dropped.
    const cls = classifyReason(result.reason);
    if (cls.kind === 'conflict' || cls.kind === 'unclassified') {
      stats.skippedConflict++;
      console.warn(`  ⚠️  ${describeSkip(showId, reviewInfo.url, cls)}`);
    } else {
      stats.skippedExisting++;
    }
  }

  return result.action === 'skipped' ? 'skipped' : result.action;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeNYCTheatreRoundups() {
  console.log('=== NYC Theatre Review Roundups Scraper ===\n');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const showsArg = args.find(a => a.startsWith('--shows='));
  const targetShowIds = showsArg ? showsArg.replace('--shows=', '').split(',').map(s => s.trim()).filter(Boolean) : null;

  if (targetShowIds) {
    console.log(`Targeted mode: ${targetShowIds.length} show(s): ${targetShowIds.join(', ')}`);
  }

  if (!process.env.SCRAPINGDOG_API_KEY && !process.env.SCRAPINGBEE_API_KEY && !process.env.BRIGHTDATA_TOKEN) {
    console.error('A scraping provider key (SCRAPINGDOG_API_KEY / SCRAPINGBEE_API_KEY / BRIGHTDATA_TOKEN) is required for Google searches.');
    console.error('Set it in .env or pass as environment variable.');
    process.exit(1);
  }

  // Ensure archive directory exists
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const shows = loadShows();
  console.log(`Loaded ${shows.length} shows from shows.json`);

  // Filter shows — exclude closed shows and pre-2023 unless targeted
  let recentShows;
  if (targetShowIds) {
    // Targeted mode: process any show regardless of status/date
    recentShows = shows.filter(s => targetShowIds.includes(s.id) || targetShowIds.includes(s.slug));
  } else {
    // Batch mode: skip closed shows (won't get new reviews) and pre-2023.
    // Exception: regional shows close fast (limited runs), so a closed
    // regional show may not have been caught yet by scheduled discovery —
    // bounded to a window post-close so an already-exhausted miss doesn't
    // retry forever. NYC Theatre also caches successful searches with no page.
    recentShows = shows.filter(s => {
      if (!isClosedShowEligibleForBatchDiscovery(s)) return false;
      const opening = new Date(s.openingDate);
      return opening >= new Date('2023-01-01');
    });
  }

  // NYC Theatre covers New York productions. A national tour's title search
  // finds its Broadway page, whose excerpts were being filed as tour reviews
  // (Maybe Happy Ending's tour got the Times' Broadway rave; BRO-4325).
  // Regional shows too (BRO-7453): their search lands on the same-title
  // Broadway page (The Cottage, Purpose, Paranormal Activity).
  const { kept, tours, regional } = require('./lib/tour-family').nycTheatreTargets(recentShows);
  if (tours.length) console.log(`Skipping ${tours.length} national tour(s): NYC Theatre reviews New York productions only (${tours.map(s => s.id).join(', ')})`);
  if (regional.length) console.log(`Skipping ${regional.length} regional show(s): NYC Theatre reviews New York productions only (${regional.slice(0, 10).map(s => s.id).join(', ')}${regional.length > 10 ? ', ...' : ''})`);
  const discovery = createNycTheatreDiscovery({ archiveDir, search: (query, options) => serpQuery(query, options) });
  recentShows = discovery.orderShows(kept);

  console.log(`Processing ${recentShows.length} shows from 2023+\n`);

  // BRO-4146: a 22-show historical backfill spent 17 min here and pushed the
  // gather-reviews scrape-aggregators job past its timeout before its pushes
  // ran. Stop starting new shows once --time-budget-min is used up.
  // BRO-7213: the daily batch (~640 SERP searches at ~5s) ran past the 60-min
  // job limit every day from 2026-11-07. Reserve one worst-case show before
  // starting it: a SERP call with BD/SB fallback (~1 min) plus fetchHtml's
  // Scrapingdog -> fetchPage chain (~2.5 min, run-budget.js) = ~3.5 min, so 4.
  const MIN_REMAINING_MS_TO_START = 4 * 60_000;
  const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));
  for (const [idx, show] of recentShows.entries()) {
    const showId = show.id;
    const archivePath = path.join(archiveDir, `${showId}.html`);
    // Also check slug-based archive from older runs
    const slugArchivePath = show.slug && show.slug !== show.id
      ? path.join(archiveDir, `${show.slug}.html`) : null;
    const effectiveArchivePath = fs.existsSync(archivePath) ? archivePath
      : (slugArchivePath && fs.existsSync(slugArchivePath) ? slugArchivePath : archivePath);

    // Use cached archive if fresh (<14 days), otherwise re-fetch
    const archiveFresh = fs.existsSync(effectiveArchivePath) &&
      (Date.now() - fs.statSync(effectiveArchivePath).mtimeMs) / (1000 * 60 * 60 * 24) < 14;
    // Explicit --shows retries bypass misses. A fresh positive archive also
    // wins over a miss left by a concurrent run. Check before the time budget
    // so skipped misses cannot keep unvisited shows out of the next batch.
    if (!targetShowIds && !archiveFresh && discovery.isDeferred(show)) {
      stats.skippedNegativeCache++;
      continue;
    }
    if (!timeBudget.canStartItem(MIN_REMAINING_MS_TO_START)) {
      console.log(`\n⏱ Time budget (${timeBudget.minutes}min) used after ${timeBudget.elapsedMin()}min — deferring ${recentShows.length - idx} show(s) to the next run`);
      break;
    }
    if (archiveFresh) {
      const html = fs.readFileSync(effectiveArchivePath, 'utf8');

      // Read-time guard: keep the existing year check (catches a stale
      // same-title, same-category page — e.g. an old production's cached
      // page reused for a same-title revival — which the category-aware
      // check below cannot see, since same-category siblings never trigger
      // its cross-market-sibling branch), AND add the category-aware guard
      // (BRO-2565) on top, since a fresh mtime is not proof the file arrived
      // via the write-time guard below (a restore, a manual copy, a
      // different writer, or a rolled-back deploy can all put a poisoned
      // file on disk). A prior version of this fix REPLACED the year check
      // with the category check instead of adding it — flagged in review as
      // a real regression.
      const cacheValidation = await validatePageMatchesShow(html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null });
      const catCheck = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);
      if (!cacheValidation.valid || !catCheck.ok) {
        const reason = !cacheValidation.valid ? cacheValidation.reason : catCheck.reason;
        console.log(`[CACHE] ${showId}: Cached page is WRONG show — ${reason}. Deleting cache.`);
        fs.unlinkSync(effectiveArchivePath);
        // Fall through to re-fetch via Google search below
      } else {
        console.log(`[CACHE] ${showId}: Using archived HTML`);

        const reviews = extractReviewsFromRoundup(html, showId);
        stats.excerptsFounds += reviews.length;

        const cachedOpeningYear = show.openingDate ? new Date(show.openingDate).getFullYear() : null;
        const cachedClosingYear = show.closingDate ? new Date(show.closingDate).getFullYear() : null;
        for (const review of reviews) {
          // URL year guard: skip if URL year is clearly outside production window
          if (review.url && isUrlYearOutsideWindow(review.url, cachedOpeningYear, cachedClosingYear)) {
            console.log(`  [SKIP] ${review.outlet}: URL year outside production window`);
            continue;
          }

          const result = saveNycTheatreExcerpt(showId, review);
          if (result === 'new') {
            console.log(`  [NEW] ${review.outlet}`);
          } else if (result === 'updated') {
            console.log(`  [UPD] ${review.outlet}: added excerpt`);
          }
        }

        stats.skippedArchived++;
        discovery.recordArchiveHit(show);
        continue;
      }
    }

    // Google search for this show
    stats.showsSearched++;
    console.log(`[SEARCH] ${showId}: "${show.title}"...`);

    try {
      const { url, outcome } = await discovery.searchForShow(show);

      if (!url) {
        console.log(outcome === 'unavailable' ? '  Google search unavailable; no miss cached.' : '  No NYC Theatre page found; retry-after saved.');
        await sleep(2000);
        continue;
      }

      stats.showsFound++;
      console.log(`  Found: ${url}`);

      // Fetch the page
      await sleep(1000);
      const html = await fetchHtml(url);

      if (!html || html.length < 500) {
        console.log(`  Empty or too short page.`);
        continue;
      }

      // Verify page is actually about this show (prevent cross-show contamination)
      const validation = await validatePageMatchesShow(html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null });
      if (!validation.valid) {
        console.log(`  [SKIP] Page doesn't match "${show.title}" — ${validation.reason}`);
        continue;
      }

      // Category-aware guard (BRO-2565, mirroring BRO-2547/2549's BWW fix).
      // validatePageMatchesShow() above compares title + opening year, which
      // CANNOT separate a regional premiere from its later Broadway transfer:
      // same title, and the transfer's page carries the transfer's year.
      // Re-use the exact predicate audit-aggregator-archive-integrity.js
      // applies post-hoc so a page the audit would call poisoned never
      // reaches the cache in the first place.
      const catCheck = checkArchiveCategory(html, show, siblingCategoriesByShowId()[showId]);
      if (!catCheck.ok) {
        console.log(`  [SKIP] Page category mismatch: ${catCheck.reason} (page "${(catCheck.pageTitle || '').substring(0, 80)}")`);
        continue;
      }

      // Archive
      fs.writeFileSync(archivePath, html);
      stats.pagesFetched++;

      // Extract reviews
      const reviews = extractReviewsFromRoundup(html, showId);
      stats.excerptsFounds += reviews.length;
      console.log(`  Found ${reviews.length} review excerpts`);

      const fetchOpeningYear = show.openingDate ? new Date(show.openingDate).getFullYear() : null;
      const fetchClosingYear = show.closingDate ? new Date(show.closingDate).getFullYear() : null;
      for (const review of reviews) {
        // URL year guard: skip if URL year is clearly outside production window
        if (review.url && isUrlYearOutsideWindow(review.url, fetchOpeningYear, fetchClosingYear)) {
          console.log(`    [SKIP] ${review.outlet}: URL year outside production window`);
          continue;
        }

        const result = saveNycTheatreExcerpt(showId, review);
        if (result === 'new') {
          console.log(`    [NEW] ${review.outlet}`);
        } else if (result === 'updated') {
          console.log(`    [UPD] ${review.outlet}: added excerpt`);
        }
      }

      await sleep(2000); // Rate limit between Google searches
    } catch (err) {
      console.error(`  [ERROR] ${showId}: ${err.message}`);
      stats.errors.push(`${showId}: ${err.message}`);
      await sleep(2000);
    }
  }

  // Print summary
  console.log('\n=== NYC Theatre Roundups Summary ===');
  console.log(`Shows searched (Google): ${stats.showsSearched}`);
  console.log(`Shows found: ${stats.showsFound}`);
  console.log(`Pages fetched: ${stats.pagesFetched}`);
  console.log(`Used cached archives: ${stats.skippedArchived}`);
  console.log(`Skipped searches (negative cache): ${stats.skippedNegativeCache}`);
  console.log(`Total excerpts found: ${stats.excerptsFounds}`);
  console.log(`New reviews created: ${stats.newReviews}`);
  console.log(`Existing reviews updated: ${stats.updatedReviews}`);
  console.log(`Skipped (already have excerpt): ${stats.skippedExisting}`);
  if (stats.skippedConflict) console.log(`⚠️  Skipped (conflict — needs a human, see warnings above): ${stats.skippedConflict}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }

  return stats;
}

module.exports = { extractReviewsFromRoundup };

// Run
if (require.main === module) {
  scrapeNYCTheatreRoundups().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  }).finally(() => cleanupScraper());
}
