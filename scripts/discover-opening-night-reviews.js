#!/usr/bin/env node
/**
 * discover-opening-night-reviews.js
 *
 * Proactively discovers reviews from top outlets on opening night using
 * Google SERP searches — no reliance on aggregator sites.
 *
 * Two strategies:
 *   1. Site-specific: `site:{domain} "{showTitle}" [Broadway|West End] review {year}`
 *      for each Tier 1 + Tier 2 outlet (market-specific outlet lists)
 *   2. Google News: `"{showTitle}" [Broadway|West End] review` filtered to recent
 *      results (~2-3 searches, catches unlisted outlets)
 *
 * Writes review-text stubs to data/review-texts/{showId}/ for the rebuild
 * pipeline to pick up.
 *
 * Usage: node scripts/discover-opening-night-reviews.js --show=SLUG [--dry-run] [--tiers=1,2]
 *
 * Env: SCRAPINGBEE_API_KEY
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet, normalizeCritic, generateReviewFilename, getOutletDisplayName } = require('./lib/review-normalization');

const DRY_RUN = process.argv.includes('--dry-run');
const SHOW_ARG = process.argv.find(a => a.startsWith('--show='));
const TIERS_ARG = process.argv.find(a => a.startsWith('--tiers='));

if (!SHOW_ARG) {
  console.log('Usage: node scripts/discover-opening-night-reviews.js --show=SLUG [--dry-run] [--tiers=1,2]');
  process.exit(0);
}

const TARGET_SHOW = SHOW_ARG.split('=')[1];
const TIERS = (TIERS_ARG ? TIERS_ARG.split('=')[1] : '1,2').split(',').map(Number);

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');

// Import shared outlet domains from url-discovery
const { OUTLET_DOMAINS } = (() => {
  try {
    // Read the module to get OUTLET_DOMAINS without importing axios dependency
    const src = fs.readFileSync(path.join(__dirname, 'lib', 'url-discovery.js'), 'utf8');
    const match = src.match(/const OUTLET_DOMAINS = \{[\s\S]*?\n\};/);
    if (match) {
      const mod = {};
      eval(`mod.OUTLET_DOMAINS = ${match[0].replace('const OUTLET_DOMAINS = ', '')}`);
      return mod;
    }
  } catch { /* fall through */ }
  return { OUTLET_DOMAINS: {} };
})();

// Tier 1/2 outlet lists — derived from outlet-registry.json (single source of truth).
// Includes canonical IDs + aliases so OUTLET_DOMAINS lookup works with either form.
// BW: non-London outlets (or dual-market). WE: London outlets (or dual-market).
const _reg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8')); }
  catch { return { outlets: {} }; }
})();
const TIER1_OUTLETS_BW = [];
const TIER2_OUTLETS_BW = [];
const TIER1_OUTLETS_WE = [];
const TIER2_OUTLETS_WE = [];
for (const [id, info] of Object.entries(_reg.outlets || {})) {
  if (info.tier !== 1 && info.tier !== 2) continue;
  const ids = [id, ...(info.aliases || []).map(a => a.toLowerCase())];
  const isLondon = info.region === 'london';
  const isDual = info.isDualMarket || false;
  // BW: include if not London-only (non-London or dual-market)
  if (!isLondon || isDual) {
    if (info.tier === 1) TIER1_OUTLETS_BW.push(...ids);
    else TIER2_OUTLETS_BW.push(...ids);
  }
  // WE: include if London or dual-market, plus any alias containing "london"
  if (isLondon || isDual) {
    if (info.tier === 1) TIER1_OUTLETS_WE.push(...ids);
    else TIER2_OUTLETS_WE.push(...ids);
  } else if (ids.some(i => i.includes('london'))) {
    // Catch London-specific aliases of non-London outlets (e.g., timeout-london)
    const londonIds = ids.filter(i => i.includes('london'));
    if (info.tier === 1) TIER1_OUTLETS_WE.push(...londonIds);
    else TIER2_OUTLETS_WE.push(...londonIds);
  }
}

// Aggregator domains to exclude from News results
const AGGREGATOR_DOMAINS = [
  'broadwayworld.com', 'didtheylikeit.com', 'show-score.com',
  'playbill.com', 'nyctheatre.com', 'wikipedia.org',
];

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugifyHostname(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Search Google via ScrapingBee SERP API.
 */
async function searchGoogle(query, apiKey, nbResults = 5) {
  const url = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}&nb_results=${nbResults}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        const status = res.status;
        if ((status === 429 || status >= 500) && attempt < 2) {
          console.log(`    SERP ${status}, retrying in ${(attempt + 1) * 5}s...`);
          await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
          continue;
        }
        throw new Error(`SERP ${status}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = await res.json();
      return data.organic_results || data.results || [];
    } catch (err) {
      if (attempt < 2 && (err.name === 'TimeoutError' || err.message.includes('timeout') || err.message.includes('ECONNRESET'))) {
        console.log(`    SERP timeout, retrying in ${(attempt + 1) * 5}s...`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
        continue;
      }
      throw err;
    }
  }
  return [];
}

/**
 * Get existing review URLs for a show to avoid duplicates.
 */
function getExistingUrls(showId) {
  const urls = new Set();
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return urls;

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (data.url) urls.add(data.url.toLowerCase());
    } catch { /* skip */ }
  }
  return urls;
}

/**
 * Extract outlet ID from a URL domain.
 */
function domainToOutletId(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    // Reverse lookup in OUTLET_DOMAINS
    for (const [id, domain] of Object.entries(OUTLET_DOMAINS)) {
      if (hostname === domain || hostname === `www.${domain}`) {
        return id;
      }
    }
    return normalizeOutlet(slugifyHostname(hostname.replace(/\.(com|org|net|co\.uk|me)$/, '')));
  } catch {
    return null;
  }
}

/**
 * Extract critic name from SERP result title (best effort).
 * Common patterns: "Review: Show Title - Name, Outlet" or "Show Title Review by Name"
 */
function extractCriticFromTitle(title) {
  // Pattern: "... by CriticName" or "... - CriticName"
  const byMatch = title.match(/\bby\s+([A-Z][a-z]+ [A-Z][a-z]+)/);
  if (byMatch) return byMatch[1];

  const dashMatch = title.match(/\s[-–—]\s+([A-Z][a-z]+ [A-Z][a-z]+)\s*$/);
  if (dashMatch) return dashMatch[1];

  return 'Unknown';
}

function isAggregatorUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return AGGREGATOR_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function isReviewUrl(url, title) {
  const lower = (title || '').toLowerCase() + ' ' + (url || '').toLowerCase();
  return lower.includes('review') || lower.includes('critic') || lower.includes('verdict');
}

async function main() {
  const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
  if (!SCRAPINGBEE_KEY) {
    console.error('Missing SCRAPINGBEE_API_KEY');
    process.exit(1);
  }

  console.log('Opening Night Review Discovery');
  console.log('==============================\n');
  if (DRY_RUN) console.log('** DRY RUN — no files will be written **\n');

  // Load show data
  const showsData = loadJSON(SHOWS_PATH);
  if (!showsData) { console.error('Cannot load shows.json'); process.exit(1); }
  const showsArr = showsData.shows || showsData;
  const showsList = Array.isArray(showsArr) ? showsArr : Object.values(showsArr);

  const show = showsList.find(s => s.id === TARGET_SHOW || s.slug === TARGET_SHOW);
  if (!show) {
    console.error(`Show not found: ${TARGET_SHOW}`);
    process.exit(1);
  }

  const showId = show.id || show.slug;
  const showTitle = show.title;
  const year = (show.openingDate || '').substring(0, 4);

  const isWestEnd = show.category === 'west-end';
  const marketLabel = isWestEnd ? 'West End' : 'Broadway';
  const reviewKeyword = isWestEnd ? 'West End review' : 'Broadway review';

  console.log(`Show: ${showTitle} (${showId})`);
  console.log(`Market: ${marketLabel}`);
  console.log(`Year: ${year}`);
  console.log(`Tiers: ${TIERS.join(', ')}\n`);

  // Get existing URLs to dedup
  const existingUrls = getExistingUrls(showId);
  console.log(`Existing review files: ${existingUrls.size} URLs\n`);

  // Ensure review-texts directory exists
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!DRY_RUN && !fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  let discovered = 0;
  let searched = 0;
  let skippedDupe = 0;

  // === Strategy 1: Site-specific SERP for each outlet ===
  const TIER1_OUTLETS = isWestEnd ? TIER1_OUTLETS_WE : TIER1_OUTLETS_BW;
  const TIER2_OUTLETS = isWestEnd ? TIER2_OUTLETS_WE : TIER2_OUTLETS_BW;
  const outletIds = [];
  if (TIERS.includes(1)) outletIds.push(...TIER1_OUTLETS);
  if (TIERS.includes(2)) outletIds.push(...TIER2_OUTLETS);

  // Deduplicate outlet domains (some IDs map to same domain)
  const searchedDomains = new Set();

  console.log(`Strategy 1: Site-specific search (${outletIds.length} outlets)...`);

  for (const outletId of outletIds) {
    const domain = OUTLET_DOMAINS[outletId];
    if (!domain || searchedDomains.has(domain)) continue;
    searchedDomains.add(domain);

    const query = `site:${domain} "${showTitle}" ${reviewKeyword}${year ? ` ${year}` : ''}`;

    try {
      const results = await searchGoogle(query, SCRAPINGBEE_KEY, 3);
      searched++;

      for (const result of results) {
        const url = result.url || result.link;
        if (!url) continue;

        // Dedup check
        if (existingUrls.has(url.toLowerCase())) {
          skippedDupe++;
          continue;
        }

        // Skip non-review pages
        if (!isReviewUrl(url, result.title)) continue;

        const criticName = extractCriticFromTitle(result.title || '');
        const discoveredOutletId = domainToOutletId(url) || outletId;

        console.log(`  FOUND: ${result.title?.slice(0, 80) || url}`);
        console.log(`         ${url}`);
        console.log(`         Outlet: ${discoveredOutletId}, Critic: ${criticName}`);

        if (!DRY_RUN) {
          const canonicalOutletId = normalizeOutlet(discoveredOutletId);
          const filename = generateReviewFilename(discoveredOutletId, criticName);
          const filepath = path.join(showDir, filename);

          // Don't overwrite existing files (scan all variants for canonical match)
          if (fs.existsSync(filepath)) {
            skippedDupe++;
            continue;
          }
          if (fs.existsSync(showDir)) {
            const criticSlug = normalizeCritic(criticName);
            const existingFiles = fs.readdirSync(showDir);
            const hasDupe = existingFiles.some(f => {
              const m = f.match(/^(.+?)--(.+)\.json$/);
              return m && normalizeOutlet(m[1]) === canonicalOutletId && m[2] === criticSlug;
            });
            if (hasDupe) {
              skippedDupe++;
              continue;
            }
          }

          const reviewData = {
            showId,
            outletId: canonicalOutletId,
            outlet: getOutletDisplayName(canonicalOutletId) || result.title?.split(/[-–—|]/)[0]?.trim() || canonicalOutletId,
            criticName: criticName || 'Unknown',
            url,
            publishDate: null,
            fullText: null,
            source: 'opening-night-discovery',
            contentTier: 'excerpt',
          };

          fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2));
        }

        existingUrls.add(url.toLowerCase());
        discovered++;
      }
    } catch (err) {
      console.error(`  Error searching ${domain}: ${err.message}`);
    }

    // Rate limit between SERP calls
    await sleep(500);
  }

  // === Strategy 2: Google News SERP ===
  console.log(`\nStrategy 2: Google News search...`);

  const newsQuery = `"${showTitle}" ${reviewKeyword}`;
  try {
    // Use tbs=qdr:d for past 24 hours
    const newsUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(newsQuery)}&nb_results=10&search_type=news`;

    let results = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(newsUrl, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) {
          if ((res.status === 429 || res.status >= 500) && attempt < 2) {
            await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
            continue;
          }
          throw new Error(`SERP ${res.status}`);
        }
        const data = await res.json();
        results = data.organic_results || data.news_results || data.results || [];
        break;
      } catch (err) {
        if (attempt < 2 && (err.name === 'TimeoutError' || err.message.includes('timeout'))) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
          continue;
        }
        throw err;
      }
    }
    searched++;

    for (const result of results) {
      const url = result.url || result.link;
      if (!url) continue;

      // Skip aggregators
      if (isAggregatorUrl(url)) continue;

      // Skip already known
      if (existingUrls.has(url.toLowerCase())) {
        skippedDupe++;
        continue;
      }

      // Skip non-reviews
      if (!isReviewUrl(url, result.title)) continue;

      const criticName = extractCriticFromTitle(result.title || '');
      const outletId = domainToOutletId(url) || 'unknown';

      console.log(`  FOUND (news): ${result.title?.slice(0, 80) || url}`);
      console.log(`         ${url}`);
      console.log(`         Outlet: ${outletId}, Critic: ${criticName}`);

      if (!DRY_RUN) {
        const canonicalOutletId = normalizeOutlet(outletId);
        const filename = generateReviewFilename(outletId, criticName);
        const filepath = path.join(showDir, filename);

        if (fs.existsSync(filepath)) {
          skippedDupe++;
          continue;
        }
        if (fs.existsSync(showDir)) {
          const criticSlug = normalizeCritic(criticName);
          const existingFiles = fs.readdirSync(showDir);
          const hasDupe = existingFiles.some(f => {
            const m = f.match(/^(.+?)--(.+)\.json$/);
            return m && normalizeOutlet(m[1]) === canonicalOutletId && m[2] === criticSlug;
          });
          if (hasDupe) {
            skippedDupe++;
            continue;
          }
        }

        const reviewData = {
          showId,
          outletId: canonicalOutletId,
          outlet: getOutletDisplayName(canonicalOutletId) || canonicalOutletId,
          criticName: criticName || 'Unknown',
          url,
          publishDate: null,
          fullText: null,
          source: 'opening-night-discovery',
          contentTier: 'excerpt',
        };

        fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2));
      }

      existingUrls.add(url.toLowerCase());
      discovered++;
    }
  } catch (err) {
    console.error(`  Error in news search: ${err.message}`);
  }

  console.log(`\nResults: ${discovered} new reviews discovered, ${skippedDupe} duplicates skipped, ${searched} SERP calls made`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
