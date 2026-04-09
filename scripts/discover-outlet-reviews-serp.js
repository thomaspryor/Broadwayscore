#!/usr/bin/env node
/**
 * @deprecated Use collect-outlet-reviews.js instead.
 * This per-outlet sweep has been replaced by per-show targeted queries with
 * date range filtering (calculateDateWindow + buildDateTbs). The new script
 * prevents cross-production contamination at the SERP query level.
 *
 * Outlet Review Discovery via SERP (DEPRECATED)
 *
 * Discovers reviews from specific outlets that aggregators miss by doing
 * site-scoped Google searches. Creates review stub files for new reviews.
 *
 * Unlike per-show SERP (which searches "outlet.com {show title}"), this does
 * site-scoped searches ("site:outlet.com theater review") to find ALL reviews
 * from an outlet, then matches them to shows.
 *
 * Usage:
 *   node scripts/discover-outlet-reviews-serp.js --outlet slantmagazine [options]
 *   node scripts/discover-outlet-reviews-serp.js --all              # run all configured outlets
 *
 * Options:
 *   --outlet OUTLET_ID      Discover reviews for a specific outlet
 *   --all                   Run all configured outlets
 *   --dry-run               Show discoveries without writing files
 *   --max-pages N           Max SERP pages to fetch (default: 3)
 */

const fs = require('fs');
const path = require('path');
const { matchTitleToShow, loadShows, cleanExternalTitle } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, generateReviewFilename, findExistingReviewFile } = require('./lib/review-normalization');
const { isUrlYearOutsideWindow } = require('./lib/content-filters');
const { validateUrlDomain } = require('./lib/url-discovery');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// Outlet configurations: domain, SERP query, URL pattern for title extraction
const OUTLET_CONFIGS = {
  'slantmagazine': {
    domain: 'slantmagazine.com',
    siteScope: 'slantmagazine.com/theater/',
    queries: [
      'site:slantmagazine.com/theater/ review broadway',
      'site:slantmagazine.com/theater/ review',
    ],
    outletName: 'Slant Magazine',
    // Extract show title from URL: /theater/{show-name}-review-{extra}/
    extractTitleFromUrl: (url) => {
      const m = url.match(/\/theater\/([^/]+?)(?:-review(?:-.+)?)?(?:\/|$)/);
      if (!m) return null;
      // The URL slug before "-review" is the show name
      let slug = m[1];
      // Remove trailing -review or -review-subtitle
      slug = slug.replace(/-review.*$/, '');
      return slug.replace(/-/g, ' ').trim();
    },
    // Critic is NOT reliably in the URL — the text after "review" is often a subtitle
    // Critic name will be extracted during text collection, not SERP discovery
    defaultCritic: 'Unknown',
    // Known critics for this outlet (for URL matching only)
    knownCritics: { 'dan-rubins': 'Dan Rubins' },
  },
  // TheaterScene.net: NOT included — poor Google indexing, SERP returns mostly
  // category/author pages instead of individual reviews. 348 reviews already
  // discovered via aggregator pipeline. If indexing improves, add config here.
  'stagebuddy': {
    domain: 'stagebuddy.com',
    siteScope: 'stagebuddy.com/theater/theater-review/',
    queries: [
      'site:stagebuddy.com/theater/theater-review/ broadway',
      'site:stagebuddy.com/theater/theater-review/',
    ],
    outletName: 'Stage Buddy',
    // URL: /theater/theater-review/{show-slug} (some have "review-" prefix)
    extractTitleFromUrl: (url) => {
      const m = url.match(/\/theater-review\/([^/?#]+)/);
      if (!m) return null;
      let slug = m[1].replace(/^review-/, '');
      return slug.replace(/-/g, ' ').trim();
    },
    defaultCritic: 'Unknown',
    knownCritics: {},
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// SERP via ScrapingBee Google Search API (same endpoint as url-discovery.js)
async function serpSearch(query, numResults = 10) {
  if (!SCRAPINGBEE_KEY) {
    console.error('  ✗ SCRAPINGBEE_API_KEY required');
    return [];
  }

  const axios = require('axios');
  try {
    const params = { api_key: SCRAPINGBEE_KEY, search: query };
    const resp = await axios.get('https://app.scrapingbee.com/api/v1/store/google', {
      params,
      timeout: 30000,
    });
    const data = resp.data;
    const results = data.organic_results || data.results || [];
    return results.map(r => ({
      url: r.url || r.link,
      title: r.title || '',
      description: r.description || '',
    }));
  } catch (err) {
    console.error(`  ✗ SERP error: ${err.response?.status || err.message}`);
    return [];
  }
}

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { outlets: [], dryRun: false, maxPages: 3 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--outlet': opts.outlets.push(args[++i]); break;
      case '--all': opts.outlets = Object.keys(OUTLET_CONFIGS); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--max-pages': opts.maxPages = parseInt(args[++i]); break;
    }
  }
  if (opts.outlets.length === 0) {
    console.error('Usage: node scripts/discover-outlet-reviews-serp.js --outlet slantmagazine|--all [--dry-run]');
    console.error('Available outlets:', Object.keys(OUTLET_CONFIGS).join(', '));
    process.exit(1);
  }
  return opts;
}

// Words too generic to count as meaningful overlap
const GENERIC_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'for', 'to',
  'is', 'it', 'my', 'all', 'be', 'or', 'no', 'so', 'do', 'we',
  'up', 'if', 'me', 'us', 'by', 'with', 'from', 'new', 'out',
  'how', 'now', 'not', 'but', 'one', 'two', 'has', 'had', 'was',
  'review', 'broadway', 'musical', 'play', 'show',
]);

// Extract year from SERP result URL path or title
// Returns null when no year found (expected for many outlets — harmless)
function extractYearFromSerpResult(result) {
  const urlMatch = (result.url || '').match(/\/((?:19|20)\d{2})\//);
  if (urlMatch) return parseInt(urlMatch[1]);
  const titleMatch = (result.title || '').match(/\b((?:19|20)\d{2})\b/);
  if (titleMatch) return parseInt(titleMatch[1]);
  return null;
}

// Match a SERP result to a show
function matchResultToShow(result, config, shows) {
  // Try extracting title from URL
  let candidateTitle = config.extractTitleFromUrl?.(result.url);
  if (!candidateTitle) {
    // Try extracting from SERP title (format: "'Show Title' Review: ...")
    const titleMatch = result.title.match(/^['"']?([^'"']+?)['"']?\s+Review/i);
    if (titleMatch) candidateTitle = titleMatch[1];
  }
  if (!candidateTitle) return null;

  candidateTitle = cleanExternalTitle(candidateTitle);
  const serpYear = extractYearFromSerpResult(result);
  const matched = matchTitleToShow(candidateTitle, shows, { market: 'broadway', ...(serpYear ? { year: serpYear } : {}) });
  if (!matched?.show) return null;
  if (matched.confidence !== 'high') return null;

  // Guard against false matches where candidate and show share only one short word
  // e.g., "life and trust" matching "Life of Pi" via the single word "life"
  const stripPunct = w => w.replace(/[^a-z0-9]/g, '');
  const candidateWords = candidateTitle.toLowerCase().split(/[\s,]+/)
    .map(stripPunct).filter(w => w.length > 2 && !GENERIC_WORDS.has(w));
  const showWords = (matched.show.title || '').toLowerCase().split(/[\s,]+/)
    .map(stripPunct).filter(w => w.length > 2 && !GENERIC_WORDS.has(w));
  if (candidateWords.length >= 2) {
    if (showWords.length >= 1) {
      const overlap = candidateWords.filter(w => showWords.includes(w)).length;
      if (overlap <= 1 && overlap < candidateWords.length) {
        return null; // Too little overlap — likely false match
      }
    } else {
      // Show has 0 meaningful words (e.g., "The New One", "Play On!")
      // Check if raw show title appears in candidate as a safety net
      const rawShow = (matched.show.title || '').toLowerCase().replace(/[!?.,]/g, '').trim();
      if (!candidateTitle.toLowerCase().includes(rawShow)) {
        return null; // Candidate doesn't contain the show title at all
      }
    }
  }

  return { id: matched.show.id, confidence: matched.confidence, candidateTitle };
}

// Extract critic name from URL if possible
function extractCriticFromUrl(url, config) {
  // Check known critics map first
  for (const [slug, name] of Object.entries(config.knownCritics || {})) {
    if (url.includes(slug)) return name;
  }
  // Try outlet-specific extractor (e.g., TheaterScene has critic in URL path)
  if (config.extractCriticFromUrl) {
    const critic = config.extractCriticFromUrl(url);
    if (critic) return critic;
  }
  return config.defaultCritic || 'Unknown';
}

async function discoverForOutlet(outletId, config, shows, opts) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Discovering reviews for: ${config.outletName} (${outletId})`);
  console.log(`${'='.repeat(60)}`);

  const stats = { searched: 0, results: 0, matched: 0, newFiles: 0, existing: 0 };
  const seenUrls = new Set();

  for (const query of config.queries) {
    console.log(`\n  SERP: "${query}"`);
    const results = await serpSearch(query, 30);
    stats.searched++;
    console.log(`  Found ${results.length} results`);

    for (const result of results) {
      // Skip non-matching domains
      if (!result.url.includes(config.domain)) continue;
      // Skip duplicates
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      stats.results++;

      // Skip non-review pages (best-of lists, category pages, etc.)
      if (/\/(features|category|tag)\//i.test(result.url)) continue;

      const match = matchResultToShow(result, config, shows);
      if (!match) {
        console.log(`    ? No match: ${result.title.slice(0, 60)}`);
        continue;
      }
      // Reject low-confidence matches to avoid false associations
      if (match.confidence === 'low') {
        console.log(`    ? Low confidence: "${match.candidateTitle}" → ${match.id}`);
        continue;
      }

      // Reject results where URL year falls outside the show's production window
      const matchedShow = shows.find(s => s.id === match.id);
      if (matchedShow?.openingDate) {
        const openYear = new Date(matchedShow.openingDate).getFullYear();
        const closeYear = matchedShow.closingDate ? new Date(matchedShow.closingDate).getFullYear() : null;
        if (isUrlYearOutsideWindow(result.url, openYear, closeYear)) {
          stats.urlYearSkipped = (stats.urlYearSkipped || 0) + 1;
          console.log(`    ⊘ URL year outside window for ${match.id} — skipping`);
          continue;
        }
      }

      stats.matched++;
      const showId = match.id;
      const showDir = path.join(REVIEW_TEXTS_DIR, showId);
      const criticName = extractCriticFromUrl(result.url, config);
      const normOutlet = normalizeOutlet(config.outletName);
      const normCritic = normalizeCritic(criticName);
      const filename = generateReviewFilename(normOutlet, normCritic);

      // Guard: domain validation — reject URLs that don't match outlet's registered domain
      const domainCheck = validateUrlDomain(result.url, normOutlet);
      if (!domainCheck.valid) {
        stats.domainSkipped = (stats.domainSkipped || 0) + 1;
        console.log(`    ⊘ Domain mismatch: ${domainCheck.reason}`);
        continue;
      }

      // Check if review already exists
      const existing = findExistingReviewFile(showDir, normOutlet, normCritic, result.url);
      if (existing) {
        stats.existing++;
        continue;
      }

      console.log(`    ✓ NEW: ${match.candidateTitle} → ${showId} | ${criticName}`);

      if (opts.dryRun) continue;

      // Create review stub file
      if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });
      const reviewData = {
        showId,
        outletId: normOutlet,
        outlet: config.outletName,
        criticName: criticName,
        url: result.url,
        source: 'outlet-serp-discovery',
        sources: ['outlet-serp-discovery'],
        contentTier: 'stub',
        createdAt: new Date().toISOString(),
      };

      const filePath = path.join(showDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(reviewData, null, 2) + '\n');
      stats.newFiles++;
    }

    await sleep(2000); // Rate limit between SERP queries
  }

  console.log(`\n  Summary for ${config.outletName}:`);
  console.log(`    SERP searches: ${stats.searched}`);
  console.log(`    Results found: ${stats.results}`);
  console.log(`    Matched to shows: ${stats.matched}`);
  if (stats.domainSkipped) console.log(`    Domain-mismatch skipped: ${stats.domainSkipped}`);
  if (stats.urlYearSkipped) console.log(`    URL-year skipped: ${stats.urlYearSkipped}`);
  console.log(`    New review stubs: ${stats.newFiles}`);
  console.log(`    Already existing: ${stats.existing}`);

  return stats;
}

async function main() {
  const opts = parseArgs();
  const shows = loadShows(SHOWS_PATH);
  console.log(`Loaded ${shows.length} shows`);

  const totalStats = { searched: 0, results: 0, matched: 0, newFiles: 0, existing: 0 };

  for (const outletId of opts.outlets) {
    const config = OUTLET_CONFIGS[outletId];
    if (!config) {
      console.error(`Unknown outlet: ${outletId}. Available: ${Object.keys(OUTLET_CONFIGS).join(', ')}`);
      continue;
    }

    const stats = await discoverForOutlet(outletId, config, shows, opts);
    for (const k of Object.keys(totalStats)) totalStats[k] += stats[k];
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('TOTAL RESULTS');
  console.log(`  SERP searches: ${totalStats.searched}`);
  console.log(`  Results found: ${totalStats.results}`);
  console.log(`  Matched to shows: ${totalStats.matched}`);
  console.log(`  New review stubs: ${totalStats.newFiles}`);
  console.log(`  Already existing: ${totalStats.existing}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
