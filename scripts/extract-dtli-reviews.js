#!/usr/bin/env node

/**
 * Extract reviews from DTLI (Did They Like It) HTML pages
 * Includes: full text, URL, thumb (Up/Meh/Down), outlet, critic
 *
 * Output: data/review-texts/{showId}/{outletId}--{critic-slug}.json
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet: canonicalNormalizeOutlet, getOutletDisplayName, slugify, normalizeCritic, normalizePublishDate, findExistingReviewFile, generateReviewFilename, resolveOutletFromUrl, loadOutletRegistry, outletOwnsUrlDomainIgnoringPath } = require('./lib/review-normalization');
const { canonicalizeCritic } = require('./lib/critic-canonicalization');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help');
const { shouldRefuseAggregatorOutletRefinement, shouldSkipAggregatorUrlWrite } = require('./lib/aggregator-domains');
const { classifyMarketRouting, buildSiblingIndex } = require('./lib/market-routing');

const dtliDir = path.join(__dirname, '../data/aggregator-archive/dtli');
const outputDir = path.join(__dirname, '../data/review-texts');
const AGGREGATOR_SUMMARY_PATH = path.join(__dirname, '../data/aggregator-summary.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');

// Mirrors review-file-writer.js's lazy-loaded sibling index / category cache
// (BRO-363): extract-dtli-reviews.js writes via safeWriteReview, not
// createOrMergeReviewFile, so it never got the cross-market sibling reroute
// guard (classifyMarketRouting) that review-file-writer.js's Guard A applies.
// The archive is a full sweep of whatever .html files exist in
// data/aggregator-archive/dtli/ with no URL-mapping gate — a stale archive
// file fetched under a REGIONAL show's id but containing its Broadway
// transfer's page content (Two Strangers, found 2026-08-15) writes straight
// through under the wrong show id every time this script runs.
let _siblingIndexCache = null;
function _getSiblingIndex() {
  if (_siblingIndexCache) return _siblingIndexCache;
  try {
    const shows = require(SHOWS_PATH).shows;
    _siblingIndexCache = buildSiblingIndex(shows);
  } catch {
    _siblingIndexCache = new Map();
  }
  return _siblingIndexCache;
}

let _showCategoryCache = null;
function _getShowCategory(showId) {
  if (!_showCategoryCache) {
    try {
      const shows = require(SHOWS_PATH).shows;
      _showCategoryCache = {};
      for (const s of shows) {
        if (s.id && s.category) _showCategoryCache[s.id] = s.category;
      }
    } catch {
      _showCategoryCache = {};
    }
  }
  return _showCategoryCache[showId] || null;
}

/**
 * Load aggregator summary data
 */
function loadAggregatorSummary() {
  if (fs.existsSync(AGGREGATOR_SUMMARY_PATH)) {
    return JSON.parse(fs.readFileSync(AGGREGATOR_SUMMARY_PATH, 'utf8'));
  }
  return {
    _meta: {
      lastUpdated: null,
      description: 'Show-level summary data from all aggregators (DTLI, BWW, Show Score)'
    },
    dtli: {},
    bww: {},
    showScore: {}
  };
}

/**
 * Save aggregator summary data
 */
function saveAggregatorSummary(data) {
  data._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(AGGREGATOR_SUMMARY_PATH, JSON.stringify(data, null, 2));
}

/**
 * Extract DTLI thumb counts from HTML
 */
function extractDTLIThumbCounts(content) {
  const thumbUpMatch = content.match(/thumbs-up\/thumb-(\d+)\.png/);
  const thumbMehMatch = content.match(/thumbs-meh\/thumb-(\d+)\.png/);
  const thumbDownMatch = content.match(/thumbs-down\/thumb-(\d+)\.png/);

  return {
    up: thumbUpMatch ? parseInt(thumbUpMatch[1]) : 0,
    meh: thumbMehMatch ? parseInt(thumbMehMatch[1]) : 0,
    down: thumbDownMatch ? parseInt(thumbDownMatch[1]) : 0
  };
}

/**
 * Extract DTLI URL from archived HTML header
 */
function extractDTLIUrl(content) {
  const urlMatch = content.match(/Source:\s*(https?:\/\/[^\n]+)/);
  return urlMatch ? urlMatch[1].trim() : null;
}

/**
 * Normalize outlet using the canonical module.
 * Returns { name, outletId } structure expected by this script.
 */
function normalizeOutlet(outlet) {
  const outletId = canonicalNormalizeOutlet(outlet);
  const name = getOutletDisplayName(outletId);
  return { name, outletId };
}

function parseThumb(thumbAlt) {
  if (!thumbAlt) return null;
  const alt = thumbAlt.toLowerCase();
  if (alt.includes('up')) return 'Up';
  if (alt.includes('down')) return 'Down';
  if (alt.includes('meh') || alt.includes('mid')) return 'Meh';
  return null;
}

/**
 * Clean HTML entities and tags from text
 */
function cleanText(text) {
  if (!text) return null;
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReviewsFromDTLI(content, showId) {
  const reviews = [];

  // Split by review-item and parse each (supports both review-item and poster-review-item)
  const parts = content.split(/<div class="(?:poster-)?review-item">/);

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    // Extract outlet - try review_image div first (most reliable), then aria-label in header
    let outletRaw = null;
    const divOutletMatch = part.match(/<div class="review_image"><div>([^<]+)<\/div><\/div>/);
    if (divOutletMatch) {
      outletRaw = divOutletMatch[1].trim();
    } else {
      // Fallback: aria-label within the review header only (not the whole chunk,
      // which can include footer ads with aria-label="Advertisement")
      const headerEnd = part.indexOf('review-item-date');
      const headerChunk = part.substring(0, headerEnd > 0 ? headerEnd : 500);
      const ariaLabelMatch = headerChunk.match(/aria-label="([^"]+)"/);
      if (ariaLabelMatch && ariaLabelMatch[1].toLowerCase() !== 'advertisement') {
        outletRaw = ariaLabelMatch[1];
      }
    }

    // Skip if we can't identify the outlet
    if (!outletRaw) continue;

    // Extract thumb from image alt
    const thumbMatch = part.match(/alt="(BigThumbs_[^"]+)"/);
    const thumb = thumbMatch ? parseThumb(thumbMatch[1]) : null;

    // Extract critic name. DTLI formats vary:
    //   "First<br/>Last" (most common — two-part name)
    //   "First Middle<br/>Last" (three-part name, one br)
    //   "Name" (single-line, no br — e.g., Madonna, or mononyms)
    //   "First<br/>Middle<br/>Last" (rare multi-br)
    //   wrapped in <a> or bare inside <h2>
    // The old regex `[^<]+<br\s*\/?>[^<]+` required exactly one <br/> and
    // truncated single-name critics to null. Mirrors scrape-dtli.js:292.
    const criticMatch = part.match(/class="review-item-critic-name"[^>]*>(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>|<\/h2>)/i);
    let criticName = null;
    if (criticMatch) {
      const cleaned = criticMatch[1]
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      criticName = cleaned || null;
    }

    // Extract date
    const dateMatch = part.match(/class="review-item-date"[^>]*>([^<]+)<\/h3>/);
    const dateStr = dateMatch ? dateMatch[1].trim() : null;

    // Extract excerpt text - handle multiple formats:
    // 1. Direct text in <p class="paragraph">text</p>
    // 2. Nested content: <p class="paragraph"></p><div class="entry-content">text</div>
    let fullText = null;

    // First try: direct paragraph content
    const textMatch = part.match(/class="paragraph"[^>]*>([\s\S]*?)<\/p>/);
    if (textMatch) {
      fullText = cleanText(textMatch[1]);
    }

    // If paragraph is empty or short, try entry-content div
    if (!fullText || fullText.length < 30) {
      const entryContentMatch = part.match(/<div class="entry-content">([\s\S]*?)<\/div>/);
      if (entryContentMatch) {
        const entryText = cleanText(entryContentMatch[1]);
        if (entryText && entryText.length > (fullText?.length || 0)) {
          fullText = entryText;
        }
      }
    }

    // Also try: grab all text between review-item-date and review-item-button
    if (!fullText || fullText.length < 30) {
      const betweenMatch = part.match(/review-item-date[^>]*>[^<]*<\/h3>\s*([\s\S]*?)<a[^>]*class="button-pink review-item-button"/);
      if (betweenMatch) {
        const betweenText = cleanText(betweenMatch[1]);
        if (betweenText && betweenText.length > (fullText?.length || 0)) {
          fullText = betweenText;
        }
      }
    }

    // Extract URL
    const urlMatch = part.match(/href="([^"]+)"[^>]*class="button-pink review-item-button"/);
    const url = urlMatch ? urlMatch[1] : null;

    // Skip reviews with very short excerpts (likely just a title or placeholder)
    if (!fullText || fullText.length < 30) continue;

    const outlet = normalizeOutlet(outletRaw);

    // URL is objective ground truth — if the review URL points to a known
    // outlet's domain and that outlet differs from what DTLI labeled it,
    // prefer the URL-derived outlet. DTLI has been observed misattributing
    // theguardian.com URLs as "Observer", etc. (Apr 2026, cats-the-jellicle-ball-2026)
    //
    // BRO-226: this refinement must never rewrite a real outlet's id ONTO an
    // aggregator outlet (e.g. a broken "read more" link that resolves back to
    // didtheylikeit.com itself) — that both destroys the real outlet's
    // attribution and launders the file past the aggregator-URL write guard,
    // which permits an aggregator-domain URL precisely when outletId IS the
    // aggregator. Same predicate the shared review-file-writer.js chokepoint
    // uses (shouldRefuseAggregatorOutletRefinement) — mirrored here since this
    // script writes via safeWriteReview, not createOrMergeReviewFile.
    //
    // #1524: also skip refinement when the DTLI-labeled outlet's own registry
    // entry already claims the URL's domain (outletOwnsUrlDomainIgnoringPath)
    // — shared-domain editions like Telegraph/Sunday Telegraph both resolve
    // to telegraph.co.uk, so without this a correctly-labeled "Sunday
    // Telegraph" review would get relabeled onto its sibling "Telegraph" just
    // because resolveOutletFromUrl() arbitrarily picks one domain owner. Same
    // guard gather-reviews.js's own extractDTLIReviews() already applies
    // (task #1506). #1529: bare domain ownership is NOT enough for a genuine
    // path-split domain like timeout.com/london vs /newyork — the path-aware
    // variant still lets a mislabeled Time Out (US) review refine to
    // timeout-london when the URL path says /london.
    let finalOutletId = outlet.outletId;
    let finalOutletName = outlet.name;
    if (url) {
      const urlResolved = resolveOutletFromUrl(url);
      if (urlResolved && urlResolved.outletId && urlResolved.outletId !== finalOutletId
          && !outletOwnsUrlDomainIgnoringPath(finalOutletId, url)) {
        if (shouldRefuseAggregatorOutletRefinement(urlResolved.outletId, finalOutletId)) {
          console.warn(`  ⛔ DTLI outlet refinement refused for ${showId}: URL=${urlResolved.outletId} (${url}) resolves to an aggregator — keeping DTLI label=${finalOutletId}`);
        } else {
          const registry = loadOutletRegistry();
          const urlOutletEntry = registry?.outlets?.[urlResolved.outletId];
          if (urlOutletEntry) {
            console.warn(`  ⚠️  DTLI outlet mismatch for ${showId}: URL=${urlResolved.outletId} (${url}) vs DTLI label=${finalOutletId}. Preferring URL.`);
            finalOutletId = urlResolved.outletId;
            finalOutletName = getOutletDisplayName(finalOutletId) || finalOutletName;
          }
        }
      }
    }

    // Session 3 #13 — canonicalize known mis-attributions at single-author outlets
    // (e.g., Cote Notices + "David Finkle" → "David Cote"). Same rule as gather-
    // reviews BWW RR extractor and rebuild-all-reviews.
    let finalCriticName = criticName;
    if (finalCriticName) {
      const canon = canonicalizeCritic(finalOutletId, finalCriticName);
      if (canon.canonicalized) {
        console.log(`  [DTLI canon] ${canon.from} → ${canon.name} (outletId=${finalOutletId})`);
        finalCriticName = canon.name;
      }
    }

    // Second chokepoint guard, mirrored for the same reason as above: refuse a
    // write that would leave a real outletId sitting on an aggregator-domain
    // URL with nothing worth preserving. In practice this is a no-op for DTLI's
    // own shape (source is always 'dtli', which isAggregatorReviewSource() treats
    // as exempt whenever dtliExcerpt is present, and it always is here — see the
    // length<30 skip above) — kept for parity with review-file-writer.js so a
    // future change to either side can't silently reopen the gap.
    if (shouldSkipAggregatorUrlWrite({ source: 'dtli', url, dtliExcerpt: fullText }, finalOutletId)) {
      console.warn(`  ⚠️  Skipping DTLI review for ${showId}: outletId "${finalOutletId}" with aggregator URL ${url} (roundup page, not this outlet's review)`);
      continue;
    }

    reviews.push({
      showId,
      outletId: finalOutletId,
      outlet: finalOutletName,
      criticName: finalCriticName,
      url,
      publishDate: normalizePublishDate(dateStr),
      dtliExcerpt: fullText,  // Store as excerpt since DTLI only provides excerpts
      fullText: null,          // Don't claim it's full text
      isFullReview: false,
      originalScore: null,
      assignedScore: null,
      dtliThumb: thumb,
      source: 'dtli'
    });
  }

  return reviews;
}

function saveReview(review, overwrite = false, dir = outputDir, _rerouteVisited) {
  // Guard A mirror (BRO-363): same cross-market sibling reroute
  // review-file-writer.js's createOrMergeReviewFile applies at its shared
  // chokepoint. This script writes via safeWriteReview instead, so without
  // this check a stale/mis-scoped archive page under a regional show's id
  // writes its Broadway sibling's reviews straight into the regional show's
  // directory on every extraction run.
  const visited = _rerouteVisited || new Set();
  visited.add(review.showId);
  const routingDecision = classifyMarketRouting({
    showId: review.showId,
    url: review.url,
    outletId: review.outletId,
    publishDate: review.publishDate,
    category: _getShowCategory(review.showId),
    visited,
    siblingIndex: _getSiblingIndex(),
  });
  if (routingDecision.action === 'reject') {
    console.warn(`  ⛔ Cross-market guard: rejecting ${review.outletId}/${review.criticName || 'Unknown'} for ${review.showId} — ${routingDecision.reason}`);
    return null;
  }
  if (routingDecision.action === 'reroute') {
    console.warn(`  ⚠️  Cross-market reroute: ${review.showId} → ${routingDecision.targetShowId} (${routingDecision.reason})`);
    return saveReview({ ...review, showId: routingDecision.targetShowId }, overwrite, dir, visited);
  }

  const showDir = path.join(dir, review.showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  // Use canonical filename for new files
  const filename = generateReviewFilename(review.outletId, review.criticName);
  let filepath = path.join(showDir, filename);

  // Guard: if the canonical path already exists and is a known syndicated duplicate
  // or has a duplicateOf reference, do not overwrite — findExistingReviewFile skips
  // duplicateOf files (they're not merge targets), so without this check a new DTLI
  // entry would blindly overwrite the file and lose isSyndicatedDuplicate/duplicateOf.
  if (!overwrite && fs.existsSync(filepath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      if (existing.isSyndicatedDuplicate === true || existing.duplicateOf) {
        return null; // Skip — preserves manual dedup flags
      }
    } catch { /* corrupt file — fall through and let normal logic handle */ }
  }

  // Task #653 follow-up (ship-check): keep the file's OWN url when we are about to
  // write over an existing file that findExistingReviewFile refused to hand back as
  // a merge target (i.e. it carries wrongProduction/duplicateOf). safeWriteReview
  // preserves PROTECTED_FIELDS, but a canonical URL change first triggers
  // applyUrlChangeInvariant, which deliberately clears wrongProduction,
  // wrongProductionNote, contentTier AND publishDate as "old-URL-derived" — and with
  // publishDate gone, flag-wrong-production-by-date can no longer re-derive the date
  // guard, so the review re-enters reviews.json permanently. DTLI's link is the
  // aggregator's, not necessarily the article's current URL; the existing merge
  // branch below already prefers `existing.url`, so do the same on this path.
  if (!overwrite && fs.existsSync(filepath)) {
    try {
      const onDisk = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      if (onDisk && onDisk.url && (onDisk.wrongProduction || onDisk.wrongShow)) {
        review = { ...review, url: onDisk.url };
      }
    } catch { /* corrupt file — fall through */ }
  }

  // Check for existing file under any outlet ID variant (canonical or legacy)
  const existingFile = !overwrite ? findExistingReviewFile(showDir, review.outletId, review.criticName) : null;
  if (existingFile && existingFile.data) {
    // Merge into the existing file (preserve its path/filename)
    filepath = existingFile.path;
    const existing = existingFile.data;
    review = {
      ...existing,
      // Always update DTLI-specific fields from this extraction
      dtliThumb: review.dtliThumb || existing.dtliThumb,
      dtliExcerpt: review.dtliExcerpt || existing.dtliExcerpt,
      // Preserve existing data
      fullText: existing.fullText || null,
      isFullReview: existing.isFullReview || false,
      showScoreExcerpt: existing.showScoreExcerpt || null,
      bwwExcerpt: existing.bwwExcerpt || null,
      bwwThumb: existing.bwwThumb || null,
      url: existing.url || review.url,
      publishDate: existing.publishDate || review.publishDate,
      originalScore: existing.originalScore || null,
      assignedScore: existing.assignedScore || null,
      llmScore: existing.llmScore || null,
      llmMetadata: existing.llmMetadata || null,
      ensembleData: existing.ensembleData || null,
      source: existing.source || review.source,
    };
  }

  // Route through the shared write chokepoint instead of a raw writeFileSync.
  //
  // Task #653 (corpus non-determinism): findExistingReviewFile DELIBERATELY skips
  // wrongProduction/duplicateOf files ("never a merge target"), so for every
  // already-flagged DTLI file `existingFile` came back null and the raw write
  // below clobbered the flagged file with a clean 12-field object — dropping
  // wrongProduction/wrongProductionNote/contentTier. The bare rebuild that runs
  // next in review-refresh.yml then re-included ~155 historical 2014-dated DTLI
  // excerpts across 92 shows and pushed that reviews.json to core-data; the
  // push-review-texts PROTECTED_FIELDS restore put the flags back in review-texts
  // afterwards, so the very next rebuild anywhere dropped them again. That is the
  // exact-revert ping-pong (19361 → 19510 → 19358 on 2026-08-02, 51 swings ≥40
  // reviews in 30 days). safeWriteReview's default merge preserves PROTECTED_FIELDS
  // from the file on disk, so a re-extraction can no longer resurrect contamination.
  safeWriteReview(filepath, review);
  return filepath;
}

// Export pure functions for unit testing. Top-level runner below only runs
// when invoked as a script (not when required from a test).
module.exports = { extractReviewsFromDTLI, saveReview };

if (require.main !== module) return;

// Task #653: routing the writes through safeWriteReview made this script "risky"
// in audit-help-flag-safety.js's eyes (Rule B), and correctly so — a bare `--help`
// used to run a full corpus-wide DTLI extraction. Bail before any real work.
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`
extract-dtli-reviews.js — extract reviews from archived DTLI (Did They Like It) pages

Usage:
  node scripts/extract-dtli-reviews.js

Reads every HTML page in data/aggregator-archive/dtli/ and writes one review file
per critic to data/review-texts/{showId}/{outletId}--{critic-slug}.json via
safeWriteReview (PROTECTED_FIELDS on the existing file always win).

Options:
  --help, -h   Show this message

No flags: the run is always a full sweep of the archived pages.
`.trim());
  return;
}

// Main
if (!fs.existsSync(dtliDir)) {
  console.error(`DTLI directory not found: ${dtliDir}`);
  process.exit(1);
}

const files = fs.readdirSync(dtliDir).filter(f => f.endsWith('.html'));

console.log('Extracting reviews from DTLI pages:\n');

let totalReviews = 0;
let totalShows = 0;
let totalUrls = 0;
let totalThumbsSaved = 0;

// Load aggregator summary for saving thumb counts
const aggregatorSummary = loadAggregatorSummary();

for (const file of files.sort()) {
  const filePath = path.join(dtliDir, file);
  const showId = file.replace('.html', '');
  const content = fs.readFileSync(filePath, 'utf-8');

  const reviews = extractReviewsFromDTLI(content, showId);

  // Extract and save thumb counts
  const thumbCounts = extractDTLIThumbCounts(content);
  const dtliUrl = extractDTLIUrl(content);

  if (thumbCounts.up > 0 || thumbCounts.meh > 0 || thumbCounts.down > 0) {
    aggregatorSummary.dtli[showId] = {
      up: thumbCounts.up,
      meh: thumbCounts.meh,
      down: thumbCounts.down,
      totalReviews: thumbCounts.up + thumbCounts.meh + thumbCounts.down,
      dtliUrl: dtliUrl,
      lastUpdated: new Date().toISOString()
    };
    totalThumbsSaved++;
  }

  if (reviews.length > 0) {
    totalShows++;
    let urlCount = 0;
    for (const review of reviews) {
      saveReview(review);
      totalReviews++;
      if (review.url) urlCount++;
    }
    totalUrls += urlCount;
    console.log(`${showId}: ${reviews.length} reviews (${urlCount} with URLs) [${thumbCounts.up}↑ ${thumbCounts.meh}↔ ${thumbCounts.down}↓]`);
  } else {
    console.log(`${showId}: 0 reviews found [${thumbCounts.up}↑ ${thumbCounts.meh}↔ ${thumbCounts.down}↓]`);
  }
}

// Save aggregator summary with all thumb counts
saveAggregatorSummary(aggregatorSummary);

console.log(`\n========================================`);
console.log(`Total: ${totalReviews} reviews from ${totalShows} shows`);
console.log(`Reviews with URLs: ${totalUrls}`);
console.log(`DTLI thumb counts saved: ${totalThumbsSaved} shows`);
console.log(`Saved to: ${outputDir}/`);
console.log(`Aggregator summary: ${AGGREGATOR_SUMMARY_PATH}`);
