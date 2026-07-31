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
const { OUTLET_DOMAINS: _OUTLET_DOMAINS, serpQuery } = require('./lib/url-discovery');
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
// Set by searchGoogle() when the shared serpQuery() chain reports no provider
// could answer at all (both keys missing, or every provider in the chain
// failed). Strategy 2b's own SERP-provider gate reads this — see T7 note below.
let _serpUnavailable = false;
// Strategy 2 (Google News) still hand-rolls its own direct ScrapingBee call
// (serpQuery has no news search_type) and sets this independently on a 401/
// 403/429 from THAT call. It no longer reflects Strategy 1/2b exhaustion —
// those now route through the shared chain in url-discovery.js, which
// doesn't expose per-provider exhaustion state. Acceptable narrowing per the
// T7 scope (routing change only): Strategy 2 still self-detects its own
// SB exhaustion; it just can't see Strategy 1's anymore.
let _scrapingBeeExhausted = false;

// Per-run SERP call budget. searchGoogle() and the inline news query hit
// SERP APIs bypassing scraper.js's SB_CREDIT_BUDGET guard, so without this a
// pathological run could spend unbounded credits (plan-review: Codex).
// Counts every SERP call across Strategy 1 + 2 + 2b. The broad web query (2b)
// is gated on remaining budget so it can never be the thing that blows the
// cap. Override via OPENING_NIGHT_SERP_BUDGET.
const SERP_CALL_BUDGET = parseInt(process.env.OPENING_NIGHT_SERP_BUDGET || '80', 10);
let _serpCallsUsed = 0;
function underSerpBudget() {
  return _serpCallsUsed < SERP_CALL_BUDGET;
}

/**
 * Search Google via the shared BD/SB/ScrapingDog SERP chain (Scraping v2
 * Sprint 1 T7: scripts/lib/url-discovery.js's serpQuery — same chain
 * url-discovery.js/opening-night-poller.js use). Replaces this file's former
 * private ScrapingBee->BrightData-only chain; serpQuery gains a ScrapingDog
 * tier, the 24h disk cache, and cost telemetry for free. Routing change
 * only — call sites and budget accounting below are unchanged.
 */
async function searchGoogle(query, nbResults = 5) {
  _serpCallsUsed++;
  const results = await serpQuery(query, { nbResults });
  if (results === null) {
    _serpUnavailable = true;
    return [];
  }
  return results;
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
const { passesProductionMatch } = require('./lib/production-match-gate');

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

    // Hard per-run SERP cap — applies to Strategy 1 too, so the budget actually
    // bounds total spend (ship-check: Codex + Claude) rather than only gating 2b
    // after Strategy 1 already overspent.
    if (!underSerpBudget()) {
      console.log(`  ⚠ SERP budget ${SERP_CALL_BUDGET} reached — stopping Strategy 1 outlet search (used ${_serpCallsUsed})`);
      break;
    }

    const query = `site:${domain} "${showTitle}" ${reviewKeyword}${year ? ` ${year}` : ''}${dateFilter}`;

    try {
      const results = await searchGoogle(query, 3);
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
  } else if (!underSerpBudget()) {
    console.log(`  Skipping news search (per-run SERP budget ${SERP_CALL_BUDGET} reached, used ${_serpCallsUsed})`);
  } else {
  const newsQuery = `"${showTitle}" ${reviewKeyword}${dateFilter}`;
  _serpCallsUsed++;
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

  // === Strategy 2b: broad WEB search (open-ended) ===
  // Catches UNREGISTERED outlets that Strategy 1's outlet list and Strategy 2's
  // Google-News index both miss (e.g. London Theatre Direct + indie blogs).
  // Gated by passesProductionMatch() because a plain "{title} review" web search
  // returns OTHER productions of generic-title plays ("The Truth", "Much Ado",
  // "The Misanthrope") — a wrong-production review on a public page is worse than
  // a missing one (plan-review: User-Impact + Pre-mortem). Writes are tagged
  // source:'broad-web-serp' so they're traceable and pass the normal downstream
  // wrong-production/wrong-show classifier. Notion 38a637c5-416f-81a7.
  console.log(`\nStrategy 2b: broad web search (unregistered outlets)...`);
  // Day-0 guard: on opening morning SERP hasn't indexed the reviews yet, so a
  // broad "{title} review" search is most likely to surface OTHER productions —
  // the highest wrong-production risk for generic titles. Skip until day 1+
  // (ship-check: Claude). Mirrors the gather-side day-0 aggregators-only rule.
  const daysSinceOpening = opening ? Math.floor((Date.now() - opening.getTime()) / 86400000) : null;
  if (_serpUnavailable) {
    console.log('  Skipping broad web search (no SERP provider available)');
  } else if (daysSinceOpening !== null && daysSinceOpening < 1) {
    console.log('  Skipping broad web search on opening day (SERP not indexed; avoids early wrong-production hits)');
  } else if (!underSerpBudget()) {
    console.log(`  Skipping broad web search (per-run SERP budget ${SERP_CALL_BUDGET} reached, used ${_serpCallsUsed})`);
  } else {
    const webQuery = `"${showTitle}" ${reviewKeyword}${dateFilter}`;
    try {
      const results = await searchGoogle(webQuery, 10);
      searched++;
      let gated = 0;
      for (const result of results) {
        const url = result.url || result.link;
        if (!url) continue;
        if (isAggregatorUrl(url)) continue;
        if (existingUrls.has(url.toLowerCase())) { skippedDupe++; continue; }
        if (!isReviewUrl(url, result.title)) continue;
        if (!serpResultMentionsShow(result.title, url, showTitle)) {
          console.log(`    [SKIP] Not about "${showTitle}": "${(result.title || '').slice(0, 70)}"`);
          continue;
        }
        // Stronger production gate — broad search is the wrong-production risk.
        if (!passesProductionMatch({ title: result.title, url, description: result.description || result.snippet }, show)) {
          gated++;
          console.log(`    [SKIP] No production-match signal (broad web): "${(result.title || '').slice(0, 70)}"`);
          continue;
        }
        const openYearWeb = year && year.length === 4 ? parseInt(year) : null;
        const closeYearWeb = show.closingDate ? new Date(show.closingDate).getFullYear() : null;
        if (openYearWeb && isUrlYearOutsideWindow(url, openYearWeb, closeYearWeb)) {
          console.log(`    [SKIP] URL year outside production window for ${showId}`);
          continue;
        }
        // Title/snippet year-window (Strategy 1/2 parity, extended to the snippet):
        // a generic venue token (Lyric, Apollo, National...) can otherwise let a
        // same-venue review from a DIFFERENT year pass the gate. A year far from
        // the opening, with no near year present, is a wrong production.
        if (openYearWeb) {
          const hay = `${result.title || ''} ${result.description || result.snippet || ''}`;
          const yrs = hay.match(/\b(19\d{2}|20\d{2})\b/g);
          if (yrs) {
            const wrong = yrs.some(y => Math.abs(parseInt(y) - openYearWeb) > 3);
            const right = yrs.some(y => Math.abs(parseInt(y) - openYearWeb) <= 1);
            if (wrong && !right) {
              console.log(`    [SKIP] Year outside window (broad web): "${(result.title || '').slice(0, 70)}"`);
              continue;
            }
          }
        }
        const criticName = extractCriticFromTitle(result.title || '');
        const outletId = domainToOutletId(url) || 'unknown';
        console.log(`  FOUND (broad web): ${result.title?.slice(0, 80) || url}`);
        console.log(`         ${url}`);
        console.log(`         Outlet: ${outletId}, Critic: ${criticName}`);
        if (!DRY_RUN) {
          const canonicalOutletId = normalizeOutlet(outletId);
          const filename = generateReviewFilename(outletId, criticName);
          const filepath = path.join(showDir, filename);
          if (fs.existsSync(filepath)) { skippedDupe++; continue; }
          if (fs.existsSync(showDir)) {
            const criticSlug = normalizeCritic(criticName);
            const existingFiles = fs.readdirSync(showDir);
            const hasDupe = existingFiles.some(f => {
              const m = f.match(/^(.+?)--(.+)\.json$/);
              return m && normalizeOutlet(m[1]) === canonicalOutletId && m[2] === criticSlug;
            });
            if (hasDupe) { skippedDupe++; continue; }
          }
          const writeResult = createOrMergeReviewFile(showId, {
            outletId: canonicalOutletId,
            outlet: getOutletDisplayName(canonicalOutletId) || canonicalOutletId,
            criticName: criticName || 'Unknown',
            url,
            source: 'broad-web-serp',
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
      if (gated > 0) console.log(`  (${gated} result(s) rejected by production-match gate)`);
    } catch (err) {
      console.error(`  Error in broad web search: ${err.message}`);
    }
  }

  console.log(`\nResults: ${discovered} new reviews discovered, ${skippedDupe} duplicates skipped, ${skippedCovered} outlets skipped (2+ reviews), ${searched} SERP calls made, ${_serpCallsUsed} SERP budget used`);
  if (_scrapingBeeExhausted && BRIGHTDATA_TOKEN) {
    console.log('Note: ScrapingBee credits exhausted — used BrightData SERP as fallback');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
