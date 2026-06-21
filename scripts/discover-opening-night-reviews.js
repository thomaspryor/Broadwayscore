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
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { isUrlYearOutsideWindow } = require('./lib/content-filters');
const { OUTLET_DOMAINS: _OUTLET_DOMAINS } = require('./lib/url-discovery');
const { isLondonMarket } = require('./lib/venue-classification');

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

const OUTLET_DOMAINS = _OUTLET_DOMAINS;

// Tier 1/2 outlet lists — derived from outlet-registry.json (single source of truth).
// Includes canonical IDs + aliases so OUTLET_DOMAINS lookup works with either form.
// BW: non-London outlets (or dual-market). WE: London outlets (or dual-market).
const _reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8'));
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

// Domain filtering — use canonical source from domain-filters.js
const { isBlockedReviewUrl } = require('./lib/domain-filters');

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

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
let _scrapingBeeExhausted = false;
let _loggedNoProviders = false;

/**
 * Search Google via ScrapingBee SERP API, with BrightData SERP fallback.
 * Falls back to BrightData when ScrapingBee returns 401/403/429 (credits exhausted).
 */
async function searchGoogle(query, apiKey, nbResults = 5) {
  // Try ScrapingBee first (unless already exhausted)
  if (!_scrapingBeeExhausted && apiKey) {
    const results = await _serpViaScrapingBee(query, apiKey, nbResults);
    if (results !== null) return results;
  }

  // Fallback to BrightData SERP API
  if (BRIGHTDATA_TOKEN) {
    return await _serpViaBrightData(query);
  }

  if (!_loggedNoProviders) {
    console.log('    ⚠ All SERP providers unavailable — no search results');
    _loggedNoProviders = true;
  }
  return [];
}

async function _serpViaScrapingBee(query, apiKey, nbResults) {
  const url = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}&nb_results=${nbResults}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        const status = res.status;
        if (status === 401 || status === 403 || status === 429) {
          console.log(`    ⚠ ScrapingBee SERP exhausted (${status}) — falling back to BrightData`);
          _scrapingBeeExhausted = true;
          return null; // Signal to try BrightData
        }
        if (status >= 500 && attempt < 2) {
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

const BD_CUSTOMER = process.env.BRIGHTDATA_CUSTOMER || 'hl_a2c64a47';
const BD_ZONE = process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1';

async function _serpViaBrightData(query) {
  try {
    // Step 1: Submit async SERP request
    const submitRes = await fetch(
      `https://api.brightdata.com/serp/req?customer=${BD_CUSTOMER}&zone=${BD_ZONE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
        },
        body: JSON.stringify({ query: { q: query, gl: 'us' } }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!submitRes.ok) throw new Error(`BrightData submit ${submitRes.status}: ${(await submitRes.text()).slice(0, 200)}`);
    const submitData = await submitRes.json();
    const responseId = submitData.response_id;
    if (!responseId) throw new Error('No response_id from BrightData');

    // Step 2: Poll for results (max 20s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(
        `https://api.brightdata.com/serp/get_result?response_id=${responseId}`,
        {
          headers: { 'Authorization': `Bearer ${BRIGHTDATA_TOKEN}` },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (pollRes.status === 202) continue; // Still processing
      if (!pollRes.ok) throw new Error(`BrightData poll ${pollRes.status}`);
      const data = await pollRes.json();
      if (data.organic) {
        return data.organic.slice(0, 5).map(r => ({
          url: r.link || r.url || '',
          title: r.title || '',
        }));
      }
      // If no organic results yet, keep polling
      if (data.response_id) continue;
      return []; // Empty results
    }
    console.log('    ⚠ BrightData SERP timeout (20s) — returning empty');
    return [];
  } catch (err) {
    console.log(`    ✗ BrightData SERP error: ${err.message}`);
    return [];
  }
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
 * Count existing reviews per outlet domain for a show.
 * Returns Map<domain, count> for outlets with 2+ reviews.
 */
function getOutletReviewCounts(showId) {
  const counts = new Map(); // domain → count
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return counts;

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      // Skip flagged/invalid reviews
      if (data.wrongShow || data.wrongProduction || data.duplicateOf) continue;
      const outlet = data.outlet || file.split('--')[0];
      const domain = OUTLET_DOMAINS[outlet] || OUTLET_DOMAINS[normalizeOutlet(outlet)];
      if (domain) {
        counts.set(domain, (counts.get(domain) || 0) + 1);
      }
    } catch { /* skip */ }
  }
  return counts;
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
  return isBlockedReviewUrl(url);
}

function isReviewUrl(url, title) {
  const lower = (title || '').toLowerCase() + ' ' + (url || '').toLowerCase();
  return lower.includes('review') || lower.includes('critic') || lower.includes('verdict');
}

/**
 * Check if a SERP result title or URL mentions the target show.
 * Uses word-boundary matching so "Bug" doesn't match "debug", "Six" doesn't match "sixth".
 * Also checks URL slug and primary title (before : or -) for subtitled shows.
 */
const { serpResultMentionsShow } = require('./lib/serp-show-match');

async function main() {
  if (!SCRAPINGBEE_KEY && !BRIGHTDATA_TOKEN) {
    console.error('Missing SCRAPINGBEE_API_KEY and BRIGHTDATA_TOKEN — need at least one');
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

  const isWestEnd = isLondonMarket(show.category);
  const isOB = show.category === 'off-broadway';
  const marketLabel = isWestEnd ? 'West End' : isOB ? 'Off-Broadway' : 'Broadway';
  const reviewKeyword = isWestEnd ? 'West End review' : isOB ? 'Off-Broadway review' : 'Broadway review';

  // Calculate tight opening-night date range for SERP filtering
  const DAY = 86400000;
  const opening = show.openingDate ? new Date(show.openingDate) : null;
  let dateFilter = '';
  if (opening) {
    const dateMin = new Date(opening.getTime() - 7 * DAY);
    const dateMax = new Date(opening.getTime() + 14 * DAY);
    const fmtD = d => d.toISOString().split('T')[0];
    dateFilter = ` after:${fmtD(dateMin)} before:${fmtD(dateMax)}`;
  }

  console.log(`Show: ${showTitle} (${showId})`);
  console.log(`Market: ${marketLabel}`);
  console.log(`Year: ${year}`);
  console.log(`Date filter: ${dateFilter ? `opening ±7/+14 days` : 'none (no opening date)'}`);
  console.log(`Tiers: ${TIERS.join(', ')}\n`);

  // Get existing URLs to dedup
  const existingUrls = getExistingUrls(showId);
  const outletCounts = getOutletReviewCounts(showId);
  console.log(`Existing review files: ${existingUrls.size} URLs\n`);

  // Ensure review-texts directory exists
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!DRY_RUN && !fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  let discovered = 0;
  let searched = 0;
  let skippedDupe = 0;
  let skippedCovered = 0;

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

    // Skip outlets that already have 2+ reviews for this show (saves 25 SERP credits each)
    if ((outletCounts.get(domain) || 0) >= 2) {
      skippedCovered++;
      continue;
    }

    const query = `site:${domain} "${showTitle}" ${reviewKeyword}${year ? ` ${year}` : ''}${dateFilter}`;

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

        // Skip results not about this show (SERP returns other reviews from same outlet/date)
        if (!serpResultMentionsShow(result.title, url, showTitle)) {
          console.log(`    [SKIP] Not about "${showTitle}": "${(result.title || '').slice(0, 70)}"`);
          continue;
        }

        // Skip results where URL year falls outside the show's production window
        const openYear = year && year.length === 4 ? parseInt(year) : null;
        const closeYear = show.closingDate ? new Date(show.closingDate).getFullYear() : null;
        if (openYear && isUrlYearOutsideWindow(url, openYear, closeYear)) {
          console.log(`    [SKIP] URL year outside production window for ${showId}`);
          continue;
        }

        // Skip results whose title mentions a year far from this production
        if (openYear && result.title) {
          const titleYears = result.title.match(/\b(19\d{2}|20\d{2})\b/g);
          if (titleYears) {
            const hasWrongYear = titleYears.some(y => Math.abs(parseInt(y) - openYear) > 3);
            const hasRightYear = titleYears.some(y => Math.abs(parseInt(y) - openYear) <= 1);
            if (hasWrongYear && !hasRightYear) {
              console.log(`    [SKIP] Title year outside window: "${result.title}"`);
              continue;
            }
          }
        }

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
            // URL-based dedup: skip if same URL already exists under a different filename
            const normalizedUrl = url.toLowerCase().replace(/\/+$/, '');
            const urlDupe = existingFiles.some(f => {
              if (!f.endsWith('.json')) return false;
              try {
                const existing = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
                return existing.url && existing.url.toLowerCase().replace(/\/+$/, '') === normalizedUrl;
              } catch { return false; }
            });
            if (urlDupe) {
              skippedDupe++;
              continue;
            }
          }

          // Route through createOrMergeReviewFile for Guard E (auto-flag
          // BWW Review-Roundup URLs) and URL-based outletId refinement
          // (resolveOutletFromUrl handles cases like metro.co.uk → metro-uk
          // that the local domainToOutletId fallback misses).
          const writeResult = createOrMergeReviewFile(showId, {
            outletId: canonicalOutletId,
            outlet: getOutletDisplayName(canonicalOutletId) || result.title?.split(/[-–—|]/)[0]?.trim() || canonicalOutletId,
            criticName: criticName || 'Unknown',
            url,
            source: 'opening-night-discovery',
            fields: {
              publishDate: null,
              fullText: null,
              contentTier: 'excerpt',
            },
          });
          if (writeResult.action === 'skipped') {
            console.log(`  skipped (${writeResult.reason}): ${url}`);
            continue;
          }
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

  // === Strategy 2: Google News SERP (ScrapingBee only — no BrightData news equivalent) ===
  console.log(`\nStrategy 2: Google News search...`);

  if (_scrapingBeeExhausted || !SCRAPINGBEE_KEY) {
    console.log('  Skipping news search (ScrapingBee exhausted or unavailable)');
  } else {
  const newsQuery = `"${showTitle}" ${reviewKeyword}${dateFilter}`;
  try {
    let newsUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(newsQuery)}&nb_results=10&search_type=news`;

    let results = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(newsUrl, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403 || res.status === 429) {
            console.log(`    ⚠ ScrapingBee exhausted (${res.status}) — skipping news search`);
            _scrapingBeeExhausted = true;
            break;
          }
          if (res.status >= 500 && attempt < 2) {
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

      // Skip results not about this show
      if (!serpResultMentionsShow(result.title, url, showTitle)) {
        console.log(`    [SKIP] Not about "${showTitle}": "${(result.title || '').slice(0, 70)}"`);
        continue;
      }

      // Skip results where URL year falls outside the show's production window
      const openYearNews = year && year.length === 4 ? parseInt(year) : null;
      const closeYearNews = show.closingDate ? new Date(show.closingDate).getFullYear() : null;
      if (openYearNews && isUrlYearOutsideWindow(url, openYearNews, closeYearNews)) {
        console.log(`    [SKIP] URL year outside production window for ${showId}`);
        continue;
      }

      // Skip results whose title mentions a year far from this production
      if (openYearNews && result.title) {
        const titleYears = result.title.match(/\b(19\d{2}|20\d{2})\b/g);
        if (titleYears) {
          const hasWrongYear = titleYears.some(y => Math.abs(parseInt(y) - openYearNews) > 3);
          const hasRightYear = titleYears.some(y => Math.abs(parseInt(y) - openYearNews) <= 1);
          if (hasWrongYear && !hasRightYear) {
            console.log(`    [SKIP] Title year outside window: "${result.title}"`);
            continue;
          }
        }
      }

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

        // Route through createOrMergeReviewFile for Guard E (auto-flag
        // BWW Review-Roundup URLs) and URL-based outletId refinement.
        const writeResult = createOrMergeReviewFile(showId, {
          outletId: canonicalOutletId,
          outlet: getOutletDisplayName(canonicalOutletId) || canonicalOutletId,
          criticName: criticName || 'Unknown',
          url,
          source: 'opening-night-discovery',
          fields: {
            publishDate: null,
            fullText: null,
            contentTier: 'excerpt',
          },
        });
        if (writeResult.action === 'skipped') {
          console.log(`  skipped (${writeResult.reason}): ${url}`);
          continue;
        }
      }

      existingUrls.add(url.toLowerCase());
      discovered++;
    }
  } catch (err) {
    console.error(`  Error in news search: ${err.message}`);
  }
  } // end else (ScrapingBee not exhausted)

  console.log(`\nResults: ${discovered} new reviews discovered, ${skippedDupe} duplicates skipped, ${skippedCovered} outlets skipped (2+ reviews), ${searched} SERP calls made`);
  if (_scrapingBeeExhausted && BRIGHTDATA_TOKEN) {
    console.log('Note: ScrapingBee credits exhausted — used BrightData SERP as fallback');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
