#!/usr/bin/env node

/**
 * Audit Aggregator Coverage — Compare what each aggregator has vs what we extracted
 *
 * Checks all 5 aggregator sources (DTLI, Show Score, BWW, Playbill Verdict, NYC Theatre)
 * against local review-texts/ files to find coverage gaps.
 *
 * This script is READ-ONLY — it never triggers collection or re-scraping.
 *
 * Usage:
 *   node scripts/audit-aggregator-coverage.js                  # Full audit, all shows
 *   node scripts/audit-aggregator-coverage.js --show=art-2025  # Single show
 *   node scripts/audit-aggregator-coverage.js --status=open    # Filter by status
 *   node scripts/audit-aggregator-coverage.js --verbose        # Print every show
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Import existing counting functions for DTLI, Show Score, BWW
const { extractShowScoreCount, extractDTLICount, extractBWWCount } = require('./build-aggregator-truth.js');

// Paths
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const PV_ARCHIVE = path.join(__dirname, '../data/aggregator-archive/playbill-verdict');
const NYC_ARCHIVE = path.join(__dirname, '../data/aggregator-archive/nyc-theatre');
const OUTPUT_PATH = path.join(__dirname, '../data/audit/aggregator-coverage.json');

// ============================================================
// Step 0: Source name normalization map (verified against corpus)
// ============================================================

const SOURCE_TO_AGGREGATOR = {
  'dtli': 'dtli',
  'bww-roundup': 'bww',
  'show-score': 'showScore',
  'show-score-playwright': 'showScore',
  'playbill-verdict': 'playbillVerdict',
  'nyc-theatre': 'nycTheatre',
};

// Non-aggregator sources — valid but not counted per-aggregator
const KNOWN_OTHER_SOURCES = new Set([
  'web-search', 'nysr-api', 'reviews-json-stub', 'playwright-scraped',
  'scraped', 'webfetch-scraped', 'manual',
]);

// Playbill Verdict link exclusion domains (from scrape-playbill-verdict.js lines 285-304)
const PV_EXCLUDED_DOMAINS = [
  'playbill.com', 'playbillder.com', 'playbillstore.com', 'playbilltravel.com', 'playbillvault.com',
  'facebook.com', 'twitter.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'threads.net',
  'ticketmaster', 'telecharge', 'todaytix', 'seatgeek',
  '.ffm.to', 'spotify.com', 'apple.com', 'amazon.com',
  'americanrepertorytheater.org', 'americantheatrewing.org',
  'wikipedia.org', 'google.com',
  'eugeneoneillbroadway.com', '2st.com', 'roundabouttheatre.org',
  'broadwayinhollywood.com', 'minskoffbroadway.com', 'shubert.nyc',
  'criterionticketing.com', 'didtheylikeit.com', 'broadwaybox.com',
  'nbc.com', 'yahoo.com', 'people.com',
];

// ============================================================
// Step 1: Per-Source Local Counting
// ============================================================

function countLocalReviewsBySources(showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return { total: 0, byAggregator: {} };

  const files = fs.readdirSync(showDir)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  let total = 0;
  const byAggregator = {};
  const unknownSources = new Set();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      if (data.wrongProduction || data.wrongShow) continue;
      total++;

      // Get all sources that discovered this review
      const sources = data.sources || (data.source ? [data.source] : []);
      for (const src of sources) {
        const aggKey = SOURCE_TO_AGGREGATOR[src];
        if (aggKey) {
          byAggregator[aggKey] = (byAggregator[aggKey] || 0) + 1;
        } else if (!KNOWN_OTHER_SOURCES.has(src)) {
          unknownSources.add(src);
        }
      }
    } catch (e) {
      total++; // Count unparseable files conservatively
    }
  }

  return { total, byAggregator, unknownSources };
}

// ============================================================
// Step 2: Aggregator Archive Counting (NEW: Playbill Verdict + NYC Theatre)
// ============================================================

/**
 * Count review links in a Playbill Verdict archived HTML page.
 * Uses the same selector and exclusion list as scrape-playbill-verdict.js.
 */
function extractPlaybillVerdictCount(showId) {
  const archivePath = path.join(PV_ARCHIVE, `${showId}.html`);

  if (!fs.existsSync(archivePath)) {
    return { reviewCount: null, hasArchive: false };
  }

  try {
    const stat = fs.statSync(archivePath);
    if (stat.size < 1024) {
      return { reviewCount: 0, hasArchive: true, method: 'too-small' };
    }

    const html = fs.readFileSync(archivePath, 'utf8');
    const $ = cheerio.load(html);

    // Same container selector as scrape-playbill-verdict.js line 275
    const articleContent = $('article, .article-content, .article-body, .entry-content, main').first();
    const container = articleContent.length ? articleContent : $.root();

    let count = 0;
    const seenUrls = new Set();

    container.find('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.length < 20) return;

      // Apply same exclusion list as scrape-playbill-verdict.js lines 285-304
      if (PV_EXCLUDED_DOMAINS.some(d => href.includes(d))) return;

      // Must have a path (not just a domain root)
      try {
        const urlObj = new URL(href);
        if (urlObj.pathname === '/' || urlObj.pathname === '') return;

        // Deduplicate by URL
        const normalized = urlObj.origin + urlObj.pathname;
        if (seenUrls.has(normalized)) return;
        seenUrls.add(normalized);

        count++;
      } catch (e) {
        return;
      }
    });

    return { reviewCount: count, hasArchive: true, method: 'link-count' };
  } catch (error) {
    return { reviewCount: null, hasArchive: true, error: error.message };
  }
}

/**
 * Count review outlets in a NYC Theatre Roundup archived HTML page.
 * Uses the same section detection as scrape-nyc-theatre-roundups.js.
 */
function extractNYCTheatreCount(showId) {
  const archivePath = path.join(NYC_ARCHIVE, `${showId}.html`);

  if (!fs.existsSync(archivePath)) {
    return { reviewCount: null, hasArchive: false };
  }

  try {
    const stat = fs.statSync(archivePath);
    if (stat.size < 1024) {
      return { reviewCount: 0, hasArchive: true, method: 'too-small' };
    }

    const html = fs.readFileSync(archivePath, 'utf8');
    const $ = cheerio.load(html);

    let inReviewSection = false;
    let outletCount = 0;

    $('h2, h3, h4, h5, p, blockquote').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().trim().replace(/\s+/g, ' ');

      // Detect review section start
      if (['h2', 'h3'].includes(tag)) {
        if (/^the reviews$/i.test(text) || /what.*critics|reviews? are in|critics? thought/i.test(text)) {
          inReviewSection = true;
          return;
        }
        // Detect section end
        if (inReviewSection) {
          if (/more reviews|news.*tickets|need help|connect with/i.test(text)) {
            inReviewSection = false;
            return;
          }
          if (text.length < 50 && !text.includes('"') && !/reviews?|critics?/i.test(text)) {
            inReviewSection = false;
            return;
          }
        }
      }

      // Count outlet headings within review section
      if (inReviewSection && ['h4', 'h5'].includes(tag) && text.length > 0 && text.length < 100) {
        outletCount++;
      }

      // Pattern B fallback: "quote text" - Outlet Name
      if (inReviewSection && ['p', 'blockquote'].includes(tag) && outletCount === 0) {
        const trailingMatch = text.match(/["\u201d']\s*[-\u2013\u2014]\s*([A-Z][A-Za-z\s.&']{2,50})\s*$/);
        if (trailingMatch) {
          outletCount++;
        }
      }
    });

    return { reviewCount: outletCount, hasArchive: true, method: outletCount > 0 ? 'headings' : 'none-found' };
  } catch (error) {
    return { reviewCount: null, hasArchive: true, error: error.message };
  }
}

// ============================================================
// Step 3: Gap Detection + Report
// ============================================================

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w[\w-]*)(?:=(.*))?$/);
    if (match) {
      args[match[1]] = match[2] !== undefined ? match[2] : true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs();
  const showFilter = args.show || null;
  const statusFilter = args.status || null;
  const verbose = args.verbose || false;

  console.log('=== Aggregator Coverage Audit ===\n');

  // Load shows
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  let shows = showsData.shows || showsData;
  if (!Array.isArray(shows)) shows = Object.values(shows);

  // Apply filters
  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`No show found with id/slug: ${showFilter}`);
      process.exit(1);
    }
  }
  if (statusFilter) {
    shows = shows.filter(s => s.status === statusFilter);
  }

  console.log(`Shows to audit: ${shows.length}\n`);

  // Source name validation (Step 0): scan a sample of files
  const allUnknownSources = new Set();

  // Stats
  const archiveStats = { dtli: 0, showScore: 0, bww: 0, playbillVerdict: 0, nycTheatre: 0 };
  const gapStats = { dtli: 0, showScore: 0, bww: 0, playbillVerdict: 0, nycTheatre: 0 };
  const missingStats = { dtli: 0, showScore: 0, bww: 0, playbillVerdict: 0, nycTheatre: 0 };
  const overStats = { dtli: 0, showScore: 0, bww: 0, playbillVerdict: 0, nycTheatre: 0 };
  const neverSearched = { dtli: 0, showScore: 0, bww: 0, playbillVerdict: 0, nycTheatre: 0 };
  let showsWithGaps = 0;
  let totalMissingReviews = 0;

  const allShowData = {};

  for (const show of shows) {
    const showId = show.id;

    // Step 1: Count local reviews per source
    const local = countLocalReviewsBySources(showId);
    for (const src of local.unknownSources || []) {
      allUnknownSources.add(src);
    }

    // Step 2: Count from each aggregator archive
    const dtli = extractDTLICount(showId);
    const showScore = extractShowScoreCount(showId);
    const bww = extractBWWCount(showId);
    const playbillVerdict = extractPlaybillVerdictCount(showId);
    const nycTheatre = extractNYCTheatreCount(showId);

    // Step 3: Gap detection
    const aggregators = {};
    let hasGap = false;
    let totalGap = 0;
    const flags = [];

    const sources = [
      { key: 'dtli', data: dtli },
      { key: 'showScore', data: showScore },
      { key: 'bww', data: bww },
      { key: 'playbillVerdict', data: playbillVerdict },
      { key: 'nycTheatre', data: nycTheatre },
    ];

    for (const { key, data } of sources) {
      const extracted = local.byAggregator[key] || 0;
      let gap = null;

      if (data.hasArchive && data.reviewCount !== null) {
        gap = data.reviewCount - extracted;
        archiveStats[key]++;

        if (gap > 0) {
          hasGap = true;
          totalGap += gap;
          gapStats[key]++;
          missingStats[key] += gap;
          totalMissingReviews += gap;
          flags.push(`${key}-under-${gap}`);
        } else if (gap < 0) {
          overStats[key]++;
          flags.push(`${key}-over-${Math.abs(gap)}`);
        }

        // Wrong page detection
        if (data.reviewCount === 0 && local.total > 5) {
          flags.push(`${key}-wrong-page`);
        }
      } else if (!data.hasArchive) {
        neverSearched[key]++;
        flags.push(`${key}-no-archive`);
      }

      aggregators[key] = {
        archiveCount: data.reviewCount,
        extractedCount: extracted,
        gap,
        hasArchive: data.hasArchive,
        ...(data.method && { method: data.method }),
        ...(data.error && { error: data.error }),
      };
    }

    if (hasGap) showsWithGaps++;

    const maxAggregatorCount = Math.max(
      ...sources.map(s => s.data.reviewCount || 0)
    );

    allShowData[showId] = {
      title: show.title,
      status: show.status,
      totalLocal: local.total,
      hasGap,
      totalGap,
      aggregators,
      maxAggregatorCount,
      flags,
    };

    // Console output per show
    if (verbose || showFilter) {
      const parts = sources.map(({ key, data }) => {
        const extracted = local.byAggregator[key] || 0;
        const archive = data.reviewCount !== null ? data.reviewCount : '-';
        const gap = data.reviewCount !== null ? data.reviewCount - extracted : null;
        const marker = gap > 0 ? ` (GAP ${gap})` : gap < 0 ? ` (OVER ${Math.abs(gap)})` : '';
        return `${key}=${archive}/${extracted}${marker}`;
      });
      console.log(`${showId}: Local=${local.total} | ${parts.join(', ')}${flags.length > 0 ? ' | FLAGS: ' + flags.join(', ') : ''}`);
    }
  }

  // Source name warnings
  if (allUnknownSources.size > 0) {
    console.log(`\n[WARN] Unknown source values found (not in SOURCE_TO_AGGREGATOR or KNOWN_OTHER_SOURCES):`);
    for (const src of allUnknownSources) {
      console.log(`  - "${src}"`);
    }
  }

  // Build output
  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      description: 'Per-show per-aggregator review coverage audit (read-only)',
      totalShows: shows.length,
      showsWithGaps,
      totalMissingReviews,
      ...(showFilter && { showFilter }),
      ...(statusFilter && { statusFilter }),
    },
    summary: {
      archiveCounts: { ...archiveStats },
      totalGaps: { ...gapStats },
      totalMissing: { ...missingStats },
      totalOverExtracted: { ...overStats },
      showsNeverSearched: { ...neverSearched },
    },
    shows: allShowData,
  };

  // Write output
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote: ${OUTPUT_PATH}`);

  // Print summary
  console.log('\n========================================');
  console.log('Summary');
  console.log('========================================');
  console.log(`Shows audited: ${shows.length}`);
  console.log(`Archives: DTLI=${archiveStats.dtli}, SS=${archiveStats.showScore}, BWW=${archiveStats.bww}, PV=${archiveStats.playbillVerdict}, NYC=${archiveStats.nycTheatre}`);
  console.log(`Shows with gaps: ${showsWithGaps}`);
  console.log(`Total missing reviews: ${totalMissingReviews}`);

  console.log('\nPer-aggregator:');
  for (const key of ['dtli', 'showScore', 'bww', 'playbillVerdict', 'nycTheatre']) {
    const label = { dtli: 'DTLI', showScore: 'Show Score', bww: 'BWW', playbillVerdict: 'Playbill Verdict', nycTheatre: 'NYC Theatre' }[key];
    console.log(`  ${label.padEnd(17)} ${gapStats[key]} under-extracted (${missingStats[key]} missing), ${overStats[key]} over-extracted, ${neverSearched[key]} never searched`);
  }

  // Top gaps (open shows first, then by totalGap descending)
  const sortedShows = Object.entries(allShowData)
    .filter(([, d]) => d.hasGap)
    .sort((a, b) => {
      const aOpen = a[1].status === 'open' ? 1 : 0;
      const bOpen = b[1].status === 'open' ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      return b[1].totalGap - a[1].totalGap;
    });

  if (sortedShows.length > 0) {
    const topN = Math.min(sortedShows.length, verbose ? sortedShows.length : 20);
    console.log(`\nTop ${topN} gaps${!verbose && sortedShows.length > 20 ? ` (of ${sortedShows.length} total — use --verbose for all)` : ''}:`);
    for (let i = 0; i < topN; i++) {
      const [id, data] = sortedShows[i];
      const gapParts = Object.entries(data.aggregators)
        .filter(([, a]) => a.gap > 0)
        .map(([key, a]) => `${key}=${a.archiveCount}/${a.extractedCount}(gap ${a.gap})`)
        .join(', ');
      const status = data.status === 'open' ? ' [OPEN]' : '';
      console.log(`  ${(i + 1).toString().padStart(3)}. ${id}${status}: ${gapParts}`);
    }
  }
}

main();
