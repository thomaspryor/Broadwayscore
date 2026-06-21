#!/usr/bin/env node
/**
 * Gather Reviews Script
 *
 * Automated review gathering for Broadway shows.
 * This script powers the gather-reviews.yml GitHub Action.
 *
 * Process:
 * 1. Search aggregators (DTLI, Show Score) for reviews
 *    - Show Score: Uses Playwright to scroll through carousel and extract ALL critic reviews
 *    - URL patterns try -broadway suffix first to avoid redirects to off-broadway shows
 * 2. Search individual outlets via Google SERP (ScrapingBee/Bright Data)
 * 3. Create review-text files for each found review
 * 4. Rebuild reviews.json
 *
 * Show Score Technical Notes:
 * - Show Score paginates critic reviews in a carousel (only 8 visible initially)
 * - Playwright scrolls through the carousel to load all reviews
 * - URLs like /broadway-shows/redwood can redirect to /off-off-broadway-shows/redwood
 * - We detect these redirects and try -broadway suffix patterns first
 *
 * Usage:
 *   node scripts/gather-reviews.js --shows=show-id-1,show-id-2
 *   node scripts/gather-reviews.js --shows=all-out-2025
 *   node scripts/gather-reviews.js --shows=show-id --validate-urls  # Content-check roundup URLs
 *
 * Environment Variables:
 *   SCRAPINGBEE_API_KEY - Required for SERP-based outlet discovery
 *   BRIGHTDATA_TOKEN - Fallback for SERP discovery
 *   ANTHROPIC_API_KEY - Optional (used by other pipelines, not by this script)
 *
 * Dependencies:
 *   - playwright (optional but recommended for full Show Score extraction)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  normalizeOutlet,
  normalizeCritic,
  normalizePublishDate,
  generateReviewFilename,
  findExistingReviewFile,
  generateReviewKey,
  getOutletDisplayName,
  mergeReviews,
  validateCriticOutlet,
  resolveOutletFromUrl,
  isJunkOutlet,
  isProfileUrl,
  normalizeUrl,
  isRegisteredOutlet,
  isSuspiciousOutletId,
  AGGREGATOR_SCORE_SOURCES,
} = require('./lib/review-normalization');
const { verifyProduction, quickDateCheck, getShowData } = require('./lib/production-verifier');
const { shouldFillDefaultCritic } = require('./lib/critic-fill-rules');
const { cleanText } = require('./lib/text-cleaning');
const { classifyContentTier } = require('./lib/content-quality');
const { isNotBroadway } = require('./lib/content-filters');
const { hasOnlyForwardTenseTourMention } = require('./lib/excerpt-validation');
const { isLikelyTourReview, urlLooksLikeReview, urlOrTitleLooksLikeReview, isWrongShowUnknownLocked, getWrongProductionReasonForUnknownCritic, shouldRouteUnknownCriticToPending, shouldSkipWrongProductionAudit } = require('./lib/review-guards');
const { isWithinPriorRun } = require('./lib/wrong-production-autoclear');
const { canonicalizeCritic } = require('./lib/critic-canonicalization');
const { isBroadwayUrl } = require('./lib/venue-classification');
const { isAggregatorUrlMismatch } = require('./lib/aggregator-domains');
const { classifyMarketRouting, buildSiblingIndex } = require('./lib/market-routing');
const { isBWWRoundupContent, validateBWWRoundupUrlMatchesShow, isCloudflareChallenge } = require('./lib/bww-roundup-validator');
const { parseArticleBodyReviews } = require('./lib/bww-roundup-parser');
const { findBWWRoundupLinkOnHomepage } = require('./lib/bww-homepage-scan');
const { LETTER_GRADES, extractScore } = require('./lib/score-extractors');
const { discoverCorrectUrl, serpQuery, OUTLET_DOMAINS } = require('./lib/url-discovery');
const { emitStage } = require('./lib/stage-latency');
const {
  llmFallbackExtract,
  hasStructuralMarkers,
  countExpectedReviews,
  isPartialExtraction,
  mergeAggregatorReviews,
} = require('./lib/llm-extractor');
const { shouldRetryUrlDiscovery, recordSerpAttempt } = require('./lib/review-guards');
const { computeReplacementPreserve } = require('./lib/wrongprod-replacement-preserve');
const { domainMatchesExpected, fetchPage, verifyFetchedUrl } = require('./lib/scraper');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { titleWordsMatchWithConfidence, validateRoundupPageTitle } = require('./lib/show-matching');
const { loadBlocklist, findBlockedEntry } = require('./lib/poller-blocklist');
const { detectIngestCollision } = require('./lib/manual-review-fields');
const { cleanSearchTitle } = require('./lib/title-normalization');
const { extractReviewsFromLBO } = require('./scrape-london-box-office-roundups');
const { isLondonMarket } = require('./lib/venue-classification');
const { parseDate } = require('./lib/date-utils');
const { logExclusion } = require('./lib/exclusion-logger');
let chromium, playwright;
try {
  playwright = require('playwright');
  chromium = playwright.chromium;
} catch (e) {
  // Playwright not available - will fall back to HTTP scraping
}

// Paths
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const GATHER_COLLISIONS_PATH = path.join(__dirname, '..', 'data', 'audit', 'gather-collisions.json');
const MARKET_MISROUTES_PATH = path.join(__dirname, '..', 'data', 'audit', 'market-misroutes.json');
const OUTLETS_PATH = path.join(__dirname, 'config', 'critic-outlets.json');
const DTLI_SLUG_MAP_PATH = path.join(__dirname, '..', 'data', 'dtli-slug-map.json');
const SHOW_SCORE_URLS_PATH = path.join(__dirname, '..', 'data', 'show-score-urls.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');

const {
  shouldQueryPerCritic: _shouldQueryPerCritic,
  remainingCritics: _remainingCritics,
  normalizeUrlForDedup: _normalizeUrlForDedup,
} = require('./lib/multi-critic-serp');

// Roundup/aggregator sources whose URLs come from positional matching
// (carousel order, roundup page layout) and may be misattributed.
// SERP-discovered and manual URLs are already validated elsewhere.
const ROUNDUP_URL_SOURCES = new Set([
  'show-score', 'show-score-playwright', 'dtli',
  'bww-roundup', 'lbo-roundup',
  'westendtheatre', 'theatre-reviews', 'stagedoor', 'thestage-roundup',
]);

/**
 * Determine whether a review's URL needs content validation.
 * Only roundup/aggregator-sourced URLs need checking — SERP and manual URLs
 * are already validated by other guards.
 *
 * @param {object} review - Review data with source and url fields
 * @returns {boolean} true if this review's URL should be content-validated
 */
function shouldValidateUrl(review) {
  return !!(review.url && review.source && ROUNDUP_URL_SOURCES.has(review.source));
}

// Show Score URL map (curated from listings discovery)
let _showScoreUrlMap = null;
function getShowScoreUrlMap() {
  if (_showScoreUrlMap) return _showScoreUrlMap;
  try {
    const data = JSON.parse(fs.readFileSync(SHOW_SCORE_URLS_PATH, 'utf8'));
    _showScoreUrlMap = data.shows || {};
  } catch {
    _showScoreUrlMap = {};
  }
  return _showScoreUrlMap;
}

// DTLI slug map (persistent mapping discovered from sitemaps)
let _dtliSlugMap = null;
function getDtliSlugMap() {
  if (_dtliSlugMap) return _dtliSlugMap;
  try {
    const data = JSON.parse(fs.readFileSync(DTLI_SLUG_MAP_PATH, 'utf8'));
    _dtliSlugMap = data.shows || {};
    console.log(`  Loaded DTLI slug map: ${Object.keys(_dtliSlugMap).length} entries`);
  } catch {
    _dtliSlugMap = {};
  }
  return _dtliSlugMap;
}

// Global show year map for cross-production year comparison
// Maps showId → opening year (number)
let _showYearMap = null;
function getShowYearMap() {
  if (_showYearMap) return _showYearMap;
  _showYearMap = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = showsData.shows || showsData;
    for (const s of shows) {
      if (s.openingDate) {
        const d = new Date(s.openingDate);
        if (!isNaN(d.getTime())) _showYearMap[s.id] = d.getFullYear();
      }
    }
  } catch {}
  return _showYearMap;
}

// Global URL index for cross-production duplicate prevention
// Maps URL → { showId, file } for all existing review files
let _globalUrlIndex = null;
let _skipCrossShowDupeIds = null;
// Lazy-loaded outlet registry cache for domain validation in saveReview()
let _outletRegistryCache = null;
// Lazy-loaded cross-market sibling index for createReviewFile market guard
let _siblingIndexCache = null;
function getSiblingIndex() {
  if (_siblingIndexCache) return _siblingIndexCache;
  try {
    const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = showsData.shows || showsData;
    _siblingIndexCache = buildSiblingIndex(shows);
  } catch {
    _siblingIndexCache = new Map();
  }
  return _siblingIndexCache;
}
function getSkipCrossShowDupeIds() {
  if (_skipCrossShowDupeIds) return _skipCrossShowDupeIds;
  try {
    const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = showsData.shows || showsData;
    _skipCrossShowDupeIds = new Set(shows.filter(s => s._skipCrossShowDupe).map(s => s.id));
  } catch { _skipCrossShowDupeIds = new Set(); }
  return _skipCrossShowDupeIds;
}
function getGlobalUrlIndex() {
  if (_globalUrlIndex) return _globalUrlIndex;
  _globalUrlIndex = new Map();
  const skipIds = getSkipCrossShowDupeIds();
  try {
    const dirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      if (skipIds.has(d)) continue; // _skipCrossShowDupe: excluded from global URL index
      const showDir = path.join(REVIEW_TEXTS_DIR, d);
      const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
      for (const f of files) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
          if (r.url) _globalUrlIndex.set(normalizeUrl(r.url), { showId: d, file: f });
        } catch {}
      }
    }
    console.log(`  Built global URL index: ${_globalUrlIndex.size} URLs across ${dirs.length} shows`);
  } catch {}
  return _globalUrlIndex;
}

/**
 * Append a stale-flag collision to data/audit/gather-collisions.json.
 * Never throws — an audit-write failure must not abort the gather batch.
 *
 * See Notion 34c637c5-416f-81e7-b0df-da7b91d8ba07 and Session 2 (83ce81afa2).
 */
function _recordGatherCollision(entry) {
  try {
    const auditDir = path.dirname(GATHER_COLLISIONS_PATH);
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    let list = [];
    if (fs.existsSync(GATHER_COLLISIONS_PATH)) {
      try { list = JSON.parse(fs.readFileSync(GATHER_COLLISIONS_PATH, 'utf8')); } catch {}
      if (!Array.isArray(list)) list = [];
    }
    list.push({ recordedAt: new Date().toISOString(), ...entry });
    // Cap at 500 entries so a stuck poller doesn't balloon the file.
    if (list.length > 500) list = list.slice(-500);
    fs.writeFileSync(GATHER_COLLISIONS_PATH, JSON.stringify(list, null, 2));
  } catch { /* audit write must not abort batch */ }
}

function _recordMarketMisroute(entry) {
  try {
    const auditDir = path.dirname(MARKET_MISROUTES_PATH);
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    let list = [];
    if (fs.existsSync(MARKET_MISROUTES_PATH)) {
      try { list = JSON.parse(fs.readFileSync(MARKET_MISROUTES_PATH, 'utf8')); } catch {}
      if (!Array.isArray(list)) list = [];
    }
    list.push({ recordedAt: new Date().toISOString(), ...entry });
    if (list.length > 500) list = list.slice(-500);
    fs.writeFileSync(MARKET_MISROUTES_PATH, JSON.stringify(list, null, 2));
  } catch { /* audit write must not abort batch */ }
}

// Rate limiting
const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Strip ShowScore aggregator verb phrases from critic names.
// ShowScore excerpts use patterns like "The Standard asserts Dominic Cavendish..."
// and sometimes the critic name is extracted as "Asserts Dominic Cavendish".
// These create duplicate files alongside real critic entries pointing to the same URL.
const SYNTHETIC_CRITIC_VERBS = /^(asserts?|observes?|claims?|notes?|writes?|states?|says?|calls?|finds?|praises?|pans?|argues?)\s+/i;
function sanitizeCriticName(name) {
  if (!name) return name;
  const stripped = name.replace(SYNTHETIC_CRITIC_VERBS, '').trim();
  // Only accept the stripped version if it looks like a real name (2+ words, starts uppercase)
  if (stripped !== name && /^[A-Z][a-z]/.test(stripped) && stripped.includes(' ')) return stripped;
  return name;
}

// Cross-show URL slug detection: lazy-loaded index of show title slugs.
// Used to catch URLs that clearly belong to a different show.
// Exclude titles that are common URL path words (cause false positives).
const CROSS_SHOW_SLUG_EXCLUDE = new Set([
  'broadway', 'west-end', 'the-story', 'romantic-comedy', 'the-red-shoes',
  'les-miserables', 'once-in-a-lifetime', 'body-count', 'the-car-man',
  'good-night-oscar', 'the-visit', 'the-outsiders', 'the-notebook',
]);
let _showSlugIndex = null;
function getShowSlugIndex() {
  if (_showSlugIndex) return _showSlugIndex;
  _showSlugIndex = [];
  try {
    const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = showsData.shows || showsData;
    for (const s of shows) {
      const slug = slugify(s.title);
      if (slug.length >= 8 && !CROSS_SHOW_SLUG_EXCLUDE.has(slug)) {
        _showSlugIndex.push({ id: s.id, title: s.title, slug });
      }
    }
  } catch {}
  return _showSlugIndex;
}

/**
 * Detect if a URL's path clearly belongs to a different show.
 * Returns { matchedShowId, matchedTitle, showTitle } if mismatch found, null otherwise.
 * matchedShowId enables the caller to re-route the file to the correct show
 * instead of discarding it (see BUG 2 fix at the cross-show guard call site).
 */
function detectCrossShowUrlMismatch(showId, url) {
  if (!url) return null;
  try {
    const urlPath = new URL(url).pathname.toLowerCase();
    const index = getShowSlugIndex();
    const thisShow = index.find(s => s.id === showId);
    if (!thisShow) return null;

    // Check if URL contains this show's slug — if yes, no mismatch
    if (urlPath.includes(thisShow.slug)) return null;

    // Also check the show ID slug (without year/market suffix) for partial matches
    const idSlug = showId.replace(/-(?:west-end|off-west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');
    if (idSlug.length >= 8 && urlPath.includes(idSlug)) return null;

    // Normalize connectors (and/&/+) so "romeo-and-juliet" ≈ "romeo-juliet"
    const stripConnectors = s => s.replace(/-(?:and|the)-/g, '-');
    const idSlugNorm = stripConnectors(idSlug);
    // Also match if URL contains the connector-stripped slug (e.g., URL has "romeo-juliet" for "romeo-and-juliet")
    if (idSlugNorm !== idSlug && idSlugNorm.length >= 8 && urlPath.includes(idSlugNorm)) return null;

    // Check if URL contains a different show's slug
    for (const other of index) {
      if (other.id === showId) continue;
      // Skip shows that share a base title with this show (same slug or prefix relationship)
      const otherIdSlug = other.id.replace(/-(?:west-end|off-west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');
      if (otherIdSlug === idSlug) continue;
      // Skip if connector-normalized slugs match (e.g., "romeo-and-juliet" ≈ "romeo-juliet")
      const otherIdSlugNorm = stripConnectors(otherIdSlug);
      if (otherIdSlugNorm === idSlugNorm) continue;
      // Skip if one show's slug is a prefix of the other (e.g., "kinky-boots" vs "kinky-boots-the-musical")
      if (thisShow.slug.startsWith(other.slug) || other.slug.startsWith(thisShow.slug)) continue;
      if (idSlug.startsWith(otherIdSlug) || otherIdSlug.startsWith(idSlug)) continue;
      if (urlPath.includes(other.slug)) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
      // Also check a base-title slug (first significant words of the title, without
      // parentheticals or subtitles). Catches shows with long qualified slugs like
      // "monte-cristo-the-york-theatre-company-off-broadway" where a URL containing
      // just "monte-cristo" wouldn't match the full slug.
      const baseTitle = (other.title || '').replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '')
        .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      // Skip common URL-path words that would false-positive on nearly every URL
      // (e.g., the show "Broadway" has baseTitle "broadway" which appears in ~90% of review URLs)
      const URL_PATH_STOPWORDS = new Set(['broadway', 'musical', 'theater', 'theatre', 'review', 'reviews', 'london', 'west-end', 'off-broadway']);
      if (baseTitle.length >= 6 && !URL_PATH_STOPWORDS.has(baseTitle)
          && baseTitle !== idSlug
          && !idSlug.startsWith(baseTitle) && !baseTitle.startsWith(idSlug)
          && urlPath.includes(baseTitle)) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
    }
  } catch {}
  return null;
}

/**
 * Load show data
 */
function loadShowData(showId) {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;
  return shows.find(s => s.id === showId);
}

/**
 * Load outlet configuration
 */
/**
 * Load the per-category SERP-iteration outlet list (Sprint 4).
 *
 * Default (no opts) returns the historical critic-outlets.json list so
 * existing callers stay byte-identical until S4-T2 broadens the swap to
 * Broadway. The WE branch (S4-T1) reads outlet-registry.json filtered to
 * outlets with region==='london' or isDualMarket===true, giving 80+ UK
 * outlets vs the prior 1 UK outlet in critic-outlets.json.
 *
 * `category` overrides:
 *   'west-end' / 'off-west-end' → registry, region==='london' || isDualMarket
 *   any other category          → critic-outlets.json (legacy path)
 *
 * The legacy critic-outlets.json path also runs the OUTLET_DOMAINS sanity
 * guard. The registry path doesn't need it (registry is the source of
 * truth for OUTLET_DOMAINS).
 */
function loadOutlets(opts = {}) {
  const category = opts.category || null;

  // Registry-backed paths (S4-T1 WE, S4-T2 BW + off-BW). Filter rules:
  //   west-end / off-west-end → region in {london, uk, dual} || isDualMarket
  //   broadway / off-broadway → all tier 1+2 outlets (high-signal, low cost),
  //     plus tier 3 with explicit US-flavoured region or isDualMarket.
  //
  // Why the tier-cap: only 1 outlet in the registry has `region: 'us'`. The
  // remaining ~860 unset-region outlets include both US national publications
  // (Variety, AP, etc — most are also `isDualMarket: true`) AND a long tail
  // of niche/blog outlets where SERP enumeration is wasted credit. Capping
  // tier 3 to US-marked outlets keeps the per-show SERP count from 20× to
  // ~50% larger than the legacy critic-outlets.json list (42 → 63) while
  // gaining the registry's broader US tier-1/2 coverage.
  const UK_REGIONS = new Set(['london', 'uk']);
  const US_REGIONS = new Set(['us', 'chicago', 'los-angeles', 'philadelphia', 'boston', 'san-francisco', 'dual']);
  // (The TIER3_US_WHITELIST parity bridge from the original ship-check fix
  // was removed once the 8 tier-3 US outlets — cititour, frontmezzjunkies,
  // culturesauce, nbcnews, forward, one-minute-critic, stageandcinema,
  // jitney — got region:'us' written into data/outlet-registry.json
  // directly. The registry is now the single source of truth.)
  const registryCategories = new Set(['west-end', 'off-west-end', 'broadway', 'off-broadway']);
  if (registryCategories.has(category)) {
    try {
      const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
      const outletsIn = registry.outlets || {};
      const out = [];
      const isWE = category === 'west-end' || category === 'off-west-end';
      for (const [id, info] of Object.entries(outletsIn)) {
        const isLondonRegion = UK_REGIONS.has(info.region);
        const isUSRegion = US_REGIONS.has(info.region);
        const isDual = !!info.isDualMarket;
        const tier = info.tier || 3;
        let include;
        if (isWE) {
          include = isLondonRegion || isDual;
        } else {
          // Broadway / off-broadway: tier 1+2 always; tier 3 only with
          // explicit US-flavoured region or dual-market flag.
          include = tier <= 2 || isUSRegion || isDual;
          // Exclude London-only outlets even at tier 1+2 (e.g. Standard).
          if (include && isLondonRegion && !isDual) include = false;
        }
        if (!include) continue;
        out.push({
          id,
          name: info.displayName || id,
          domain: info.domain || null,
          critics: info.defaultCritics || (info.defaultCritic ? [info.defaultCritic] : []),
          tier,
          region: info.region || null,
          isDualMarket: isDual,
        });
      }
      // Sort: tier ascending (T1 first), name ascending — stable SERP order
      out.sort((a, b) => (a.tier - b.tier) || a.name.localeCompare(b.name));
      return out;
    } catch (e) {
      console.warn(`⚠ loadOutlets({category:'${category}'}): registry read failed (${e.message}); [FALLBACK_HIT] critic-outlets.json fallback was used for category=${category} — investigate before Sprint 7 deletion`);
    }
  }

  // Legacy path: critic-outlets.json (caller without category override + fallback).
  // Warn so we can see whether any caller is still bypassing the per-category
  // registry split before Sprint 7 deletes the file outright.
  if (category) {
    console.warn(`[FALLBACK_HIT] critic-outlets.json fallback was used for category=${category} — investigate before Sprint 7 deletion`);
  } else {
    console.warn('[FALLBACK_HIT_NOCATEGORY] loadOutlets() called without a category — likely a caller that still needs the category-aware swap');
  }
  const config = JSON.parse(fs.readFileSync(OUTLETS_PATH, 'utf8'));
  const outlets = [
    ...config.tier1.map(o => ({ ...o, tier: 1 })),
    ...config.tier2.map(o => ({ ...o, tier: 2 })),
    ...config.tier3.map(o => ({ ...o, tier: 3 }))
  ];
  // Guard: every outlet ID must resolve in OUTLET_DOMAINS for SERP to work
  const { OUTLET_DOMAINS } = require('./lib/url-discovery');
  const broken = outlets.filter(o => !OUTLET_DOMAINS[o.id.toLowerCase()]);
  if (broken.length) {
    console.warn(`⚠ ${broken.length} outlet(s) have IDs not in outlet-registry — SERP will fail:`);
    broken.forEach(o => console.warn(`  ${o.id} (${o.name})`));
  }
  return outlets;
}


/**
 * Build domain→market map from outlet-registry.json for SERP market filtering.
 * Handles domain collisions (e.g. timeout.com shared by US + London outlets)
 * by marking shared domains as effectively dual-market.
 * Cached at module level — only loaded once.
 */
let _domainMarketMap = null;
function getDomainMarketMap() {
  if (_domainMarketMap) return _domainMarketMap;
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const map = new Map();
    for (const [id, info] of Object.entries(registry.outlets || {})) {
      const region = info.region || null;
      const isDualMarket = !!info.isDualMarket;
      const entry = { region, isDualMarket };
      const domains = [info.domain, ...(info.domainAliases || [])].filter(Boolean);
      for (const d of domains) {
        const key = d.toLowerCase();
        const existing = map.get(key);
        if (existing && existing.region !== region) {
          // Domain shared across markets (e.g. timeout.com) → treat as dual-market
          existing.isDualMarket = true;
        } else {
          map.set(key, { ...entry });
        }
      }
    }
    _domainMarketMap = map;
  } catch (e) {
    console.log('  ⚠ Could not load outlet-registry for market filtering');
    _domainMarketMap = new Map();
  }
  return _domainMarketMap;
}

/**
 * Search for a review via real Google SERP (ScrapingBee / Bright Data).
 * Returns:
 *   { url }              — hit
 *   null                 — no results (providers responded, just no match)
 *   { unavailable: true } — both providers down / keys missing. Callers in a
 *                           loop should short-circuit remaining calls instead
 *                           of burning budget on N calls that will all fail.
 *
 * Pass options.criticName to target a specific critic at a multi-critic outlet —
 * discoverCorrectUrl will append the name as an unquoted boost term so the SERP
 * returns that critic's review URL rather than only the highest-ranked one.
 */
async function searchForReviewViaSERP(showId, outlet, scrapingBeeKey, brightDataKey, { historical = false, criticName = 'Unknown' } = {}) {
  if (!scrapingBeeKey && !brightDataKey) {
    return { unavailable: true };
  }

  // Build a minimal review-like object for discoverCorrectUrl()
  const reviewObj = {
    showId,
    outletId: outlet.id,
    outlet: outlet.name,
    criticName,
    source: 'serp-discovery',
    url: '', // no existing URL
  };

  const result = await discoverCorrectUrl(reviewObj, scrapingBeeKey, {
    brightDataKey,
    log: (msg) => process.stdout.write(msg.replace(/^\s+/, '  ') + '\n'),
    forceHistorical: historical,
  });

  if (result === '__SERP_UNAVAILABLE__') {
    return { unavailable: true };
  }
  if (result) {
    return { url: result };
  }
  return null;
}

/**
 * Quick title-based validation for aggregator pages.
 * Extracts <title> from raw HTML and checks show title words appear.
 * Returns true if page appears to be about the right show (or can't validate).
 */
function quickTitleCheck(html, showTitle) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) return true; // No title tag = can't validate, accept
  const result = titleWordsMatchWithConfidence(showTitle, titleMatch[1]);
  if (!result.matched) {
    console.log(`    [TITLE MISMATCH] Page title "${titleMatch[1].trim().slice(0, 80)}" doesn't match "${showTitle}" (${result.matchCount}/${result.threshold} words)`);
  }
  return result.matched;
}

/**
 * Search aggregator for show reviews using simple HTTP
 */
async function searchAggregator(aggregatorName, searchUrl, maxRedirects = 3) {
  // Validate URL before making request
  try {
    new URL(searchUrl);
  } catch (e) {
    return { found: false, error: `Invalid URL: ${searchUrl}` };
  }

  // Try direct https.get first (fast, no API cost)
  const directResult = await new Promise((resolve) => {
    const req = https.get(searchUrl, { timeout: 30000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ found: true, html: data, finalUrl: searchUrl }));
      } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Check if redirect goes to homepage (not what we want)
        let redirectUrl = res.headers.location;

        // Handle relative redirects by making them absolute
        if (redirectUrl.startsWith('/')) {
          try {
            const originalUrl = new URL(searchUrl);
            redirectUrl = `${originalUrl.protocol}//${originalUrl.host}${redirectUrl}`;
          } catch (e) {
            resolve({ found: false, error: `Invalid redirect: ${redirectUrl}` });
            return;
          }
        }

        if (redirectUrl.includes('/shows/all') || redirectUrl.endsWith('/shows') || redirectUrl === '/') {
          // Redirected to homepage - this URL doesn't exist
          resolve({ found: false, redirectedToHomepage: true });
        } else if (maxRedirects > 0) {
          searchAggregator(aggregatorName, redirectUrl, maxRedirects - 1).then(resolve);
        } else {
          resolve({ found: false, tooManyRedirects: true });
        }
      } else {
        resolve({ found: false, status: res.statusCode });
      }
    });
    req.on('error', (err) => resolve({ found: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ found: false, error: 'timeout' });
    });
  });

  // If direct fetch succeeded with real content AND URL matches expected, return it
  let wrongPageAllTiers = false;
  if (directResult.found && directResult.html && directResult.html.length > 2000) {
    const vDirect = verifyFetchedUrl(directResult.html, searchUrl);
    if (vDirect.verified) return directResult;
    wrongPageAllTiers = true; // mark that https.get had content but it was wrong-page
    console.log(`    → ${aggregatorName}: https.get returned wrong page (${vDirect.reason}) — escalating`);
  }

  // Fallback 1: try fetch() (undici TLS) — passes CDN fingerprinting where https.get() fails.
  // This is free (no proxy cost) and works for most sites including BWW.
  try {
    const fetchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (fetchResp.ok) {
      const fetchHtml = await fetchResp.text();
      const finalUrl = fetchResp.url || searchUrl; // use post-redirect URL for correct canonical comparison
      if (fetchHtml.length > 2000) {
        const vFetch = verifyFetchedUrl(fetchHtml, finalUrl);
        if (vFetch.verified) {
          console.log(`    → ${aggregatorName}: fetch() succeeded (${(fetchHtml.length / 1024).toFixed(0)}KB)`);
          return { found: true, html: fetchHtml, finalUrl, method: 'fetch-fallback' };
        }
        wrongPageAllTiers = true;
        console.log(`    → ${aggregatorName}: fetch() returned wrong page (${vFetch.reason}) — escalating to fetchPage`);
      }
    }
  } catch (err) {
    // fetch() not available or failed — continue to fetchPage
  }

  // Fallback 2: use fetchPage (Bright Data → ScrapingBee → Playwright) for CI environments
  if (typeof fetchPage === 'function') {
    try {
      const fpResult = await fetchPage(searchUrl);
      const fpHtml = fpResult?.content || fpResult?.html || '';
      if (fpHtml.length > 2000) {
        console.log(`    → ${aggregatorName}: fetchPage fallback succeeded (${(fpHtml.length / 1024).toFixed(0)}KB)`);
        return { found: true, html: fpHtml, finalUrl: searchUrl, method: 'fetchPage-fallback' };
      }
    } catch (err) {
      // fetchPage not available or failed — fall through
    }
  }

  // If all tiers returned wrong-page HTML (verified:false), report not-found rather than
  // returning bad HTML that callers will try to parse. If no tier got any HTML at all,
  // return the original directResult (which will have found:false or the status code).
  if (wrongPageAllTiers) {
    return { found: false, wrongPage: true, reason: 'all_tiers_returned_wrong_page' };
  }

  return directResult;
}

/**
 * Fetch additional Show Score critic reviews via their pagination API.
 * Show Score only renders 8 critic reviews in the initial page load.
 * The remaining reviews are fetched via AJAX at /shows/{slug}/paginate_critic_reviews?page=N.
 * Each page returns JSON: {"html": "<review tile HTML>"} with ~8 review tiles per page.
 */
async function fetchShowScorePaginatedReviews(showPageUrl, initialHtml, showId, showTitle) {
  const additionalReviews = [];

  // Parse pagination attributes from the critic reviews scrollable block.
  // Show Score's Rails-rendered HTML uses single quotes for inline attributes
  // (class='...', data-next-page-path='...'). Match either quote style — confirmed
  // 2026-04-26 against hamilton/wicked/death-becomes-her/the-outsiders/schmigadoon
  // pages, all single-quoted. Hard-coded double-quote regex was silently dropping
  // pages 2-N (e.g., 36 of 44 Hamilton reviews) since the DOM switch.
  const nextPagePathMatch = initialHtml.match(/data-next-page-path=(["'])([^"']+)\1/);
  const totalCountMatch = initialHtml.match(/js-show-page-v2__critic-reviews[^>]*data-total-count=(["'])(\d+)\1/);

  if (!nextPagePathMatch) return additionalReviews;

  const nextPagePath = nextPagePathMatch[2]; // e.g., /shows/death-becomes-her-broadway/paginate_critic_reviews
  const totalCount = totalCountMatch ? parseInt(totalCountMatch[2]) : 0;

  if (totalCount <= 8) return additionalReviews; // No pagination needed

  console.log(`    Show Score pagination: ${totalCount} total reviews, fetching remaining pages...`);

  // Fetch additional pages (page 2, 3, etc.)
  const maxPages = Math.ceil(totalCount / 8) + 1; // Safety margin
  for (let page = 2; page <= maxPages; page++) {
    const paginationUrl = `https://www.show-score.com${nextPagePath}?page=${page}`;

    try {
      const result = await searchAggregator('ShowScorePagination', paginationUrl);
      if (!result.found || !result.html) break;

      // The response is JSON with {"html": "..."} containing review tile HTML
      let tileHtml = result.html;
      try {
        const parsed = JSON.parse(result.html);
        tileHtml = parsed.html || '';
      } catch (e) {
        // If not JSON, use as-is (unlikely but safe fallback)
      }

      if (!tileHtml || tileHtml.length < 10) break; // Empty page = no more reviews

      // Extract reviews from the tile HTML fragments
      // Pattern: outlet from img alt, critic from member link, URL from "Read more" link
      const tileRegex = /review-tile-v2 -critic[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/gi;
      const tiles = tileHtml.match(tileRegex) || [];

      // Simpler approach: extract each review's data from the flat HTML
      const outletRegex = /alt="([^"]+)"/g;
      const criticRegex = /href="\/member\/[^"]*">([^<]+)<\/a>/g;
      const urlRegex = /href="(https?:\/\/[^"]+)"[^>]*>Read more/gi;
      const dateRegex = /review-tile-v2__date[^>]*>\s*([^<]+)/g;
      const excerptRegex = /&quot;([^&]+)&quot;/g;

      const outlets = [];
      const critics = [];
      const urls = [];
      const dates = [];
      let m;

      while ((m = outletRegex.exec(tileHtml)) !== null) {
        // Filter out non-outlet images (avatars, pixel images, ads, etc.)
        if (!m[1].includes('white-pixel') && !m[1].includes('user-avatar') && m[1].length > 2 && !isJunkOutlet(m[1])) {
          outlets.push(m[1]);
        }
      }
      while ((m = criticRegex.exec(tileHtml)) !== null) critics.push(m[1].trim());
      while ((m = urlRegex.exec(tileHtml)) !== null) urls.push(m[1]);
      while ((m = dateRegex.exec(tileHtml)) !== null) dates.push(m[1].trim());

      const pageReviewCount = Math.max(outlets.length, urls.length);
      for (let i = 0; i < pageReviewCount; i++) {
        const outletRaw = outlets[i] || null;
        const critic = sanitizeCriticName(critics[i]) || 'Unknown';
        const url = urls[i] || null;
        const date = dates[i] || null;

        // Resolve outlet: try extracted name first, then URL lookup, then domain fallback
        let outletId, outletName;
        if (outletRaw) {
          outletId = normalizeOutlet(outletRaw);
          outletName = getOutletDisplayName(outletId);
        } else if (url) {
          // No outlet extracted from HTML - try resolving from URL
          const resolved = resolveOutletFromUrl(url);
          if (resolved) {
            outletId = resolved.outletId;
            outletName = resolved.displayName;
          } else {
            // Fallback: use domain base as both ID and name
            try {
              const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
              outletId = hostname.split('.')[0];
              outletName = outletId;
            } catch {
              outletId = 'unknown';
              outletName = 'Unknown';
            }
          }
        } else {
          outletId = 'unknown';
          outletName = 'Unknown';
        }

        if (url && !additionalReviews.some(r => r.url === url)) {
          const validatedUrl = (showTitle && !urlLooksLikeReview(url, showTitle)) ? null : url;
          if (validatedUrl) {
            additionalReviews.push({
              showId,
              outlet: outletName,
              outletId,
              criticName: critic,
              url: validatedUrl,
              publishDate: normalizePublishDate(date) || null,
              source: 'show-score',
            });
          }
        }
      }

      if (pageReviewCount === 0) break; // No more reviews
      await sleep(300); // Rate limit
    } catch (e) {
      console.log(`    Pagination page ${page} error: ${e.message}`);
      break;
    }
  }

  if (additionalReviews.length > 0) {
    console.log(`    Fetched ${additionalReviews.length} additional reviews via pagination`);
  }

  return additionalReviews;
}

/**
 * Try to find show on Did They Like It
 * Revival shows often use -bway or -broadway suffixes
 */
async function searchDTLI(show) {
  // Try slug map first (most reliable — discovered from DTLI sitemaps)
  const dtliSlugMap = getDtliSlugMap();
  let mappedSlug = dtliSlugMap[show.id];
  if (mappedSlug) {
    // Strip leading 'shows/' prefix if present — some entries have it from manual adds,
    // but the URL template already includes /shows/
    if (mappedSlug.startsWith('shows/')) mappedSlug = mappedSlug.slice(6);
    const url = `https://didtheylikeit.com/shows/${mappedSlug}/`;
    console.log(`  Searching Did They Like It (mapped: ${mappedSlug})...`);
    const result = await searchAggregator('DTLI', url);
    if (result.found && result.html && result.html.includes('review-item') &&
        quickTitleCheck(result.html, show.title)) {
      console.log(`    ✓ Found via slug map: ${url}`);
      return { url, html: result.html };
    }
    console.log(`    ⚠ Mapped URL failed, falling back to homepage discovery...`);
  }

  // Homepage discovery — DTLI's homepage features the ~20 most-recent shows and
  // updates within minutes of a new review page going live. One fetch beats both
  // URL-guessing (8+ HTTP probes) and sitemap discovery (multi-XML fetch) when the
  // show is recent. Lost Boys 2026-04-26 readiness audit. Falls through to sitemap
  // discovery on miss.
  try {
    const { findDTLIShowLinkOnHomepage } = require('./lib/dtli-homepage-scan.js');
    console.log('  DTLI: homepage scan...');
    const homepageResult = await searchAggregator('DTLI-Homepage', 'https://didtheylikeit.com/');
    if (homepageResult.found && homepageResult.html) {
      const homeUrl = findDTLIShowLinkOnHomepage(homepageResult.html, show, { logger: console });
      if (homeUrl) {
        console.log(`    homepage match: ${homeUrl}`);
        const showResult = await searchAggregator('DTLI', homeUrl);
        if (showResult.found && showResult.html && showResult.html.includes('review-item') &&
            quickTitleCheck(showResult.html, show.title)) {
          console.log(`    ✓ Found via homepage scan: ${homeUrl}`);
          return { url: homeUrl, html: showResult.html };
        }
        console.log(`    ⚠ Homepage URL failed validation, falling back to sitemap discovery...`);
      } else {
        console.log('    homepage: no matching anchor (falling back to sitemap discovery)');
      }
    } else {
      console.log('    homepage: fetch failed (falling back to sitemap discovery)');
    }
  } catch (err) {
    console.log(`    homepage discovery error (falling through): ${err.message}`);
  }

  // Live sitemap discovery — runs when the slug map misses (new shows between
  // weekly discover-dtli-slugs.js runs) OR when the mapped URL fails validation.
  // Cheaper than URL-guessing (one sitemap fetch vs N failed HTTPS gets) and
  // catches shows with non-predictable slugs like "hamlet-bway" or "cabaret-at-the-kit-kat-club".
  try {
    const { discoverDtliSlug } = require('./lib/dtli-slug-discover.js');
    console.log('  DTLI: live sitemap discovery...');
    const discovery = await discoverDtliSlug(show);
    if (discovery.url) {
      console.log(`    sitemap found: ${discovery.slug} (score ${discovery.candidates[0].score})`);
      const sitemapResult = await searchAggregator('DTLI', discovery.url);
      if (sitemapResult.found && sitemapResult.html && sitemapResult.html.includes('review-item') &&
          quickTitleCheck(sitemapResult.html, show.title)) {
        console.log(`    ✓ Found via sitemap discovery: ${discovery.url}`);
        return { url: discovery.url, html: sitemapResult.html };
      }
      console.log(`    ⚠ Sitemap-discovered URL failed validation, falling back to URL guessing...`);
    } else {
      console.log('    sitemap: no candidate (falling back to URL guessing)');
    }
  } catch (err) {
    console.log(`    sitemap discovery error (falling through): ${err.message}`);
  }

  const titleSlug = slugify(show.title);
  const titleNoArticle = slugify(show.title.replace(/^(the|a|an)\s+/i, ''));
  const baseSlug = show.slug.replace(/-\d{4}$/, ''); // Remove year suffix

  // Base variations (without suffix)
  const baseVariations = [
    baseSlug,
    titleSlug,
    titleNoArticle,
    show.title.toLowerCase().replace(/:/g, '').replace(/[^a-z0-9]+/g, '-'),
    show.title.toLowerCase().replace(/-the-/g, '-').replace(/[^a-z0-9]+/g, '-'),
  ];

  // PRIORITY: Suffix order depends on category
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);
  const allVariations = [];

  if (isWestEnd) {
    // West End / Off-West End: try -west-end and -london suffixes
    for (const base of baseVariations) {
      allVariations.push(base + '-west-end');
    }
    for (const base of baseVariations) {
      allVariations.push(base + '-london');
    }
    for (const base of baseVariations) {
      allVariations.push(base);
    }
  } else if (isOffBroadway) {
    // Off-Broadway: try -off-broadway suffix first, then no suffix, then base
    for (const base of baseVariations) {
      allVariations.push(base + '-off-broadway');
    }
    for (const base of baseVariations) {
      allVariations.push(base);
    }
  } else {
    // Broadway: try -bway suffix FIRST to avoid off-Broadway pages
    for (const base of baseVariations) {
      allVariations.push(base + '-bway');
    }

    // Then try -broadway suffix
    for (const base of baseVariations) {
      allVariations.push(base + '-broadway');
    }

    // Then try -revival suffix
    for (const base of baseVariations) {
      allVariations.push(base + '-revival');
    }

    // Finally, try without suffix (lowest priority - may hit wrong production)
    for (const base of baseVariations) {
      allVariations.push(base);
    }
  }

  // Special cases for known patterns (revivals, common name conflicts)
  const specialCases = {
    'merrily-we-roll-along': ['merrily-we-roll-along-bway'],
    'appropriate': ['appropriate-bway'],
    'an-enemy-of-the-people': ['an-enemy-of-the-people-bway', 'enemy-of-the-people'],
    'the-outsiders': ['the-outsiders-bway', 'outsiders'],
    'the-notebook': ['the-notebook-bway', 'notebook'],
    'water-for-elephants': ['water-for-elephants-bway'],
    'mother-play': ['mother-play-bway'],
    'stereophonic': ['stereophonic-bway'],
    'suffs': ['suffs-bway'],
    'the-great-gatsby': ['the-great-gatsby-bway', 'great-gatsby'],
    'the-roommate': ['the-roommate-bway', 'roommate'],
    'cabaret': ['cabaret-bway', 'cabaret-revival'],
    'uncle-vanya': ['uncle-vanya-bway'],
    'prayer-for-the-french-republic': ['prayer-for-the-french-republic-bway'],
    'illinoise': ['illinoise-bway'],
    'the-wiz': ['the-wiz-bway', 'wiz'],
    'lempicka': ['lempicka-bway'],
    'the-who-s-tommy': ['the-whos-tommy-bway', 'whos-tommy'],
    'days-of-wine-and-roses': ['days-of-wine-and-roses-bway'],
    // Shows with subtitles - full title needed
    'doubt': ['doubt-a-parable', 'doubt-a-parable-bway'],
    'doubt-a-parable': ['doubt-a-parable'],
    'just-for-us': ['just-for-us-bway', 'just-for-us-a-very-important-show'],
    'harmony': ['harmony-bway', 'harmony-a-new-musical'],
    'purlie-victorious': ['purlie-victorious-bway', 'purlie-victorious-a-non-confederate-romp'],
    'gutenberg-the-musical': ['gutenberg-the-musical-bway'],
    'the-thanksgiving-play': ['the-thanksgiving-play-bway'],
    'titanique': ['titanique-bway'],
    'the-outsiders': ['the-outsiders-bway'],
  };

  // Check special cases for baseSlug
  if (specialCases[baseSlug]) {
    // Insert special cases at the BEGINNING (highest priority)
    allVariations.unshift(...specialCases[baseSlug]);
  }

  // Also check special cases for titleSlug (handles subtitles like "Doubt: A Parable")
  if (specialCases[titleSlug] && titleSlug !== baseSlug) {
    allVariations.unshift(...specialCases[titleSlug]);
  }

  console.log('  Searching Did They Like It...');

  // Remove duplicates and empty strings
  const uniqueVariations = [...new Set(allVariations)].filter(v => v && v.length > 0);

  for (const slug of uniqueVariations) {
    const url = `https://didtheylikeit.com/shows/${slug}/`;
    const result = await searchAggregator('DTLI', url);
    if (result.found && result.html && result.html.includes('review-item') &&
        quickTitleCheck(result.html, show.title)) {
      console.log(`    ✓ Found at: ${url}`);
      return { url, html: result.html };
    }
    await sleep(300);
  }

  console.log('    ✗ Not found on DTLI');
  return null;
}

/**
 * Try to find show on Show Score using URL pattern matching
 * Show Score uses various URL patterns - we try multiple variations
 * Uses Playwright to scroll through the carousel and get ALL critic reviews
 */
async function searchShowScore(show) {
  console.log('  Searching Show Score...');

  // Check curated URL map first (from discover-show-score-urls-from-listings.js)
  const urlMap = getShowScoreUrlMap();
  const curatedUrl = urlMap[show.id];
  if (curatedUrl) {
    console.log('    Using curated URL from show-score-urls.json');
    const isOffBroadway = show.category === 'off-broadway';
    if (chromium) {
      const result = await scrapeShowScoreWithPlaywright(curatedUrl, { isOffBroadway, expectedVenue: show.venue, showId: show.id, openingDate: show.openingDate, closingDate: show.closingDate });
      if (result) {
        console.log(`    ✓ Found at: ${curatedUrl}`);
        return { url: curatedUrl, html: result.html, reviews: result.reviews };
      }
    } else {
      const result = await searchAggregator('ShowScore', curatedUrl);
      if (result.found && result.html && result.html.includes('score') &&
          quickTitleCheck(result.html, show.title)) {
        console.log(`    ✓ Found at: ${curatedUrl}`);
        return { url: curatedUrl, html: result.html };
      }
    }
    console.log('    Curated URL failed, falling back to slug variations...');
  }

  const year = new Date(show.openingDate).getFullYear();
  const titleSlug = slugify(show.title);
  const titleNoColonSlug = slugify(show.title.replace(/:/g, ''));
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);

  // For musicals, Show Score often appends "-the-musical-broadway"
  const isMusical = show.type === 'musical';

  // Show Score URL base depends on category
  const showScoreBase = isWestEnd
    ? 'https://www.show-score.com/uk/london/west-end-shows'
    : isOffBroadway
      ? 'https://www.show-score.com/off-broadway-shows'
      : 'https://www.show-score.com/broadway-shows';

  // Build slug variations based on category
  let variations;
  if (isWestEnd) {
    // West End / Off-West End: try -west-end and -london suffixes
    const weSlug = show.slug.replace(/-(?:off-)?west-end$/, '');
    variations = [
      `${titleSlug}-west-end`,
      `${titleSlug}-london`,
      `${titleNoColonSlug}-west-end`,
      `${titleNoColonSlug}-london`,
      `${weSlug}-west-end`,
      `${weSlug}-london`,
      ...(isMusical ? [
        `${titleSlug}-the-musical-west-end`,
        `${titleSlug}-the-musical-london`,
      ] : []),
      titleSlug,
      titleNoColonSlug,
      weSlug,
    ];
  } else if (isOffBroadway) {
    // Off-Broadway: no -broadway suffix needed
    variations = [
      show.slug,
      titleSlug,
      titleNoColonSlug,
      ...(isMusical ? [
        `${titleSlug}-the-musical`,
        `${titleNoColonSlug}-the-musical`,
      ] : []),
      `${titleSlug}-${year}`,
      `${titleNoColonSlug}-${year}`,
    ];
  } else {
    // Broadway: try -broadway suffix first to avoid redirects
    variations = [
      `${titleSlug}-broadway`,
      `${titleNoColonSlug}-broadway`,
      `${show.slug}-broadway`,
      ...(isMusical ? [
        `${titleSlug}-the-musical-broadway`,
        `${titleNoColonSlug}-the-musical-broadway`,
        `${show.slug}-the-musical-broadway`,
      ] : []),
      ...(!isMusical ? [
        `${titleSlug}-play-broadway`,
        `${titleNoColonSlug}-play-broadway`,
      ] : []),
      show.slug,
      titleSlug,
      titleNoColonSlug,
      `${titleSlug}-${year}`,
      `${titleNoColonSlug}-${year}`,
    ];
  }

  // Try Playwright first if available (to get ALL reviews via carousel scrolling)
  if (chromium) {
    for (const slug of [...new Set(variations)]) {
      const url = `${showScoreBase}/${slug}`;
      const result = await scrapeShowScoreWithPlaywright(url, { isOffBroadway, expectedVenue: show.venue, showId: show.id, openingDate: show.openingDate, closingDate: show.closingDate });
      if (result) {
        console.log(`    ✓ Found at: ${url}`);
        return { url, html: result.html, reviews: result.reviews };
      }
      await sleep(300);
    }
  } else {
    // Fall back to HTTP scraping if Playwright not available
    for (const slug of [...new Set(variations)]) {
      const url = `${showScoreBase}/${slug}`;
      const result = await searchAggregator('ShowScore', url);

      // Check that we got actual show content, not the homepage, and not a wrong show
      // For off-broadway shows, accept /off-broadway-shows/ but still reject /off-off-broadway-shows/
      if (result.found && result.html &&
          result.html.includes('score') &&
          !result.html.includes('<title>Show Score | NYC Theatre Reviews and Tickets</title>') &&
          !result.html.includes('/off-off-broadway-shows/') &&
          (isOffBroadway || !result.html.includes('/off-broadway-shows/')) &&
          quickTitleCheck(result.html, show.title)) {
        console.log(`    ✓ Found at: ${url}`);
        return { url, html: result.html };
      }
      await sleep(300);
    }
  }

  console.log('    ✗ Not found on Show Score');
  return null;
}

/**
 * Scrape Show Score page using Playwright with carousel navigation
 * This allows us to get ALL critic reviews, not just the first 8
 */
async function scrapeShowScoreWithPlaywright(url, options = {}) {
  const { isOffBroadway = false, expectedVenue = null, showId = null, openingDate = null, closingDate = null } = options;
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Check if we got redirected to a different type of show
    const finalUrl = page.url();
    // Always reject off-off-broadway
    if (finalUrl.includes('/off-off-broadway-shows/')) {
      await browser.close();
      return null;
    }
    // For Broadway shows, reject off-broadway redirects
    if (!isOffBroadway && finalUrl.includes('/off-broadway-shows/')) {
      await browser.close();
      return null;
    }

    // Check if we're on the right page (not homepage)
    const title = await page.title();
    if (title === 'Show Score | NYC Theatre Reviews and Tickets' || !title.includes('Show Score')) {
      await browser.close();
      return null;
    }

    // Soft venue validation: extract venue from meta description and compare
    if (expectedVenue) {
      const metaDesc = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');
      const cleaned = metaDesc.replace(/&nbsp;/g, ' ');
      const venueMatch = cleaned.match(/\bfor\s+.+?\s+at\s+(.+?)(?:\.|,|$)/i);
      if (venueMatch) {
        const pageVenue = venueMatch[1].trim();
        const normVenue = s => (s || '').toLowerCase().replace(/\bthe\b/g, '').replace(/\btheatre\b/g, 'theater').replace(/\s+/g, ' ').trim();
        const nPage = normVenue(pageVenue);
        const nExpected = normVenue(expectedVenue);
        if (nPage && nExpected && !nPage.includes(nExpected) && !nExpected.includes(nPage)) {
          console.log(`    [VENUE WARN] Show Score page says "${pageVenue}", expected "${expectedVenue}"${showId ? ` for ${showId}` : ''}`);
        }
      }
    }

    // Wait for critic reviews section to load
    await page.waitForSelector('h2:has-text("Critic Reviews")', { timeout: 5000 }).catch(() => null);

    // Extract all critic reviews by scrolling through the carousel
    const reviews = await page.evaluate(() => {
      const reviews = [];

      // Find the critic reviews section
      let criticSection = null;
      document.querySelectorAll('h2').forEach(h2 => {
        if (h2.textContent.includes('Critic Reviews')) {
          criticSection = h2.nextElementSibling;
        }
      });

      if (!criticSection) return reviews;

      // Extract reviews from the visible carousel
      // Show Score renders reviews in cards with outlet logo, critic name, excerpt, and URL
      const reviewCards = criticSection.querySelectorAll('[class*="review"]');

      // Also try finding by structure - look for Read more links
      const readMoreLinks = criticSection.querySelectorAll('a[href*="http"]:not([href*="show-score.com"])');

      readMoreLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href.includes('youtube.com') || href.includes('youtu.be') ||
            href.includes('spotify.com') || href.includes('facebook.com') ||
            href.includes('twitter.com') || href.includes('instagram.com')) {
          return;
        }

        // Find the parent review card to extract outlet and critic info
        // Must use .review-tile-v2 to reach the full card root (not just the excerpt div)
        const card = link.closest('.review-tile-v2') || link.closest('div[class]');
        if (!card) return;

        // Look for outlet image alt text (in the header section)
        const outletImg = card.querySelector('img[alt]');
        const outlet = outletImg?.getAttribute('alt') || '';

        // Look for critic name link (in the header section)
        const criticLink = card.querySelector('a[href*="/member/"]');
        const critic = criticLink?.textContent?.trim() || '';

        // Look for date
        let date = '';
        card.querySelectorAll('div').forEach(div => {
          const text = div.textContent;
          if (text && text.match(/\w+\s+\d+,?\s*\d{4}/) && text.length < 30) {
            date = text.trim();
          }
        });

        // Look for excerpt
        const paragraph = card.querySelector('p');
        const excerpt = paragraph?.textContent?.replace(/Read more.*$/, '').trim() || '';

        // Show Score displays star ratings on WE critic review cards via CSS
        // --rating variable. ONLY extract integer values (Show Score displays
        // whole stars). Non-integer values like 3.9 are internal normalizations
        // that don't match the outlet's actual rating.
        // IMPORTANT: Show Score stars are wrong ~11% of the time. These should
        // only be used as a FALLBACK when we can't get the rating from the
        // outlet's own page or from WET/LBO roundups. The downstream scoring
        // pipeline (rebuild-helpers.js P3b) already downgrades Show Score
        // originalScores for WE shows below LLM scores.
        let starRating = null;
        let starMax = null;
        const starsEl = card.querySelector('.review-tile-v2__stars');
        if (starsEl) {
          const style = starsEl.getAttribute('style') || '';
          const ratingMatch = style.match(/--rating:\s*([\d.]+)/);
          const gapsMatch = style.match(/--gaps:\s*([\d.]+)/);
          if (ratingMatch) {
            const val = parseFloat(ratingMatch[1]);
            // Only trust integer star counts — fractional values are
            // Show Score's internal normalization, not actual ratings
            if (Number.isInteger(val) && val >= 1 && val <= 5) {
              starRating = val;
            }
          }
          if (gapsMatch) starMax = parseInt(gapsMatch[1]);
        }

        if (href && !reviews.some(r => r.url === href)) {
          reviews.push({
            url: href,
            outlet: outlet,
            critic: critic,
            date: date,
            excerpt: excerpt,
            starRating: starRating,
            starMax: starMax
          });
        }
      });

      return reviews;
    });

    // Extract expected review count from "Critic Reviews (N)" heading
    const expectedReviewCount = await page.evaluate(() => {
      let count = null;
      document.querySelectorAll('h2').forEach(h2 => {
        const match = h2.textContent.match(/Critic Reviews\s*\((\d+)\)/);
        if (match) {
          count = parseInt(match[1]);
        }
      });
      return count;
    });
    if (expectedReviewCount) {
      console.log(`    Show Score reports ${expectedReviewCount} critic reviews`);
    }

    // Scroll down to critic reviews section for better interaction
    await page.evaluate(() => {
      const h2s = document.querySelectorAll('h2');
      for (const h2 of h2s) {
        if (h2.textContent.includes('Critic Reviews')) {
          h2.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    });
    await sleep(1000);

    console.log(`    Initial reviews found: ${reviews.length}`);

    // Carousel scrolling to get additional reviews (wrapped in 30s timeout)
    const scrollCarousel = async () => {
      let previousCount = reviews.length;
      let noProgressRounds = 0;
      let totalAttempts = 0;

      while (noProgressRounds < 4 && totalAttempts < 20) {
        totalAttempts++;

        if (expectedReviewCount && reviews.length >= expectedReviewCount) {
          console.log(`    ✓ Captured all ${reviews.length} reviews (expected ${expectedReviewCount})`);
          return;
        }

        // Use only the known-working selectors (tested: these resolve fast)
        const arrow = await page.$('.js-scrollable-block__next-page-btn')
                   || await page.$('.scrollable-block__next-page-btn');
        if (arrow) {
          try { await arrow.click(); } catch { /* click failed */ }
        } else {
          // Direct scroll fallback
          await page.evaluate(() => {
            const h2s = document.querySelectorAll('h2');
            for (const h2 of h2s) {
              if (h2.textContent.includes('Critic Reviews')) {
                const next = h2.nextElementSibling;
                if (next) next.scrollBy({ left: 350 });
                break;
              }
            }
          });
        }
        await sleep(800);

        // Re-extract reviews
        const newReviews = await page.evaluate(() => {
          const results = [];
          let section = null;
          document.querySelectorAll('h2').forEach(h2 => {
            if (h2.textContent.includes('Critic Reviews')) section = h2.nextElementSibling;
          });
          if (!section) return results;
          section.querySelectorAll('a[href*="http"]:not([href*="show-score.com"])').forEach(link => {
            const href = link.getAttribute('href');
            if (!href || /youtube|spotify|facebook|twitter|instagram/.test(href)) return;
            const card = link.closest('.review-tile-v2') || link.closest('div[class]');
            if (!card) return;
            const outlet = card.querySelector('img[alt]')?.getAttribute('alt') || '';
            const critic = card.querySelector('a[href*="/member/"]')?.textContent?.trim() || '';
            const excerpt = card.querySelector('p')?.textContent?.replace(/Read more.*$/, '').trim() || '';
            if (!results.some(r => r.url === href)) results.push({ url: href, outlet, critic, excerpt });
          });
          return results;
        });

        let newCount = 0;
        for (const r of newReviews) {
          if (!reviews.some(existing => existing.url === r.url)) {
            reviews.push(r);
            newCount++;
          }
        }

        if (reviews.length === previousCount) {
          noProgressRounds++;
        } else {
          if (newCount > 0) console.log(`    Scroll ${totalAttempts}: +${newCount} reviews (total: ${reviews.length})`);
          noProgressRounds = 0;
          previousCount = reviews.length;
        }
      }

      if (reviews.length < (expectedReviewCount || 0)) {
        console.log(`    ⚠ Only captured ${reviews.length}/${expectedReviewCount} reviews (stopped after ${totalAttempts} attempts)`);
      }
    };

    // Wrap carousel scrolling in a hard 30s timeout
    await Promise.race([
      scrollCarousel(),
      new Promise(resolve => setTimeout(() => {
        console.log(`    ⏱ Carousel scroll timeout (30s) — stopping with ${reviews.length} reviews`);
        resolve();
      }, 30000))
    ]);

    // Date-aware validation: check if review dates match this production
    // Uses median review date — if >2 years from opening, it's likely a different production
    if (openingDate && reviews.length >= 3) {
      const showYear = new Date(openingDate).getFullYear();
      const datedReviews = reviews
        .map(r => {
          if (!r.date) return null;
          return parseDate(r.date);
        })
        .filter(d => d && !isNaN(d.getTime()) && d.getFullYear() >= 2000);

      if (datedReviews.length >= 3) {
        datedReviews.sort((a, b) => a - b);
        const median = datedReviews[Math.floor(datedReviews.length / 2)];
        if (Math.abs(median.getFullYear() - showYear) > 2) {
          console.log(`    [DATE MISMATCH] Median review date ${median.toISOString().split('T')[0]} is >2 years from opening ${openingDate} for ${showId || 'unknown'}`);
          console.log(`    This Show Score page likely belongs to a different production — skipping`);
          await browser.close();
          return null;
        }
      }
    }

    // Get the full HTML for fallback extraction
    const html = await page.content();

    await browser.close();
    return { html, reviews };
  } catch (error) {
    console.log(`    Playwright error: ${error.message}`);
    if (browser) await browser.close();
    return null;
  }
}

/**
 * Extract reviews from Show Score HTML
 */
function extractShowScoreReviews(html, showId, showTitle) {
  const reviews = [];

  // URL slug validation helper — rejects URLs that don't match the show title
  function validateUrl(url) {
    if (!url || !showTitle) return url;
    if (!urlLooksLikeReview(url, showTitle)) {
      console.log(`    ✗ Rejected Show Score URL: slug doesn't match "${showTitle}" — ${url.substring(0, 80)}`);
      return null;
    }
    return url;
  }

  // Extract critic reviews from review tiles
  // Show Score uses .review-tile-v2.-critic for critic reviews
  const reviewTileRegex = /<div[^>]*class="[^"]*review-tile-v2[^"]*-critic[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;

  // Simpler approach: Look for outlet names with URLs
  // Pattern: outlet image alt text, author name, date, excerpt, URL

  // Extract from JSON-LD if present (more reliable)
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const script of jsonLdMatch) {
      try {
        const jsonContent = script.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(jsonContent);
        if (data.review && Array.isArray(data.review)) {
          for (const review of data.review) {
            if (review.author && review.url) {
              // Resolve outlet: try publisher name first, then URL lookup
              let outletName, outletId;
              if (review.publisher?.name) {
                outletName = review.publisher.name;
                outletId = slugify(outletName);
              } else {
                const resolved = resolveOutletFromUrl(review.url);
                if (resolved) {
                  outletId = resolved.outletId;
                  outletName = resolved.displayName;
                } else {
                  // Fallback: use domain base
                  try {
                    const hostname = new URL(review.url).hostname.replace(/^www\./, '').toLowerCase();
                    outletId = hostname.split('.')[0];
                    outletName = outletId;
                  } catch {
                    outletId = 'unknown';
                    outletName = 'Unknown';
                  }
                }
              }
              reviews.push({
                showId,
                outlet: outletName,
                outletId,
                criticName: review.author?.name || 'Unknown',
                url: validateUrl(review.url),
                excerpt: review.reviewBody || null,
                publishDate: normalizePublishDate(review.datePublished) || null,
                source: 'show-score'
              });
            }
          }
        }
      } catch (e) {
        // Skip invalid JSON-LD
      }
    }
  }

  // Also try to extract from HTML structure
  // Look for review URLs with outlet context
  const outletUrlPattern = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>.*?Read\s*(?:more|full\s*review)/gi;
  let match;
  while ((match = outletUrlPattern.exec(html)) !== null) {
    const url = match[1];

    // Skip non-review URLs (social media, ticket sites, aggregators, etc.)
    const { isBlockedReviewUrl } = require('./lib/domain-filters');
    if (isBlockedReviewUrl(url)) {
      logExclusion({ script: 'gather-reviews', showId, file: '-', reason: 'skippedBlockedUrl', details: { url } });
      continue;
    }

    // Skip URLs with paths strongly indicating non-review content
    const nonReviewPathPatterns = [
      /\/(?:video|videos|gallery|galleries|slideshow|photo-gallery)\//i,
      /\/(?:podcast|podcasts|episode)\//i,
      /\/(?:obituary|obituaries|in-memoriam)\//i,
      /\/(?:behind-the-scenes|backstage)\//i,
      /\/(?:preview|previews)\//i,        // preview articles are not reviews (Cats postmortem #12)
      /\/(?:interview|interviews)\//i,    // interviews are not reviews
      /\/(?:casting|cast-announcement|casting-announced)\//i, // casting news is not a review
    ];
    try {
      const urlPath = new URL(url).pathname;
      if (nonReviewPathPatterns.some(p => p.test(urlPath))) {
        continue;
      }
    } catch { /* malformed URL — let through for downstream handling */ }

    // Try to find outlet context nearby
    const contextStart = Math.max(0, match.index - 500);
    const context = html.substring(contextStart, match.index + match[0].length);

    // Common outlet patterns
    const outletPatterns = [
      { pattern: /New York Times|nytimes\.com/i, outlet: 'The New York Times', outletId: 'nytimes' },
      { pattern: /Vulture|vulture\.com/i, outlet: 'Vulture', outletId: 'vulture' },
      { pattern: /Variety|variety\.com/i, outlet: 'Variety', outletId: 'variety' },
      { pattern: /Hollywood Reporter|hollywoodreporter\.com/i, outlet: 'The Hollywood Reporter', outletId: 'hollywood-reporter' },
      { pattern: /Time Out London|timeout\.com\/london/i, outlet: 'Time Out London', outletId: 'timeout-london' },
      { pattern: /Time Out|timeout\.com/i, outlet: 'Time Out New York', outletId: 'timeout' },
      { pattern: /New York Post|nypost\.com/i, outlet: 'New York Post', outletId: 'nypost' },
      { pattern: /TheaterMania|theatermania\.com/i, outlet: 'TheaterMania', outletId: 'theatermania' },
      { pattern: /Deadline|deadline\.com/i, outlet: 'Deadline', outletId: 'deadline' },
      { pattern: /New York Theater|newyorktheater\.me/i, outlet: 'New York Theater', outletId: 'nyt-theater' },
      { pattern: /Theatrely|theatrely\.com/i, outlet: 'Theatrely', outletId: 'theatrely' },
      { pattern: /Broadway World|broadwayworld\.com/i, outlet: 'BroadwayWorld', outletId: 'broadwayworld' },
      { pattern: /Stage and Cinema|stageandcinema\.com/i, outlet: 'Stage and Cinema', outletId: 'stageandcinema' },
      // Additional outlets found on Show Score
      { pattern: /New York Theatre Guide|newyorktheatreguide\.com/i, outlet: 'New York Theatre Guide', outletId: 'nytg' },
      { pattern: /Talkin'?\s*Broadway|talkinbroadway\.com/i, outlet: "Talkin' Broadway", outletId: 'talkinbroadway' },
      { pattern: /TheaterScene|theaterscene\.net/i, outlet: 'TheaterScene.net', outletId: 'theaterscene' },
      { pattern: /Entertainment Weekly|ew\.com/i, outlet: 'Entertainment Weekly', outletId: 'ew' },
      { pattern: /The Guardian|theguardian\.com/i, outlet: 'The Guardian', outletId: 'guardian' },
      { pattern: /Associated Press|apnews\.com/i, outlet: 'Associated Press', outletId: 'ap' },
      { pattern: /New Yorker|newyorker\.com/i, outlet: 'The New Yorker', outletId: 'newyorker' },
      { pattern: /The Wrap|thewrap\.com/i, outlet: 'The Wrap', outletId: 'thewrap' },
      { pattern: /The Stage|thestage\.co\.uk/i, outlet: 'The Stage', outletId: 'thestage' },
      { pattern: /CurtainUp|curtainup\.com/i, outlet: 'CurtainUp', outletId: 'curtainup' },
      { pattern: /AM New York|amnewyork\.com/i, outlet: 'AM New York', outletId: 'amny' },
    ];

    let matched = false;
    for (const { pattern, outlet, outletId } of outletPatterns) {
      if (pattern.test(context) || pattern.test(url)) {
        // Check if we already have this review (by URL, not just outlet — same outlet may have multiple critics)
        if (!reviews.some(r => r.url === url)) {
          // Try to extract critic name from context
          // Show Score has links like: <a href="/member/jonathan-mandell">Jonathan Mandell</a>
          let criticName = 'Unknown';
          const criticLinkMatch = context.match(/href="\/member\/[^"]+">([^<]+)<\/a>/i);
          if (criticLinkMatch) {
            criticName = criticLinkMatch[1].trim();
          }

          reviews.push({
            showId,
            outlet,
            outletId,
            criticName,
            url: validateUrl(url),
            source: 'show-score'
          });
        }
        matched = true;
        break;
      }
    }

    // Fallback: extract review even if outlet not in predefined list
    if (!matched && !reviews.some(r => r.url === url)) {
      // Try to get outlet name from image alt text in context
      const imgAltMatch = context.match(/img[^>]*alt="([^"]+)"/i);
      let outlet = null;
      let outletId = null;

      if (imgAltMatch && imgAltMatch[1]) {
        outlet = imgAltMatch[1].trim();
        outletId = slugify(outlet);
      }

      // If no outlet from HTML, try resolving from URL
      if (!outlet) {
        const resolved = resolveOutletFromUrl(url);
        if (resolved) {
          outletId = resolved.outletId;
          outlet = resolved.displayName;
        } else {
          // Fallback: use domain base
          try {
            const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
            const domainBase = hostname.split('.')[0];
            outletId = domainBase;
            outlet = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
          } catch {
            outletId = 'unknown';
            outlet = 'Unknown';
          }
        }
      }

      // Try to extract critic name
      let criticName = 'Unknown';
      const criticLinkMatch = context.match(/href="\/member\/[^"]+">([^<]+)<\/a>/i);
      if (criticLinkMatch) {
        criticName = criticLinkMatch[1].trim();
      }

      reviews.push({
        showId,
        outlet,
        outletId,
        criticName,
        url: validateUrl(url),
        source: 'show-score'
      });
    }
  }

  if (reviews.length > 0) {
    console.log(`    Extracted ${reviews.length} reviews from Show Score`);
  } else if (html && html.length > 5000) {
    // Distinguish "no critic reviews on this show" from "structure changed".
    // Show Score doesn't always have critic reviews for newly-opened shows; the
    // section is omitted entirely until reviews are added (no "Critic Reviews"
    // heading and no review-tile-v2 -critic markup). Treating that as an
    // extractor bug spammed misleading warnings during Joe Turner opening night.
    const hasCriticHeading = /Critic\s+Reviews\s*\(\d+\)/i.test(html);
    const hasCriticTile = /review-tile-v2[^>'"]*-critic/.test(html);
    if (!hasCriticHeading && !hasCriticTile) {
      console.log(`    Show Score page loaded (${(html.length / 1024).toFixed(0)}KB) — no critic-reviews section on this show yet`);
    } else {
      console.log(`    ⚠️  Show Score page loaded (${(html.length / 1024).toFixed(0)}KB), critic-reviews section present (heading=${hasCriticHeading} tiles=${hasCriticTile}) but 0 reviews extracted — HTML structure may have changed`);
    }
  }

  // Domain supplement — catches outlets not in the hand-maintained outletPatterns
  // list above (outlet-registry coverage is broader than that ~25-outlet list).
  try {
    const { supplementOutletsFromAnchors } = require('./lib/outlet-domain-supplement');
    const { added, newReviews } = supplementOutletsFromAnchors({
      html,
      reviews,
      showId,
      showTitle,
      sourceName: 'show-score-domain-supplement',
      excludeDomains: ['show-score.com', 'showscore.com'],
      urlTitleCheck: urlLooksLikeReview,
      crossShowCheck: detectCrossShowUrlMismatch,
      makeStub: (oid, url) => ({
        showId,
        outletId: oid,
        outlet: getOutletDisplayName(oid) || oid,
        criticName: 'Unknown',
        url,
        source: 'show-score-domain-supplement',
      }),
    });
    reviews.push(...newReviews);
    if (added > 0) {
      console.log(`    [Show Score supplement] added ${added} outlet(s) missed by hand-pattern list`);
    }
  } catch (e) {
    console.log(`    [Show Score supplement] error (non-fatal): ${(e.message || '').substring(0, 100)}`);
  }

  return reviews;
}

/**
 * Extract reviews from DTLI HTML with individual thumb data
 */
function extractDTLIReviews(html, showId, dtliUrl, showTitle) {
  const reviews = [];

  // Extract summary thumb counts from the numbered hand images
  // Format: thumbs-up/thumb-N.png, thumbs-meh/thumb-N.png, thumbs-down/thumb-N.png
  const thumbUpMatch = html.match(/thumbs-up\/thumb-(\d+)\.png/);
  const thumbMehMatch = html.match(/thumbs-meh\/thumb-(\d+)\.png/);
  const thumbDownMatch = html.match(/thumbs-down\/thumb-(\d+)\.png/);

  const summary = {
    up: thumbUpMatch ? parseInt(thumbUpMatch[1]) : 0,
    meh: thumbMehMatch ? parseInt(thumbMehMatch[1]) : 0,
    down: thumbDownMatch ? parseInt(thumbDownMatch[1]) : 0,
  };
  console.log(`    Found ${summary.up} UP, ${summary.meh} MEH, ${summary.down} DOWN`);
  if (summary.up === 0 && summary.meh === 0 && summary.down === 0 && html.length > 5000) {
    console.log(`    ⚠️  DTLI page loaded (${(html.length / 1024).toFixed(0)}KB) but 0 thumb images found — image URL pattern may have changed`);
  }

  // Extract individual reviews from review-item blocks (class="review-item" or "poster-review-item")
  // Pattern matches each review item block
  const reviewItemRegex = /<div class="(?:poster-)?review-item">([\s\S]*?)(?=<div class="(?:poster-)?review-item">|<\/section>|<div class="" id="modal-breakdown")/gi;

  // Track URLs claimed per outlet to detect multi-critic URL collisions (Proof incident:
  // NYSR listed Torre and Suskin with the same URL; second critic must get null URL
  // so SERP can discover the correct per-critic URL independently).
  const claimedUrlsByOutlet = new Map(); // outletId → Set<normalizedUrl>

  let match;
  while ((match = reviewItemRegex.exec(html)) !== null) {
    const reviewHtml = match[1];

    // Extract outlet from img alt text (class="review-item-attribution")
    // DTLI uses two HTML formats: old-style uses img.review-item-attribution with alt text,
    // new-style (2024+) uses div.review_image with outlet name as text content
    const outletMatch = reviewHtml.match(/class="review-item-attribution"[^>]*alt="([^"]+)"/i) ||
                        reviewHtml.match(/alt="([^"]+)"[^>]*class="review-item-attribution"/i) ||
                        reviewHtml.match(/class="review_image"><div>([^<]+)<\/div>/i);

    // Extract thumb from BigThumbs image (BigThumbs_UP, BigThumbs_MEH, BigThumbs_DOWN)
    const thumbMatch = reviewHtml.match(/BigThumbs_(UP|MEH|DOWN)/i);

    // Extract critic name — prefer ?s= query param (always has full name)
    const criticSearchMatch = reviewHtml.match(/class="review-item-critic-name"[^>]*><a[^>]*href="[^"]*\?s=([^&"]+)/i);
    // Fallback: capture all text content including across <br> tags
    const criticTextMatch = reviewHtml.match(/class="review-item-critic-name"[^>]*>(?:<a[^>]*>)?([\s\S]*?)<\/(?:a|h2)>/i);

    // Extract date
    const dateMatch = reviewHtml.match(/class="review-item-date"[^>]*>([^<]+)/i);

    // Extract excerpt from paragraph
    const excerptMatch = reviewHtml.match(/<p class="paragraph">([^]*?)<\/p>/i);

    // Extract review URL from button link
    const urlMatch = reviewHtml.match(/href="(https?:\/\/[^"]+)"[^>]*class="[^"]*button-pink[^"]*review-item-button/i) ||
                     reviewHtml.match(/class="[^"]*button-pink[^"]*review-item-button[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i) ||
                     reviewHtml.match(/href="(https?:\/\/[^"]+)"[^>]*>READ THE REVIEW/i);

    if (!outletMatch || !urlMatch) {
      // Detect poster-review-item inner class mismatch — if the block is a poster variant
      // but inner classes changed, we'll silently skip it. Log so CI catches it.
      if (reviewHtml.length > 50) {
        console.log(`    ⚠️  DTLI review block skipped (no ${!outletMatch ? 'outlet' : 'URL'} match) — inner class names may have changed. Block preview: ${reviewHtml.substring(0, 120)}...`);
        logExclusion({ script: 'gather-reviews', showId, file: '-', reason: 'skippedDtliBlockParseFail', details: { missingField: !outletMatch ? 'outlet' : 'url', preview: reviewHtml.substring(0, 120) } });
      }
      continue;
    }

    {
      const outletName = outletMatch[1].trim();
      const outletId = slugify(outletName);
      const thumb = thumbMatch ? thumbMatch[1].toUpperCase() : null;
      let criticName = 'Unknown';
      if (criticSearchMatch) {
        criticName = decodeURIComponent(criticSearchMatch[1]).trim();
      } else if (criticTextMatch) {
        criticName = criticTextMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      }
      criticName = criticName.replace(/\s+/g, ' ').trim();
      const date = dateMatch ? dateMatch[1].trim() : null;
      let excerpt = excerptMatch ? excerptMatch[1].trim() : null;

      // Clean up excerpt HTML entities
      if (excerpt) {
        excerpt = excerpt
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#8217;/g, "'")
          .replace(/&#8220;/g, '"')
          .replace(/&#8221;/g, '"')
          .replace(/&#8212;/g, '—')
          .replace(/\s+/g, ' ')
          .trim();
      }

      // Validate URL slug matches show title (prevents cross-show contamination)
      let reviewUrl = urlMatch[1];
      if (showTitle && !urlLooksLikeReview(reviewUrl, showTitle)) {
        console.log(`    ✗ Rejected URL for ${outletId}: slug doesn't match "${showTitle}" — ${reviewUrl.substring(0, 80)}`);
        reviewUrl = null;
      }

      // Multi-critic URL collision guard (Proof incident): if this outlet already claimed
      // this URL for a different critic, nullify it here so each critic gets their own
      // correct URL discovered via SERP rather than both scoring the same article.
      if (reviewUrl) {
        const normalizedForDedup = reviewUrl.toLowerCase().replace(/\/$/, '');
        if (!claimedUrlsByOutlet.has(outletId)) claimedUrlsByOutlet.set(outletId, new Set());
        const claimed = claimedUrlsByOutlet.get(outletId);
        if (claimed.has(normalizedForDedup)) {
          console.log(`    ⚠ DTLI multi-critic URL collision at ${outletId}: ${criticName} shares URL with prior critic — nulling (will be re-discovered via SERP)`);
          reviewUrl = null;
        } else {
          claimed.add(normalizedForDedup);
        }
      }

      reviews.push({
        showId,
        outletId,
        outlet: outletName,
        criticName,
        url: reviewUrl,
        publishDate: normalizePublishDate(date),
        dtliExcerpt: excerpt,
        dtliThumb: thumb,
        source: 'dtli',
        dtliUrl,
      });
    }
  }

  if (reviews.length > 0) {
    console.log(`    Extracted ${reviews.length} individual reviews with thumb data`);
  } else {
    console.log(`    Warning: Could not extract individual reviews (HTML structure may have changed)`);
  }

  // Count-drift: DTLI thumb summary reports the TOTAL review count for the page.
  // If the block parser extracted fewer reviews than summary says exist, markup
  // drift is happening. Emit via exclusion-logger so the count-drift check plugin
  // can surface it on opening night.
  const summaryTotal = summary.up + summary.meh + summary.down;
  if (summaryTotal > reviews.length + 2) {
    const delta = summaryTotal - reviews.length;
    console.log(`    ⚠️  DTLI count drift: summary says ${summaryTotal} reviews but block parser extracted ${reviews.length} (delta=${delta})`);
    try {
      logExclusion({
        script: 'gather-reviews',
        showId,
        file: '-',
        reason: 'countDrift',
        details: { aggregator: 'dtli', summaryTotal, extracted: reviews.length, delta, url: dtliUrl },
      });
    } catch { /* non-fatal */ }
  }

  // Domain supplement (Balusters postmortem CLASS 2, 2026-04-21)
  // Delegated to scripts/lib/outlet-domain-supplement.js. DTLI block parser misses
  // outlets when markup changes or slug-map is stale; this catches them by domain.
  try {
    const { supplementOutletsFromAnchors } = require('./lib/outlet-domain-supplement');
    const { added, newReviews } = supplementOutletsFromAnchors({
      html,
      reviews,
      showId,
      showTitle,
      sourceName: 'dtli-domain-supplement',
      excludeDomains: ['didtheylikeit.com'],
      urlTitleCheck: urlLooksLikeReview,
      crossShowCheck: detectCrossShowUrlMismatch,
      makeStub: (oid, url) => ({
        showId,
        outletId: oid,
        outlet: getOutletDisplayName(oid) || oid,
        criticName: 'Unknown',
        url,
        source: 'dtli-domain-supplement',
        dtliUrl,
      }),
    });
    reviews.push(...newReviews);
    if (added > 0) {
      console.log(`    [DTLI Method 2] domain supplement added ${added} outlet(s) missed by block parser`);
    }
  } catch (e) {
    console.log(`    [DTLI Method 2] domain supplement error (non-fatal): ${(e.message || '').substring(0, 100)}`);
  }

  return reviews;
}

// isBWWRoundupContent() moved to scripts/lib/bww-roundup-validator.js (shared module)
// findBWWRoundupLinkOnHomepage() moved to scripts/lib/bww-homepage-scan.js — reuses
// validateBWWRoundupUrlMatchesShow so short-title / tryout logic is shared with the
// SERP + URL-guess paths.

/**
 * Search BroadwayWorld for Review Roundup article
 * Priority: 1) URL override, 2) Valid archive, 2.5) Homepage scrape, 3) SERP, 4) URL guess
 */
async function searchBWWRoundup(show, year, options = {}) {
  console.log('  Searching BroadwayWorld Review Roundups...');
  const showId = show.id;

  // Priority 0: Runtime URL override (passed directly at call time — bypasses SERP entirely)
  // Use when SERP returns wrong results (unindexed same-day pages, wrong-production results).
  // On opening night: pass --bww-roundup-url to opening-night-poller.js
  if (options.overrideUrl) {
    console.log(`    Using runtime URL override: ${options.overrideUrl}`);
    const result = await searchAggregator('BWW', options.overrideUrl);
    if (result.found && result.html && isBWWRoundupContent(result.html)) {
      console.log(`    ✓ Found at: ${options.overrideUrl} (runtime override)`);
      return { url: options.overrideUrl, html: result.html };
    }
    if (result.found && result.html && isCloudflareChallenge(result.html)) {
      console.log('    ⚠️  BWW is Cloudflare-gated — aborting (further fetches will burn credits for the same challenge)');
      return null;
    }
    console.log(`    ✗ Runtime override URL failed — falling through to other methods`);
  }

  // Priority 1: Check for manual URL override
  const urlOverridesPath = path.join(__dirname, '..', 'data', 'bww-roundup-urls.json');
  if (fs.existsSync(urlOverridesPath)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(urlOverridesPath, 'utf8'));
      if (overrides[showId]) {
        const overrideUrl = overrides[showId];
        console.log(`    Using URL override: ${overrideUrl}`);
        if (chromium) {
          const result = await scrapeBWWRoundupWithPlaywright(overrideUrl);
          if (result && result.html) {
            console.log(`    ✓ Found at: ${overrideUrl} (override + Playwright)`);
            return { url: overrideUrl, html: result.html };
          }
          if (result && result.cloudflareChallenge) {
            console.log('    ⚠️  BWW is Cloudflare-gated (Playwright) — falling through to searchAggregator');
          }
        }
        const result = await searchAggregator('BWW', overrideUrl);
        if (result.found && result.html && isBWWRoundupContent(result.html)) {
          console.log(`    ✓ Found at: ${overrideUrl} (override)`);
          return { url: overrideUrl, html: result.html };
        }
        if (result.found && result.html && isCloudflareChallenge(result.html)) {
          console.log('    ⚠️  BWW is Cloudflare-gated — aborting (further fetches will burn credits for the same challenge)');
          return null;
        }
      }
    } catch (e) { /* ignore override errors */ }
  }

  // Priority 2: Check for existing valid archive (less than 30 days old)
  // Skip cache near opening night — BWW roundups are updated with new reviews on opening day
  const isNearOpeningNight = show.openingDate &&
    Math.abs(Date.now() - new Date(show.openingDate).getTime()) < 2 * 24 * 60 * 60 * 1000; // within 48h
  const archivePath = path.join(__dirname, '..', 'data', 'aggregator-archive', 'bww-roundups', `${showId}.html`);
  if (!isNearOpeningNight && fs.existsSync(archivePath)) {
    const age = (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24);
    if (age < 30) {
      const html = fs.readFileSync(archivePath, 'utf8');
      // Validate cached archive matches show — Stuart King 2026-04-25.
      // Pre-validation gates left poisoned BWW archives in cache (142 detected
      // in initial audit). Quarantine instead of silently extracting.
      const v = validateRoundupPageTitle(html, show.title || showId);
      if (!v.ok) {
        console.log(`    ✗ BWW archive page-title mismatch (${v.reason}) — quarantining`);
        try { fs.renameSync(archivePath, archivePath + '.mismatch'); } catch (e) {}
      } else if (html.includes('Review Roundup') && html.includes('articleBody')) {
        const urlMatch = html.match(/Source:\s+(https?:\/\/[^\n]+)/);
        const url = urlMatch ? urlMatch[1].trim() : null;
        console.log(`    ✓ Using cached archive (${Math.round(age)} days old)`);
        return { url, html };
      }
    }
  } else if (isNearOpeningNight && fs.existsSync(archivePath)) {
    console.log('    Skipping BWW cache — show opens within 48h, fetching fresh');
  }

  // Priority 2.5: Scrape BWW homepage for Review Roundup links
  // On opening night, BWW features the roundup prominently on their homepage
  // but Google hasn't indexed it yet, so SERP returns the homepage instead.
  // This discovers the URL directly — faster and more reliable than SERP on day-of.
  if (isNearOpeningNight) {
    try {
      console.log('    Checking BWW homepage for Review Roundup link...');
      const homepageResult = await searchAggregator('BWW-Homepage', 'https://www.broadwayworld.com');
      if (homepageResult.found && homepageResult.html && isCloudflareChallenge(homepageResult.html)) {
        console.log('    ⚠️  BWW homepage is Cloudflare-gated — aborting (further fetches will burn credits for the same challenge)');
        return null;
      }
      if (homepageResult.found && homepageResult.html) {
        // bww-homepage-scan.findBWWRoundupLinkOnHomepage already runs the slug validator
        // internally via validateBWWRoundupUrlMatchesShow, so no need to re-check here.
        const roundupUrl = findBWWRoundupLinkOnHomepage(homepageResult.html, show.title, { logger: console });
        if (roundupUrl) {
          console.log(`    ✓ Found roundup link on BWW homepage: ${roundupUrl}`);
          const result = await searchAggregator('BWW', roundupUrl);
          if (result.found && result.html && isBWWRoundupContent(result.html)) {
            console.log(`    ✓ Confirmed BWW roundup content from homepage discovery`);
            return { url: roundupUrl, html: result.html };
          }
          if (result.found && result.html && isCloudflareChallenge(result.html)) {
            console.log('    ⚠️  BWW is Cloudflare-gated — aborting (further fetches will burn credits for the same challenge)');
            return null;
          }
        }
      }
    } catch (e) {
      console.log(`    BWW homepage check failed: ${e.message}`);
    }
  }

  // Priority 3: Google SERP search — BWW uses unpredictable URL formats
  // (e.g., "Updating-LIVE-2026" instead of "{SHOW}-Opens-on-Broadway-20260330")
  // SERP finds the actual URL regardless of BWW's slug choice. Run BEFORE URL guessing.
  try {
    const titleForSearch = show.title.replace(/'/g, '');
    const marketKeyword = isLondonMarket(show.category) ? 'west end' : (show.category === 'off-broadway') ? 'off-broadway' : 'broadway';
    const searchQuery = `site:broadwayworld.com/article "Review Roundup" "${titleForSearch}" ${marketKeyword} ${year}`;
    console.log(`    Searching Google for BWW roundup...`);
    const serpResults = await serpQuery(searchQuery, { nbResults: 5 });
    const serpCandidates = serpResults
      ? serpResults.map(r => r.url).filter(url => url && url.includes('broadwayworld.com/article/Review-Roundup'))
      : [];
    let bwwCloudflareGated = false;
    for (const searchResult of serpCandidates) {
      if (!validateBWWRoundupUrlMatchesShow(searchResult, show.title)) {
        console.log(`    ✗ SERP result doesn't match title "${show.title}" — skipping: ${searchResult.substring(0, 80)}`);
        continue;
      }
      console.log(`    ✓ Found via Google: ${searchResult}`);
      if (chromium) {
        const pwResult = await scrapeBWWRoundupWithPlaywright(searchResult);
        if (pwResult && pwResult.html) return { url: searchResult, html: pwResult.html };
        if (pwResult && pwResult.cloudflareChallenge) {
          bwwCloudflareGated = true;
          console.log('    ⚠️  BWW is Cloudflare-gated (Playwright) — stopping SERP iteration');
          break;
        }
      }
      const result = await searchAggregator('BWW', searchResult);
      if (result.found && result.html && isBWWRoundupContent(result.html)) return { url: searchResult, html: result.html };
      if (result.found && result.html && isCloudflareChallenge(result.html)) {
        bwwCloudflareGated = true;
        console.log('    ⚠️  BWW is Cloudflare-gated — stopping SERP iteration (further fetches will burn credits for the same challenge)');
        break;
      }
    }
    if (bwwCloudflareGated) return null;
  } catch (e) {
    console.log('    Google search unavailable.');
  }

  // Priority 4 (URL pattern guessing) REMOVED 2026-04-26 — Lost Boys readiness audit.
  // Was: 25+ Playwright fetches × 30s ≈ 12 min waste per cycle on every show whose
  // RR hasn't published yet. Never beat reviews.php (which updates within minutes of
  // publication) AND never caught the slugs we actually needed: Rocky Horror used
  // "Returns-to-Broadway" not "Opens-on-Broadway"; Fear of 13 had a "Starring..."
  // subtitle. The shows we found via guessing (Beaches, Joe Turner) were also found
  // via reviews.php — guessing was strictly redundant.
  // When reviews.php + homepage + SERP all return null, the RR is genuinely not
  // published yet. Fast-fail and let the next 15-min poll cycle pick it up.
  console.log('    ✗ BWW RR not found via reviews.php + homepage + SERP — likely not published yet, will retry next cycle');
  return null;
}

/**
 * Scrape BWW roundup page using Playwright to get JS-rendered content.
 * BWW loads review quotes dynamically on many roundup pages.
 */
async function scrapeBWWRoundupWithPlaywright(url) {
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // Use domcontentloaded instead of networkidle — BWW has constant ad/tracking
    // requests that prevent networkidle from ever resolving
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check we're on a real roundup page, not a 404 or homepage
    const title = await page.title();
    if (!title || !title.includes('Review Roundup')) {
      // Detect Cloudflare challenge page so the caller can short-circuit the loop
      // — further Playwright fetches to the same BWW domain during a gated window
      // will keep returning the same challenge page (observed 2026-04-24: 27+
      // consecutive Cloudflare hits in a single Hamlet discovery run).
      const isCf = /Just a moment/i.test(title) || /Enable JavaScript/i.test(title);
      console.log(`    BWW page title "${title || '(empty)'}" — not a roundup page${isCf ? ' (Cloudflare challenge)' : ''}`);
      await browser.close();
      return isCf ? { cloudflareChallenge: true } : null;
    }

    // Wait for article content to render (BWW loads review quotes dynamically)
    await page.waitForSelector('article, .article-body, [class*="article"], script[type="application/ld+json"]', { timeout: 10000 }).catch(() => null);
    await sleep(3000); // Extra wait for dynamic content to fully render

    const html = await page.content();

    await browser.close();

    // Verify we actually got review content (not just the page shell)
    if (html.includes('BlogPosting') || html.includes('articleBody') || html.includes('Photo Credit:')) {
      return { html };
    }

    // Also check for common BWW review patterns in HTML body
    if (html.includes('critics had to say') || html.includes('review-roundup')) {
      return { html };
    }

    return null;
  } catch (error) {
    console.log(`    BWW Playwright error: ${error.message}`);
    if (browser) await browser.close();
    return null;
  }
}

/**
 * Extract reviews from BWW Review Roundup HTML
 * Uses two methods: BlogPosting JSON-LD entries (newer articles) and articleBody parsing (older)
 */
// BWW emits JSON-LD with unescaped inner double quotes inside headline/articleBody
// strings (e.g. Show titles wrapped in quotes). A plain JSON.parse throws on these.
// This scanner walks char-by-char tracking string state; when inside a string it
// escapes any `"` whose next non-whitespace char is NOT a JSON structural token.
function sanitizeBwwJsonLd(s) {
  const out = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      out.push(c);
      if (c === '"') inString = true;
      continue;
    }
    if (escaped) { out.push(c); escaped = false; continue; }
    if (c === '\\') { out.push(c); escaped = true; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = s[j];
      if (next === ',' || next === '}' || next === ']' || next === ':') {
        out.push(c);
        inString = false;
      } else {
        out.push('\\"');
      }
      continue;
    }
    out.push(c);
  }
  return out.join('');
}

function extractBWWRoundupReviews(html, showId, bwwUrl, showTitle) {
  let reviews = [];
  const method1Seen = new Set();
  // Track how many criticName=null entries we've kept per outlet. Multi-critic
  // outlets (NYSR, NYT, TimeOut, Variety) routinely get 2-3 BlogPostings for
  // the same show, but BWW's JSON-LD often only has the outlet in the headline
  // ("New York Stage Review - Show Title") with no author name. Without this
  // counter, the simple outletId|unknown dedup collapsed all of them to one
  // entry and silently dropped 2nd/3rd critics — Method 2's text parsing
  // could only recover partially. See "a-wonderful-world" (3 NYSR headlines,
  // only 2 review files) as the canonical repro.
  const method1UnknownCountByOutlet = new Map();

  // Method 1: Extract from JSON-LD entries (newer BWW articles)
  // Newer articles use LiveBlogPosting with liveBlogUpdate[] containing BlogPosting entries
  // Older articles use standalone BlogPosting entries
  const scriptMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const scriptMatch of scriptMatches) {
    try {
      const cleanedJson = scriptMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
      let json;
      try {
        json = JSON.parse(cleanedJson);
      } catch (firstErr) {
        // BWW headlines often contain unescaped inner quotes like:
        //   "headline":"Cote Notices - "Fallen Angels" on Broadway..."
        // which breaks JSON.parse. Sanitize by scanning string state and escaping
        // inner quotes that aren't followed by a JSON structural token.
        json = JSON.parse(sanitizeBwwJsonLd(cleanedJson));
      }

      // Collect BlogPosting entries from either format
      const postings = [];
      if (json['@type'] === 'BlogPosting') {
        postings.push(json);
      } else if (json['@type'] === 'LiveBlogPosting' && Array.isArray(json.liveBlogUpdate)) {
        for (const entry of json.liveBlogUpdate) {
          if (entry['@type'] === 'BlogPosting') postings.push(entry);
        }
      }

      for (const posting of postings) {
        // Two formats:
        // 1. Standalone BlogPosting: author.name = "Outlet - Critic"
        // 2. LiveBlogPosting entries: headline = "Outlet - Review Title"
        let outletRaw = null;
        let criticName = null;

        if (posting.author) {
          const authorName = Array.isArray(posting.author) ? posting.author[0]?.name : posting.author?.name;
          if (authorName && authorName.includes(' - ')) {
            const parts = authorName.split(' - ');
            outletRaw = parts[0].trim();
            criticName = parts[1]?.trim() || null;
          } else if (authorName && authorName.includes(', ')) {
            // BWW comma format: "Critic, Outlet" (e.g., "Mandell, New York Theater")
            const commaIdx = authorName.indexOf(', ');
            const part0 = authorName.substring(0, commaIdx).trim();
            const part1 = authorName.substring(commaIdx + 2).trim();
            // Check which part is a known outlet
            if (isRegisteredOutlet(part1)) {
              outletRaw = part1;
              criticName = part0;
            } else if (isRegisteredOutlet(part0)) {
              outletRaw = part0;
              criticName = part1;
            } else {
              // Neither is a known outlet — treat whole string as outlet (existing behavior)
              outletRaw = authorName;
            }
          } else if (authorName && authorName.includes(': ')) {
            // BWW colon format: "Outlet: Critic" (e.g., "NY Post: Johnny Oleksinski")
            // Use lastIndexOf to handle multiple colons (e.g., "Re: Review: NY Post")
            const colonIdx = authorName.lastIndexOf(': ');
            const part0 = authorName.substring(0, colonIdx).trim();
            const part1 = authorName.substring(colonIdx + 2).trim();
            if (isRegisteredOutlet(part0)) {
              outletRaw = part0;
              criticName = part1;
            } else if (isRegisteredOutlet(part1)) {
              outletRaw = part1;
              criticName = part0;
            } else {
              outletRaw = authorName;
            }
          } else if (authorName) {
            outletRaw = authorName;
          }
        } else if (posting.headline && posting.headline.includes(' - ')) {
          // LiveBlogPosting entries: "Outlet - Review Title"
          outletRaw = posting.headline.split(' - ')[0].trim();
          // Validate: real outlet names are 1-5 words. 6+ words = headline fragment, not outlet
          if (outletRaw.split(/\s+/).length > 5) {
            outletRaw = null;
          }
        }

        if (!outletRaw) continue;

        const outletId = normalizeOutlet(outletRaw);
        const outletName = getOutletDisplayName(outletId);
        const quote = posting.articleBody || posting.description || '';

        // Fix mis-attributions BWW occasionally introduces when parsing their
        // "Critic, Outlet" strings — e.g. "David Finkle, Cote Notices" for a
        // Cote Notices piece that David Cote actually wrote (Rocky Horror
        // 2026-04-23). Defense-in-depth for Session 3 #12 URL-dedup.
        if (criticName) {
          const canon = canonicalizeCritic(outletId, criticName);
          if (canon.canonicalized) {
            console.log(`    [BWW RR] canonicalized critic: ${canon.from} → ${canon.name} (outletId=${outletId})`);
            criticName = canon.name;
          }
        }

        // Dedup within Method 1: BWW sometimes has duplicate BlogPosting entries
        // with real critic names — those we legitimately dedup. But for
        // criticName=null (outlet-only headlines), we keep every occurrence as
        // its own slot via a per-outlet counter, so multi-critic outlets don't
        // collapse to a single entry. Method 2's text parsing will upgrade
        // each slot as it finds names in articleBody.
        let dedupKey;
        if (criticName) {
          dedupKey = `${outletId}|${normalizeCritic(criticName)}`;
          if (method1Seen.has(dedupKey)) continue;
        } else {
          const idx = (method1UnknownCountByOutlet.get(outletId) || 0) + 1;
          method1UnknownCountByOutlet.set(outletId, idx);
          dedupKey = `${outletId}|__unknown-${idx}`;
        }
        method1Seen.add(dedupKey);

        reviews.push({
          showId,
          outletId,
          outlet: outletName,
          criticName,
          url: null,
          bwwExcerpt: quote.substring(0, 300) + (quote.length > 300 ? '...' : ''),
          bwwRoundupUrl: bwwUrl,
          source: 'bww-roundup',
        });
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }

  if (reviews.length > 0) {
    // Extract thumb data from HTML img tags and pair with reviews by position
    // New format: uptrans(N)?.png / middletrans(N)?.png / downtrans(N)?.png (optional numeric suffix, e.g. uptrans2.png)
    // Legacy format: BigThumbs_UP.gif / BigThumbs_MEH.gif / BigThumbs_DOWN.gif
    // Fallen Angels 2026-04-19: roundup used uptrans2.png/middletrans2.png — suffixed variant broke the pre-2 regex.
    const thumbPattern = /(?:(?:uptrans|middletrans|downtrans)\d*\.png|BigThumbs_(?:UP|MEH|DOWN)\.(?:gif|png))/gi;
    const thumbMatches = [];
    let thumbMatch;
    while ((thumbMatch = thumbPattern.exec(html)) !== null) {
      const img = thumbMatch[0];
      if (/uptrans|BigThumbs_UP/i.test(img)) thumbMatches.push('Up');
      else if (/middletrans|BigThumbs_MEH/i.test(img)) thumbMatches.push('Meh');
      else if (/downtrans|BigThumbs_DOWN/i.test(img)) thumbMatches.push('Down');
    }
    if (thumbMatches.length > 0) {
      // Pair thumbs with reviews — they appear in the same order
      const thumbCount = Math.min(thumbMatches.length, reviews.length);
      for (let i = 0; i < thumbCount; i++) {
        reviews[i].bwwThumb = thumbMatches[i];
      }
      console.log(`    Paired ${thumbCount} BWW thumbs (${thumbMatches.filter(t=>t==='Up').length} Up, ${thumbMatches.filter(t=>t==='Meh').length} Meh, ${thumbMatches.filter(t=>t==='Down').length} Down)`);
    }

    // Extract source URLs from HTML anchor tags
    // Pattern: <p>Critic, <a href="SOURCE_URL">Outlet:</a> excerpt</p>
    // Multi-critic outlets (NYSR, NYT, TimeOut): a single outletId appears
    // multiple times in anchor order. Use a per-outlet queue so each review
    // slot gets a DIFFERENT URL. Previous first-URL-wins behavior (fixed
    // 2026-04-19) caused all NYSR reviews for Fallen Angels to share the
    // first NYSR URL found in the roundup.
    const urlsByOutlet = {};
    const anchorRe = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let aMatch;
    while ((aMatch = anchorRe.exec(html)) !== null) {
      const href = aMatch[1];
      const text = aMatch[2].replace(/:$/, '').trim();
      if (href.includes('broadwayworld.com') || text.length < 3 || text.length > 60) continue;
      const oid = normalizeOutlet(text);
      if (!oid) continue;
      if (!urlsByOutlet[oid]) urlsByOutlet[oid] = [];
      if (!urlsByOutlet[oid].includes(href)) urlsByOutlet[oid].push(href);
    }
    const urlIdxByOutlet = {};
    let urlsPopulated = 0;
    let urlsRejected = 0;
    for (const review of reviews) {
      if (!review.url && review.outletId) {
        const queue = urlsByOutlet[review.outletId];
        if (!queue || queue.length === 0) continue;
        const idx = urlIdxByOutlet[review.outletId] || 0;
        if (idx >= queue.length) continue;
        urlIdxByOutlet[review.outletId] = idx + 1;
        const candidateUrl = queue[idx];
        // BWW Review Roundup is manually curated by BWW editors — trust the
        // outlet→URL mapping. The cross-show URL slug guard at line 2357
        // (detectCrossShowUrlMismatch in createReviewFile) catches genuine
        // misattributions downstream. Without trusting BWW curation, we lost
        // legitimate creative-titled URLs on opening night (Theater Pizzazz
        // Ron Fassler "hes-back-but-has-willy-loman-ever-left-us" had no
        // "death-of-a-salesman" in the slug). DoaS Apr 9-10 #6.
        if (showTitle && !urlOrTitleLooksLikeReview(candidateUrl, showTitle, null, { trustedSource: true })) {
          urlsRejected++;
          console.log(`    ✗ Rejected URL for ${review.outletId}: non-article URL — ${candidateUrl.substring(0, 80)}`);
          continue;
        }
        // Guard: reject URLs that contain a DIFFERENT show's slug. BWW roundup
        // HTML sometimes has links to multiple shows (e.g., same critic reviewed
        // both Becky Shaw and Monte Cristo — roundup page has both URLs, wrong
        // one gets assigned). detectCrossShowUrlMismatch already runs downstream
        // at createReviewFile, but catching it here prevents creating the file
        // at all and avoids wasting text-collection resources.
        const crossShowMatch = detectCrossShowUrlMismatch(showId, candidateUrl);
        if (crossShowMatch) {
          urlsRejected++;
          console.log(`    ✗ Rejected URL for ${review.outletId}: URL matches "${crossShowMatch.matchedTitle}" not "${crossShowMatch.showTitle}" — ${candidateUrl.substring(0, 80)}`);
          logExclusion({ script: 'gather-reviews', showId, file: '-', reason: 'skippedCrossShowUrl', details: { url: candidateUrl, outletId: review.outletId, matchedTitle: crossShowMatch.matchedTitle } });
          continue;
        }
        review.url = candidateUrl;
        urlsPopulated++;
      }
    }
    if (urlsPopulated > 0) {
      console.log(`    Populated ${urlsPopulated} source URLs from BWW roundup HTML${urlsRejected > 0 ? ` (${urlsRejected} rejected as non-article)` : ''}`);
    }

    console.log(`    Extracted ${reviews.length} reviews from BWW roundup (BlogPosting)`);
    // Fall through to supplementary text scan — don't return early.
    // JSON-LD may omit entries that lack hyperlinks (Guardian, NYTG, etc.).
  }

  // Method 2 / Supplement: articleBody text parsing
  // Runs as primary extraction for older articles (no BlogPosting JSON-LD),
  // or as supplementary scan after Method 1 to catch entries not in structured data.
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonLdMatch) {
    try {
      const cleanedJson = jsonLdMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
      const jsonLd = JSON.parse(cleanedJson);
      const articleBody = jsonLd.articleBody || '';
      const publishDate = jsonLd.datePublished || null;

      if (articleBody) {
        // Build dedup set from Method 1 results so we don't add duplicates
        const existingKeys = new Set(reviews.map(r =>
          `${(r.outletId || normalizeOutlet(r.outlet)).toLowerCase()}|${normalizeCritic(r.criticName)}`
        ));
        // Also track outlet-only keys for Method 1 entries with Unknown critic.
        // Method 1 (JSON-LD) often has Unknown critic; Method 2 (text) parses the real name.
        // Without this, NYSR|unknown and NYSR|frank-scheck both pass → duplicate in reviews.json.
        //
        // Map<outletId, count>: counts unknown entries per outlet so Method 2 can
        // upgrade multiple unknowns per outlet (one per Method 2 match). A Set
        // would drop the count after the first upgrade, losing 2nd/3rd critics
        // on multi-critic outlets (NYSR, TimeOut, etc).
        const existingOutletOnly = new Map();
        for (const r of reviews) {
          if (normalizeCritic(r.criticName) !== 'unknown') continue;
          const oid = (r.outletId || normalizeOutlet(r.outlet)).toLowerCase();
          existingOutletOnly.set(oid, (existingOutletOnly.get(oid) || 0) + 1);
        }

        // Pattern parsing extracted to scripts/lib/bww-roundup-parser.js so the
        // first-name initial fix ("J. Kelly Nestruck") can be unit-tested.
        const parsedPairs = parseArticleBodyReviews(articleBody);

        let supplementAdded = 0;
        for (const pair of parsedPairs) {
          let criticName = pair.criticName;
          const outletRaw = pair.outletRaw;
          let quote = pair.quote;

          if (quote.length > 500) {
            quote = quote.substring(0, 500);
            const lastPeriod = quote.lastIndexOf('.');
            if (lastPeriod > 200) quote = quote.substring(0, lastPeriod + 1);
            quote += '...';
          }

          const outletId = normalizeOutlet(outletRaw);
          const outletName = getOutletDisplayName(outletId);

          // Defense-in-depth mirror of Method 1 canonicalization — BWW's
          // articleBody occasionally carries the same mis-attribution the
          // JSON-LD author field does.
          const canon = canonicalizeCritic(outletId, criticName);
          if (canon.canonicalized) {
            console.log(`    [BWW RR M2] canonicalized critic: ${canon.from} → ${canon.name} (outletId=${outletId})`);
            criticName = canon.name;
          }

          // Dedup against Method 1 results
          const dedupKey = `${outletId.toLowerCase()}|${normalizeCritic(criticName)}`;
          if (existingKeys.has(dedupKey)) continue;

          // If Method 1 found this outlet with one or more Unknown critic slots,
          // upgrade the next available slot to this real name. Decrement the
          // per-outlet count each time so multi-critic outlets get all their
          // critics upgraded (not just the first).
          const oidLower = outletId.toLowerCase();
          const remainingUnknowns = existingOutletOnly.get(oidLower) || 0;
          if (remainingUnknowns > 0) {
            const existing = reviews.find(r =>
              (r.outletId || normalizeOutlet(r.outlet)).toLowerCase() === oidLower
              && normalizeCritic(r.criticName) === 'unknown'
            );
            if (existing) {
              existing.criticName = criticName;
              if (quote && (!existing.bwwExcerpt || existing.bwwExcerpt.length < quote.length)) {
                existing.bwwExcerpt = quote.substring(0, 300) + (quote.length > 300 ? '...' : '');
              }
              existingKeys.add(dedupKey);
              if (remainingUnknowns - 1 <= 0) existingOutletOnly.delete(oidLower);
              else existingOutletOnly.set(oidLower, remainingUnknowns - 1);
              continue;
            }
          }

          existingKeys.add(dedupKey);

          supplementAdded++;
          reviews.push({
            showId,
            outletId,
            outlet: outletName,
            criticName,
            url: null,
            publishDate: normalizePublishDate(publishDate) || null,
            bwwExcerpt: quote.substring(0, 300) + (quote.length > 300 ? '...' : ''),
            bwwRoundupUrl: bwwUrl,
            source: 'bww-roundup',
          });
        }

        if (supplementAdded > 0) {
          console.log(`    Supplementary text scan found ${supplementAdded} additional reviews not in JSON-LD`);
        }
      }
    } catch (e) {
      // Skip JSON parse errors
    }
  }

  if (reviews.length > 0) {
    // Extract source URLs from HTML anchor tags
    // Pattern: <p>Critic, <a href="SOURCE_URL">Outlet:</a> excerpt</p>
    // Same per-outlet queue as Method 1 post-pass — see comment above.
    const urlsByOutlet2 = {};
    const anchorRe2 = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let aMatch2;
    while ((aMatch2 = anchorRe2.exec(html)) !== null) {
      const href = aMatch2[1];
      const text = aMatch2[2].replace(/:$/, '').trim();
      if (href.includes('broadwayworld.com') || text.length < 3 || text.length > 60) continue;
      const oid = normalizeOutlet(text);
      if (!oid) continue;
      if (!urlsByOutlet2[oid]) urlsByOutlet2[oid] = [];
      if (!urlsByOutlet2[oid].includes(href)) urlsByOutlet2[oid].push(href);
    }
    const urlIdxByOutlet2 = {};
    let urlsPopulated2 = 0;
    let urlsRejected2 = 0;
    for (const review of reviews) {
      if (!review.url && review.outletId) {
        const queue = urlsByOutlet2[review.outletId];
        if (!queue || queue.length === 0) continue;
        const idx = urlIdxByOutlet2[review.outletId] || 0;
        if (idx >= queue.length) continue;
        urlIdxByOutlet2[review.outletId] = idx + 1;
        const candidateUrl = queue[idx];
        // Same trustedSource bypass as Method 1 — BWW Roundup curation is trusted,
        // detectCrossShowUrlMismatch (line 2357) catches misattributions downstream.
        if (showTitle && !urlOrTitleLooksLikeReview(candidateUrl, showTitle, null, { trustedSource: true })) {
          urlsRejected2++;
          console.log(`    ✗ Rejected URL for ${review.outletId}: non-article URL — ${candidateUrl.substring(0, 80)}`);
          continue;
        }
        // Same cross-show guard as Method 1 — catch wrong-show URLs before file creation
        const crossShowMatch2 = detectCrossShowUrlMismatch(showId, candidateUrl);
        if (crossShowMatch2) {
          urlsRejected2++;
          console.log(`    ✗ Rejected URL for ${review.outletId}: URL matches "${crossShowMatch2.matchedTitle}" not "${crossShowMatch2.showTitle}" — ${candidateUrl.substring(0, 80)}`);
          logExclusion({ script: 'gather-reviews', showId, file: '-', reason: 'skippedCrossShowUrl', details: { url: candidateUrl, outletId: review.outletId, matchedTitle: crossShowMatch2.matchedTitle, method: 2 } });
          continue;
        }
        review.url = candidateUrl;
        urlsPopulated2++;
      }
    }
    if (urlsPopulated2 > 0) {
      console.log(`    Populated ${urlsPopulated2} source URLs from BWW roundup HTML${urlsRejected2 > 0 ? ` (${urlsRejected2} rejected as non-article)` : ''}`);
    }
    // Count-drift detection: anchor tag count is the "ground truth" for the
    // number of reviewed outlets on the page (one <a href> per review entry,
    // plus a small number of unrelated links). If the reviews array is
    // materially smaller, we silently dropped entries — often because BWW
    // added new reviews to the DOM but didn't re-emit the JSON-LD, or a
    // format change prevented our parsers from matching. Warn loudly so the
    // post-opening audit can flag the show for human review.
    const anchorReviewCount = Object.values(urlsByOutlet2).reduce((a, q) => a + q.length, 0);
    if (anchorReviewCount > reviews.length + 2) {
      const delta = anchorReviewCount - reviews.length;
      console.log(`    ⚠️  BWW roundup count drift: ${anchorReviewCount} outlet URLs in HTML but only ${reviews.length} reviews extracted (delta=${delta})`);
      // Emit to exclusion-logger so the opening-night count-drift plugin can surface it.
      try {
        logExclusion({
          script: 'gather-reviews',
          showId,
          file: '-',
          reason: 'countDrift',
          details: { aggregator: 'bww-rr', anchorUrls: anchorReviewCount, extracted: reviews.length, delta, url: bwwUrl },
        });
      } catch { /* non-fatal */ }
    }
    // Hard min-count floor: once a BWW RR loads with real content, it virtually
    // always has ≥5 reviews. If we extract fewer, something is wrong (format
    // change, broken JSON-LD, HTML truncation). Fail loudly with the HTML size
    // so the orchestrator can re-fetch or flag for human review.
    if (reviews.length < 5 && html && html.length > 20000) {
      console.log(`    ❌ BWW roundup min-count assert: only ${reviews.length} reviews from ${html.length}-byte page — likely broken extraction`);
    }
    console.log(`    Extracted ${reviews.length} reviews from BWW roundup`);
  } else if (html && html.length > 5000) {
    console.log(`    ⚠️  BWW roundup page loaded but 0 reviews extracted from both JSON-LD and articleBody`);
  }

  // Method 3: outlet-by-domain supplement (Balusters postmortem CLASS 2, 2026-04-21).
  // Delegated to scripts/lib/outlet-domain-supplement.js. Walks every outbound href,
  // maps domain→outletId, adds stubs for outlets Method 1+2 missed.
  try {
    const { supplementOutletsFromAnchors } = require('./lib/outlet-domain-supplement');
    const { added, newReviews } = supplementOutletsFromAnchors({
      html,
      reviews,
      showId,
      showTitle,
      sourceName: 'bww-roundup-domain-supplement',
      excludeDomains: ['broadwayworld.com'],
      urlTitleCheck: (u, t) => urlOrTitleLooksLikeReview(u, t, null, { trustedSource: true }),
      crossShowCheck: detectCrossShowUrlMismatch,
      makeStub: (oid, url) => ({
        showId,
        outletId: oid,
        outlet: getOutletDisplayName(oid) || oid,
        criticName: 'Unknown',
        url,
        source: 'bww-roundup-domain-supplement',
      }),
    });
    reviews.push(...newReviews);
    if (added > 0) {
      console.log(`    [Method 3] domain supplement added ${added} outlet(s) missed by JSON-LD + articleBody`);
    }
  } catch (e) {
    console.log(`    [Method 3] domain supplement error (non-fatal): ${(e.message || '').substring(0, 100)}`);
  }

  return reviews;
}

/**
 * Validate BWW roundup reviews for geographic accuracy.
 * Filters out non-NYC outlets (UK, regional) and rejects entire roundup
 * if a majority of reviews are from the wrong production/city.
 *
 * Two failure modes this catches:
 * 1. Wrong city: BWW served a London/Chicago/regional roundup for a same-named show
 * 2. Wrong year: BWW served an older production's roundup (different cast/director)
 */
function validateBWWRoundupGeography(reviews, html, showId, isWestEnd = false) {
  if (reviews.length === 0) return reviews;

  // Load outlet registry for geographic data
  let outletRegistry = {};
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8'));
    outletRegistry = reg.outlets || {};
  } catch (e) { /* proceed without registry */ }

  // Build set of "non-local" outlet IDs based on market.
  // For Broadway: non-local = non-NYC outlets (London, regional, etc.)
  // For West End: non-local = non-London outlets (NYC, regional US, etc.)
  const NON_LOCAL_OUTLET_IDS = new Set();
  for (const [id, info] of Object.entries(outletRegistry)) {
    if (!info.region) continue;
    const isLocal = isWestEnd
      ? (info.region === 'london' || info.region === 'national-uk' || info.region === 'national')
      : (info.region === 'nyc' || info.region === 'national');
    if (!isLocal) {
      NON_LOCAL_OUTLET_IDS.add(id);
      if (info.aliases) {
        for (const alias of info.aliases) NON_LOCAL_OUTLET_IDS.add(alias.toLowerCase());
      }
    }
  }

  function isNonLocalOutlet(outletId) {
    if (NON_LOCAL_OUTLET_IDS.has(outletId)) return true;
    if (isWestEnd) {
      // For WE: flag outlets that are clearly US-only
      // But don't flag unknown outlets — they might be London indie outlets not in registry
      const entry = outletRegistry[outletId];
      if (!entry) return false;
      if (entry.region && entry.region !== 'london' && entry.region !== 'national-uk' && entry.region !== 'national') return true;
      return false;
    } else {
      // For Broadway: flag outlets with .co.uk domains, "-uk" suffix, "london" in name
      if (outletId.endsWith('-uk') || outletId.includes('london')) return true;
      const entry = outletRegistry[outletId];
      if (!entry) return false;
      if (entry.region && entry.region !== 'nyc' && entry.region !== 'national') return true;
      if (entry.domain && entry.domain.endsWith('.co.uk')) return true;
      return false;
    }
  }

  // Check each review's outlet
  let nonLocalCount = 0;
  const flagged = [];
  for (const rev of reviews) {
    if (isNonLocalOutlet(rev.outletId)) {
      nonLocalCount++;
      flagged.push(rev.outletId);
    }
  }

  // Also check HTML body for strong wrong-production signals
  const htmlLower = (html || '').toLowerCase();
  const wrongProductionSignals = [];
  if (isWestEnd) {
    // For WE shows: flag if it mentions "broadway" prominently without "west end"/"london"
    if (/\bbroadway\b/.test(htmlLower) && !/\bwest end\b/.test(htmlLower) && !/\blondon\b/.test(htmlLower)) {
      wrongProductionSignals.push('Broadway (no West End/London mention)');
    }
  } else {
    // For Broadway shows: flag if it mentions "west end" without "broadway"
    if (/\bwest end\b/.test(htmlLower) && !/\bbroadway\b/.test(htmlLower)) wrongProductionSignals.push('West End (no Broadway mention)');
    if (/\blondon production\b/.test(htmlLower)) wrongProductionSignals.push('London production');
  }
  // Forward-tense carve-out: "a national tour is planned" is a Broadway review
  // mentioning an upcoming tour, not a tour review. Postmortem #18 (2026-04).
  if (/\bnational tour\b/i.test(htmlLower) && !hasOnlyForwardTenseTourMention(htmlLower)) {
    wrongProductionSignals.push('National tour');
  }

  const marketLabel = isWestEnd ? 'non-London' : 'non-NYC';
  const nonLocalRatio = nonLocalCount / reviews.length;

  // If half or more are non-local, reject the ENTIRE roundup (wrong production)
  if (nonLocalRatio >= 0.5) {
    console.log(`    ⚠ REJECTING entire BWW roundup: ${nonLocalCount}/${reviews.length} reviews from ${marketLabel} outlets (${flagged.join(', ')})`);
    if (wrongProductionSignals.length > 0) {
      console.log(`    ⚠ HTML signals: ${wrongProductionSignals.join(', ')}`);
    }
    return [];
  }

  // If a few non-local outlets mixed in, filter them out individually
  if (nonLocalCount > 0) {
    const filtered = reviews.filter(rev => !isNonLocalOutlet(rev.outletId));
    console.log(`    ⚠ Filtered ${nonLocalCount} ${marketLabel} outlets from BWW roundup: ${flagged.join(', ')}`);
    return filtered;
  }

  return reviews;
}

/**
 * Validate BWW roundup publish year against show's opening date.
 * Catches wrong-year roundups where BWW's fuzzy routing serves an older production's
 * roundup (e.g., The Other Place 2013 roundup served for a 2026 show).
 *
 * Extracts datePublished from JSON-LD or URL year and rejects if too old.
 * @returns {Array} reviews (empty if roundup is wrong year, unchanged otherwise)
 */
function validateBWWRoundupYear(reviews, html, showOpeningDate, showId, bwwUrl) {
  if (reviews.length === 0) return reviews;

  const showDate = new Date(showOpeningDate);
  if (isNaN(showDate.getTime())) return reviews; // can't validate without valid date

  // 1. Extract datePublished from JSON-LD (most reliable)
  let roundupDate = null;
  const scriptMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const m of scriptMatches) {
    try {
      const json = JSON.parse(m[1].replace(/[\x00-\x1F\x7F]/g, ' '));
      if (json.datePublished) {
        roundupDate = new Date(json.datePublished);
        break;
      }
      if (json.dateCreated && !roundupDate) {
        roundupDate = new Date(json.dateCreated);
      }
    } catch (e) { /* skip invalid JSON */ }
  }

  // 2. Fallback: extract year from URL (e.g., "Review-Roundup-SHOW-Opens-on-Broadway-20241224")
  if (!roundupDate) {
    const url = bwwUrl || '';
    const years = [...url.matchAll(/(\d{4})/g)].map(m => parseInt(m[1])).filter(y => y >= 2000 && y <= 2030);
    if (years.length > 0) {
      // Use the last year in the URL (usually the date suffix)
      roundupDate = new Date(years[years.length - 1], 0, 1);
    }
  }

  if (!roundupDate || isNaN(roundupDate.getTime())) {
    console.log(`    ℹ No date metadata found in BWW roundup — skipping year validation`);
    return reviews;
  }

  // Reject if roundup was published more than 18 months before the show's opening
  // (generous window to allow pre-opening reviews from the same production)
  const monthsDiff = (showDate.getFullYear() - roundupDate.getFullYear()) * 12 +
                     (showDate.getMonth() - roundupDate.getMonth());

  if (monthsDiff > 18) {
    console.log(`    ⚠ REJECTING BWW roundup: published ${roundupDate.toISOString().slice(0, 10)} but show opens ${showOpeningDate} (${monthsDiff} months gap)`);
    console.log(`    ⚠ This is likely a roundup for an older production of the same title`);
    return [];
  }

  // Also reject if roundup was published more than 6 months AFTER opening
  // (unlikely to be a legitimate roundup — might be a revival or re-run)
  if (monthsDiff < -6) {
    console.log(`    ⚠ REJECTING BWW roundup: published ${roundupDate.toISOString().slice(0, 10)} but show opened ${showOpeningDate} (roundup is ${-monthsDiff} months after opening)`);
    return [];
  }

  return reviews;
}

/**
 * Archive aggregator page for future reference
 */
function archiveAggregatorPage(aggregator, showId, url, html) {
  const archiveDir = path.join(__dirname, '..', 'data', 'aggregator-archive', aggregator);
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const archivePath = path.join(archiveDir, `${showId}.html`);

  // Refresh archives older than 14 days to capture newly added reviews
  if (fs.existsSync(archivePath)) {
    const age = (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24);
    if (age < 14) return;
  }

  const header = `<!--
  Archived: ${new Date().toISOString()}
  Source: ${url}
  Status: 200
-->\n`;

  fs.writeFileSync(archivePath, header + html);
  console.log(`    Archived to ${aggregator}/${showId}.html`);
}

/**
 * Create a review-text file
 * Uses centralized normalization to prevent duplicate files with different naming
 */
function createReviewFile(showId, reviewData, options = {}) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  // Per-show blocklist — honor _blocklist.json so URLs the operator has
  // deliberately deleted can't be silently rediscovered. Rocky Horror
  // 2026-04-23: cote-notices--david-finkle.json was deleted as a duplicate
  // and the poller recreated it 2h later from the same URL with a
  // ?triedRedirect tracking param. See scripts/lib/poller-blocklist.js.
  if (reviewData.url) {
    const blocklist = loadBlocklist(showDir);
    const blocked = findBlockedEntry(blocklist, reviewData.url);
    if (blocked) {
      console.log(`    ✗ Skipping ${reviewData.url}: blocklisted (${blocked.reason})`);
      return 'blocklisted';
    }
  }

  // Use centralized normalization for consistent file naming
  // Prefer outletId (canonical ID like "nytimes") over outlet (display name like "NYT Theater")
  // to avoid misattribution — normalizeOutlet("NYT Theater") → "nyt-theater" (wrong outlet)
  const outletForNormalization = reviewData.outletId || reviewData.outlet;
  const normalizedOutletId = normalizeOutlet(outletForNormalization);

  // Session 3 #14 — promote Unknown critic to the outlet's defaultCritic at gather time.
  // Without this, single-author outlets (Cote Notices / Substack criticsfeeds, newyorktheater.me,
  // etc.) whose RSS items carry no <author> tag arrive with criticName='Unknown' and get routed to
  // _pending/ by shouldRouteUnknownCriticToPending → rebuild-all-reviews never reads _pending/
  // so the hit silently strands. rebuild-all-reviews.js:2745 has the same resolution as a
  // belt-and-suspenders backstop, but only for files that reach the main show dir.
  // See feedback_rss_discovery_pending_strand.md.
  {
    const inCritic = (reviewData.criticName || '').trim().toLowerCase();
    if (!inCritic || inCritic === 'unknown' || inCritic === 'unnamed') {
      try {
        const reg = _outletRegistryCache || (() => {
          const r = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
          _outletRegistryCache = r.outlets || {};
          return _outletRegistryCache;
        })();
        const entry = reg[normalizedOutletId];
        if (shouldFillDefaultCritic(entry)) {
          console.log(`    → promoted Unknown → ${entry.defaultCritic} via outlet-registry defaultCritic (${normalizedOutletId})`);
          reviewData.criticName = entry.defaultCritic;
        }
      } catch (e) {
        // Registry load failure — don't silently strand every Unknown in _pending/.
        // Log loud so ops can see it. Fall through to existing unknown handling.
        console.warn(`    ⚠ outlet-registry load failed in defaultCritic promotion: ${e.message}`);
      }
    }
  }

  const normalizedCriticName = normalizeCritic(reviewData.criticName);
  const filename = generateReviewFilename(outletForNormalization, reviewData.criticName);
  const filepath = path.join(showDir, filename);
  const reviewKey = generateReviewKey(outletForNormalization, reviewData.criticName);

  // JUNK OUTLET GUARD: Reject scraping artifacts (ad images, etc.)
  if (isJunkOutlet(normalizedOutletId)) {
    console.log(`    ✗ Skipping ${filename}: junk outlet "${reviewData.outlet || reviewData.outletId}"`);
    return 'junkOutlet';
  }

  // SENTENCE-FRAGMENT GUARD: Reject outlet IDs that are clearly text excerpts
  if (isSuspiciousOutletId(normalizedOutletId)) {
    console.log(`    ✗ Skipping suspicious outlet ID: "${normalizedOutletId}" (likely sentence fragment)`);
    return 'suspiciousOutlet';
  }

  // NON-BROADWAY GUARD: Reject tours, off-Broadway, film/TV, streaming, West End
  // For off-broadway shows, allow off-broadway content through
  const outletText = reviewData.outlet || reviewData.outletId || '';
  const allowOffBroadway = options.allowOffBroadway || false;
  const allowWestEnd = options.allowWestEnd || false;
  const allowOpera = options.allowOpera || false;
  const fromPostOpening = options.fromPostOpening || false;
  // mergeOpts is finalized after _showMeta is loaded (see below); initialized as empty
  let mergeOpts = fromPostOpening ? { fromPostOpening: true } : {};
  if (isNotBroadway(outletText, { allowOffBroadway, allowWestEnd, allowOpera })) {
    console.log(`    ✗ Skipping ${filename}: non-Broadway outlet "${outletText}"`);
    return 'nonBroadway';
  }

  // STALE-FLAG COLLISION GUARD: catches the Beaches 2026-04-22 class of bug
  // at the poller's entry point too (ingest-manual-review got it in Session 2,
  // 83ce81afa2). When an existing outlet+critic file has wrongProduction=true
  // and a different URL — or a publishDate gap > 365 days — creating a fresh
  // file alongside it produces a silent side-by-side duplicate. findExistingReviewFile()
  // already skips wrongProduction files as merge targets (review-normalization.js:1126)
  // which is why this was invisible until now. Log it, write to the audit file,
  // and don't create the new file. Doesn't abort the batch.
  if (reviewData.url) {
    const staleCollision = detectIngestCollision({
      showDir,
      outletId: normalizedOutletId,
      criticName: reviewData.criticName,
      url: reviewData.url,
      publishDate: reviewData.publishDate,
    });
    if (!staleCollision.ok) {
      console.log(`    ✗ Skipping ${filename}: stale-flag collision with ${staleCollision.file} (${staleCollision.reason})`);
      _recordGatherCollision({ showId, newFile: filename, ...staleCollision });
      return 'staleFlagCollision';
    }
  }

  // NON-REVIEW URL PATH GUARD: Reject URLs with paths that indicate non-review content.
  // Applies to all sources (SERP, site-search, aggregators) since aggregators never return
  // these path patterns. Catches feature articles, interviews, preview articles, cast news
  // that SERP returns alongside real reviews (Cats postmortem #12: Playbill feature scored).
  if (reviewData.url) {
    const NON_REVIEW_PATHS = [
      /\/(?:video|videos|gallery|galleries|slideshow|photo-gallery)\//i,
      /\/(?:podcast|podcasts|episode)\//i,
      /\/(?:obituary|obituaries|in-memoriam)\//i,
      /\/(?:behind-the-scenes|backstage)\//i,
      /\/(?:preview|previews)\//i,
      /\/(?:interview|interviews)\//i,
      /\/(?:casting|cast-announcement|cast-announced|casting-announced)\//i,
    ];
    try {
      const urlPath = new URL(reviewData.url).pathname;
      const matchedPattern = NON_REVIEW_PATHS.find(p => p.test(urlPath));
      if (matchedPattern) {
        console.log(`    ✗ Skipping ${filename}: non-review URL path (${urlPath})`);
        return 'nonReviewPath';
      }
    } catch { /* malformed URL — let through for downstream handling */ }
  }

  // TOUR/REGIONAL GUARD: Reject regional BWW and local paper tour reviews
  if (isLikelyTourReview(reviewData.url, showId)) {
    console.log(`    ✗ Skipping ${filename}: tour/regional review (${reviewData.url?.substring(0, 60)})`);
    return 'tourReview';
  }

  // CROSS-MARKET GUARD: Classify by sibling date / year match before URL-only check.
  // Three outcomes: accept (continue), reject (skip), reroute (recurse into the
  // Broadway sibling directory). Replaces the older thin isBroadwayUrl-only guard —
  // that check is still applied inside classifyMarketRouting as a fallback.
  // See scripts/lib/market-routing.js and Notion 34c637c5-416f-81cf.
  if (reviewData.url || reviewData.publishDate) {
    const showCategory = (getShowData(showId) || {}).category || null;
    const skipCross = getSkipCrossShowDupeIds().has(showId);
    if (!skipCross) {
      const visited = options._marketVisited instanceof Set ? options._marketVisited : new Set();
      const decision = classifyMarketRouting({
        showId,
        url: reviewData.url,
        outletId: reviewData.outletId || normalizedOutletId,
        publishDate: reviewData.publishDate,
        category: showCategory,
        allowCrossMarket: options.allowCrossMarket === true,
        visited,
        siblingIndex: getSiblingIndex(),
      });
      if (decision.action === 'reject') {
        console.log(`    ✗ Skipping ${filename}: ${decision.reason}`);
        return 'crossMarketBroadway';
      }
      if (decision.action === 'reroute') {
        console.log(`    ⤳ Rerouting ${filename}: ${showId} → ${decision.targetShowId} (${decision.reason})`);
        _recordMarketMisroute({ fromShowId: showId, toShowId: decision.targetShowId, file: filename, url: reviewData.url, publishDate: reviewData.publishDate, reason: decision.reason });
        return createReviewFile(decision.targetShowId, reviewData, { ...options, _marketVisited: visited });
      }
    }
  }

  // PRODUCTION VERIFICATION: Check for wrong production (off-Broadway, West End, etc.)
  // Always run venue verification (cheap text scan). Date-based verification only when dates look suspicious.
  {
    const reviewText = reviewData.excerpt || reviewData.fullText;
    const showData = getShowData(showId);
    const dateOk = quickDateCheck(showId, reviewData.url, reviewData.publishDate, showData?.openingDate);
    // Always run full verification if we have text (venue detection catches London reviews
    // even when dates are missing/valid — e.g., shows that played both London and NYC)
    if (!dateOk || reviewText) {
      const verification = verifyProduction({
        showId,
        url: reviewData.url,
        publishDate: reviewData.publishDate,
        text: reviewText,
        category: allowOffBroadway ? 'off-broadway' : undefined
      });

      if (verification.shouldReject) {
        console.log(`    ✗ REJECTED ${filename}: Wrong production detected`);
        for (const issue of verification.issues) {
          console.log(`      - ${issue.message}`);
        }
        return 'wrongProduction';
      }
    }
  }

  // CRITIC-OUTLET VALIDATION: Warn if critic is at an unexpected outlet
  if (validateCriticOutlet) {
    const validation = validateCriticOutlet(reviewData.criticName, reviewData.outlet || reviewData.outletId);
    if (validation.isSuspicious && validation.confidence === 'high') {
      console.log(`    ⚠ SUSPICIOUS: ${reviewData.criticName} at ${reviewData.outlet || reviewData.outletId} (known outlets: ${validation.knownOutlets.join(', ')})`);
    }
  }

  // PROFILE URL REJECTION: critic profile pages are not reviews
  if (reviewData.url && isProfileUrl(reviewData.url)) {
    console.log(`    ✗ Skipping ${filename}: profile URL "${reviewData.url}"`);
    return 'profileUrl';
  }

  // CROSS-SHOW URL SLUG GUARD: reject or re-route URLs whose path clearly
  // belongs to a different show. Catches misattributions where SERP/aggregator
  // returns a review for Show B but it's being filed under Show A (e.g., Into
  // the Woods review filed under Phantom), AND the RSS-leakage class where a
  // poll for Show A surfaces a review for Show B via a global feed (NYT Theater
  // RSS, etc.).
  //
  // Before BUG 2 fix (2026-05-27): the file was discarded entirely. That
  // dropped real reviews on the floor — e.g., NYT Maids URL surfaced during a
  // Poet On A String poll and was lost because the Maids' own poll cycle
  // never re-fetched the same RSS. Now: if the matched show is in shows.json
  // with an eligible status, re-route to its review-texts dir via recursive
  // createReviewFile (same pattern as the cross-market reroute above).
  if (reviewData.url) {
    const mismatch = detectCrossShowUrlMismatch(showId, reviewData.url);
    if (mismatch) {
      const matchedShow = mismatch.matchedShowId ? getShowData(mismatch.matchedShowId) : null;
      const eligibleStatuses = new Set(['open', 'upcoming', 'previews']);
      const visited = options._crossShowVisited instanceof Set ? options._crossShowVisited : new Set();
      const canReroute = matchedShow
        && eligibleStatuses.has(matchedShow.status)
        && !visited.has(mismatch.matchedShowId);
      if (canReroute) {
        visited.add(showId);
        console.log(`    ⤳ Rerouting ${filename}: ${showId} → ${mismatch.matchedShowId} (URL belongs to "${mismatch.matchedTitle}")`);
        return createReviewFile(mismatch.matchedShowId, reviewData, { ...options, _crossShowVisited: visited });
      }
      console.log(`    ✗ Skipping ${filename}: URL belongs to "${mismatch.matchedTitle}" not "${mismatch.showTitle}" — ${reviewData.url}`);
      return 'crossShowUrl';
    }
  }

  // AGGREGATOR-URL MISMATCH CHECK: refuse to write a stub whose url is on a known
  // aggregator domain (theatre.reviews, show-score.com, stagedoor.com, …) but whose
  // outletId is a real outlet (chichester-observer, guardian-uk, …). That is exactly
  // the aggregator_url_mismatch ERROR class validate-review-texts.js flags — serp-discovery
  // kept recreating it and held main red for 2 days (one instance deleted 2026-06-15,
  // 3d54cb4797). Legit aggregator star-stubs (outletId IS an aggregator) are unaffected.
  // This guard is unconditional — unlike the OUTLET_DOMAINS check below it does NOT have an
  // aggregator-source exception, because there is no legitimate case where a real outlet's
  // review URL lives on an aggregator domain. Shared predicate keeps it in lockstep with
  // the validator (scripts/lib/aggregator-domains.js).
  if (isAggregatorUrlMismatch(reviewData.url, normalizedOutletId)) {
    console.log(`    ✗ Skipping ${filename}: aggregator-domain URL (${reviewData.url}) for non-aggregator outlet "${normalizedOutletId}" — would create an aggregator_url_mismatch contamination file`);
    return 'aggregatorUrlMismatch';
  }

  // URL-DOMAIN MISMATCH CHECK: reject URLs that don't match the outlet's registered domain
  // This catches bad SERP results, aggregator URLs (BWW roundup for a broadwaynews review), etc.
  // EXCEPTION: Aggregator-sourced reviews use the aggregator's roundup URL, not the outlet's URL.
  // These get their real outlet URL later via text collection / SERP discovery.
  const isAggregatorSource = reviewData.source && (
    reviewData.source.startsWith('westendtheatre') ||
    reviewData.source.startsWith('theatre-reviews') ||
    reviewData.source.startsWith('stagedoor') ||
    reviewData.source.startsWith('thestage-roundup') ||
    reviewData.source.startsWith('lbo') ||
    reviewData.source === 'show-score' ||
    reviewData.source === 'dtli'
  );
  if (reviewData.url && normalizedOutletId && !isAggregatorSource) {
    const expectedDomain = OUTLET_DOMAINS[normalizedOutletId];
    if (expectedDomain) {
      try {
        const urlDomain = new URL(reviewData.url).hostname.replace(/^www\./, '');
        if (!domainMatchesExpected(expectedDomain.replace(/^www\./, ''), urlDomain)) {
          console.log(`    ✗ Skipping ${filename}: URL domain ${urlDomain} doesn't match outlet ${normalizedOutletId} (expected ${expectedDomain})`);
          return 'domainMismatch';
        }
      } catch (e) { /* invalid URL — let downstream handle */ }
    }
  }

  // CROSS-PRODUCTION URL CHECK: prevent same URL in sibling production directories
  // Exceptions: roundup articles and combined reviews legitimately cover multiple shows
  // Also skip for _skipCrossShowDupe shows (E2E test simulation)
  if (reviewData.url && !getSkipCrossShowDupeIds().has(showId)) {
    const urlIndex = getGlobalUrlIndex();
    const existing = urlIndex.get(normalizeUrl(reviewData.url));
    if (existing && existing.showId !== showId) {
      // Check if existing file is a roundup/combined review (spans shows legitimately)
      // or is junk (invalid/wrongShow/wrongContent) that shouldn't block real reviews
      let allowCrossShow = false;
      let existingIsJunk = false;
      try {
        const existingPath = path.join(REVIEW_TEXTS_DIR, existing.showId, existing.file);
        const existingData = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
        allowCrossShow = existingData.isRoundupArticle === true || existingData.isCombinedReview === true;
        // Don't let invalid/wrong-content files block legitimate reviews
        existingIsJunk = existingData.contentTier === 'invalid'
          || existingData.wrongShow === true
          || existingData.incompleteReason === 'wrong_content'
          || existingData.incompleteReason === 'scraper_garbage'
          || (existingData.contentVerification && existingData.contentVerification.wrongArticle === true);
      } catch (e) { /* file unreadable, treat as non-exception */ }

      if (existingIsJunk) {
        // Existing file is junk — let the new review through regardless
        console.log(`    ⟳ Overriding ${existing.showId}/${existing.file} (junk: invalid/wrongContent) — allowing URL for ${showId}`);
        // Fall through to save
      } else if (!allowCrossShow) {
        // Instead of first-writer-wins, compare which production is correct.
        // Use review year proximity, falling back to most-recent-production-wins.
        const yearMap = getShowYearMap();
        const myYear = yearMap[showId];
        const existingYear = yearMap[existing.showId];

        // Extract review year from publish date or URL
        let reviewYear = null;
        if (reviewData.publishDate) {
          const m = String(reviewData.publishDate).match(/\b((?:19|20)\d\d)\b/);
          if (m) reviewYear = parseInt(m[1]);
        }
        if (!reviewYear && reviewData.url) {
          const m = reviewData.url.match(/(?:[\/\-_.])((?:19|20)\d\d)(?:[\/\-_.]|$)/);
          if (m) reviewYear = parseInt(m[1]);
        }

        let thisShowIsCorrect = false;
        if (reviewYear && myYear && existingYear) {
          const myDist = Math.abs(myYear - reviewYear);
          const existingDist = Math.abs(existingYear - reviewYear);
          // This show wins if strictly closer, or same distance but more recent
          thisShowIsCorrect = myDist < existingDist || (myDist === existingDist && myYear > existingYear);
        } else if (!reviewYear && myYear && existingYear) {
          // No review year — more recent production wins
          thisShowIsCorrect = myYear > existingYear;
        }
        // else: no year info — fall through to first-writer-wins (skip)

        if (thisShowIsCorrect) {
          // Flag the existing file as wrong production and save this one
          try {
            const existingPath = path.join(REVIEW_TEXTS_DIR, existing.showId, existing.file);
            const existingData = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
            // Honor manual clears — don't re-flag a human-verified review.
            if (shouldSkipWrongProductionAudit(existingData)) {
              console.log(`    ⏭️  Existing ${existing.showId}/${existing.file} has manual-clear breadcrumb — leaving alone`);
            } else {
              existingData.wrongProduction = true;
              existingData.wrongProductionNote = `Same URL correctly belongs in ${showId}`;
              fs.writeFileSync(existingPath, JSON.stringify(existingData, null, 2) + '\n');
              console.log(`    ⟳ Flagged ${existing.showId}/${existing.file} as wrongProduction — URL belongs in ${showId}`);
            }
            // Update the URL index to point to this show
            urlIndex.set(normalizeUrl(reviewData.url), { showId, file: filename });
          } catch (e) {
            console.log(`    ⚠ Could not flag ${existing.showId}/${existing.file}: ${e.message}`);
          }
          // Fall through to save this review
        } else {
          console.log(`    ✗ Skipping ${filename}: URL already exists in ${existing.showId}/${existing.file}`);
          return 'crossShow';
        }
      }
      // Roundup/combined review — allow saving in this show's directory too
    }
  }

  // Load show metadata early — needed to auto-detect post-opening context BEFORE the
  // merge loop runs. Also reused by the date guard and placeholder marking below.
  let _showMeta = null;
  try {
    const showsJSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
    _showMeta = showsJSON.shows.find(s => s.id === showId) || null;
  } catch (e) {}

  // Auto-detect post-opening context: if caller didn't explicitly pass fromPostOpening
  // but the show has already opened, treat all merges as post-opening so placeholder
  // stubs get replaced wholesale by late-arriving reviews (e.g., outlet published next day).
  if (!fromPostOpening && _showMeta) {
    const showHasOpened = _showMeta.status === 'open' || _showMeta.status === 'closed'
      || (_showMeta.openingDate && new Date(_showMeta.openingDate) <= new Date());
    if (showHasOpened) {
      mergeOpts = { fromPostOpening: true };
    }
  }

  // Check for existing review with same normalized key
  if (fs.existsSync(showDir)) {
    const existingFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const existingFile of existingFiles) {
      try {
        const existingReview = JSON.parse(fs.readFileSync(path.join(showDir, existingFile), 'utf8'));
        const existingKey = generateReviewKey(existingReview.outlet, existingReview.criticName);

        // Check if same outlet + critic is a first-name prefix match
        // e.g., incoming "Jesse" at "nytimes" should match existing "Jesse Green" at "nytimes"
        const existingOutletId = normalizeOutlet(existingReview.outlet || existingReview.outletId);
        if (existingOutletId === normalizedOutletId && existingKey !== reviewKey) {
          const existingCriticSlug = normalizeCritic(existingReview.criticName);
          const incomingCriticSlug = normalizedCriticName;
          // If incoming is a prefix of existing (e.g., "jesse" is prefix of "jesse-green")
          // or existing is a prefix of incoming
          if (incomingCriticSlug.length >= 3 && existingCriticSlug.startsWith(incomingCriticSlug + '-')) {
            // Incoming "jesse" matches existing "jesse-green" — merge into existing
            const merged = mergeReviews(existingReview, {
              ...reviewData,
              source: reviewData.source || 'gather-reviews',
            }, mergeOpts, { script: 'gather-reviews', showId });
            fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(merged, null, 2));
            console.log(`    ⟳ Prefix match: merged ${filename} into ${existingFile}`);
            return true;
          }
          if (existingCriticSlug.length >= 3 && incomingCriticSlug.startsWith(existingCriticSlug + '-')) {
            // Existing "jesse" matches incoming "jesse-green" — merge and rename
            const merged = mergeReviews(existingReview, {
              ...reviewData,
              source: reviewData.source || 'gather-reviews',
            }, mergeOpts, { script: 'gather-reviews', showId });
            fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(merged, null, 2));
            if (existingFile !== filename) {
              fs.renameSync(path.join(showDir, existingFile), filepath);
            }
            console.log(`    ⟳ Prefix match: merged ${existingFile} into ${filename}`);
            return true;
          }
          // Unknown critic upgrade: existing "unknown" + incoming named critic → merge and rename
          // Catches: vulture--unknown.json (SERP) + incoming vulture/Sara Holdren (BWW/DTLI)
          if (existingCriticSlug === 'unknown' && incomingCriticSlug !== 'unknown'
              && !existingReview.criticNameManual) {
            const merged = mergeReviews(existingReview, {
              ...reviewData,
              source: reviewData.source || 'gather-reviews',
            }, mergeOpts, { script: 'gather-reviews', showId });
            fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(merged, null, 2));
            if (existingFile !== filename) {
              fs.renameSync(path.join(showDir, existingFile), filepath);
            }
            console.log(`    ⟳ Unknown→named: merged ${existingFile} into ${filename}`);
            return true;
          }
        }

        // Check if same review (by key or URL)
        if (existingKey === reviewKey) {
          // If existing file is wrongShow/wrongProduction and incoming has a different URL,
          // replace the existing file instead of merging — the old content is junk.
          // Preserve aggregator-sourced scores (bwwScore, showScoreRating, dtliThumb) that
          // came from a legitimate source even though the text content is wrong.
          // EXCEPTION: if a human reviewed and flagged this file (wrongShowReason or
          // humanReviewedWrongProduction set), DO NOT replace — the flag is intentional.
          // Also protect files that are already LLM-scored: the wrongProduction flag
          // may be an LLM false-positive (44% FP on opening night; Proof 2026-04-17 P0).
          // Route scored files through the merge path so we update the URL without
          // discarding fullText + llmScore. See card 345637c5-416f-81df.
          const isLlmScored = existingReview.llmScore && existingReview.llmScore.score != null;
          const isHumanFlagged = existingReview.wrongShowReason
            || existingReview.humanReviewedWrongProduction === false
            || existingReview.humanReviewScore != null
            || isLlmScored;
          // DoaS Apr 9-10 #13: variety--unknown loop. When BOTH critics are
          // "unknown", outlet+unknown identity is too weak to claim "same review."
          // Refuse the URL re-assignment; preserve the existing wrongShow flag.
          // Named-critic upgrades still work via the path at line ~2511.
          if (isWrongShowUnknownLocked(existingReview, reviewData)) {
            console.log(`    ⊘ wrongShow lock: refusing to reassign URL on ${existingFile} (both critics unknown)`);
            return false;
          }
          // Date-based wrongProduction flags ('Pre-opening guard', 'Date guard',
          // 'Dateless show', 'Tour transfer') are independent of the URL — a
          // fresh URL doesn't change when the review was published. Skip the
          // replacement branch entirely for these so the merge branch below
          // preserves the flag.
          const existingWpNote = existingReview.wrongProductionNote || '';
          const existingIsDateBasedWrongProd = existingReview.wrongProduction && (
            existingWpNote.startsWith('Pre-opening guard')
            || existingWpNote.startsWith('Date guard')
            || existingWpNote.startsWith('Dateless show')
            || existingWpNote.startsWith('Tour transfer')
          );
          if ((existingReview.wrongShow || existingReview.wrongProduction) && reviewData.url
              && (!existingReview.url || normalizeUrl(reviewData.url) !== normalizeUrl(existingReview.url))
              && !isHumanFlagged
              && !existingIsDateBasedWrongProd) {
            // A file with llmScore + fullText is real content — the wrongProduction flag may be
            // an LLM false-positive (44% FP rate on opening night; Proof 2026-04-17 P0 incident).
            // Preserving scored content here ensures a second poller run can't clobber it even
            // when the incoming URL differs slightly (different query params, subdomain variation).
            const alreadyScored = (existingReview.llmScore && existingReview.llmScore.score != null)
              || existingReview.humanReviewScore != null;
            // Single source of truth — see scripts/lib/wrongprod-replacement-preserve.js.
            // Aggregator signals always preserve, scored content preserves PROTECTED_FIELDS
            // minus REPLACE_CLEAR_FIELDS, human-decision fields always preserve.
            const preserved = computeReplacementPreserve(existingReview, { alreadyScored });
            const replacement = { ...reviewData, ...preserved, source: reviewData.source || 'gather-reviews' };
            // Explicitly clear ALL blocking metadata — the old file's flags are about
            // the wrong production/show and must not survive into the replacement.
            // (Titanique postmortem: TheaterMania had contentTier:invalid from old production,
            // 5+ flags had to be manually cleared on 4 reviews, each independently blocked scoring.)
            delete replacement.wrongProduction;
            delete replacement.wrongProductionReason;
            delete replacement.wrongProductionNote;
            delete replacement.wrongShow;
            delete replacement.wrongShowReason;
            delete replacement.wrongShowNote;
            delete replacement.wrongShowAutoCleared;
            delete replacement.contentTier;
            delete replacement.contentTierReason;
            delete replacement.incompleteReason;
            delete replacement.incompleteDetail;
            delete replacement.rejectionReason;
            delete replacement.rejectedBy;
            delete replacement.rejectionReasoning;
            if (replacement.contentVerification) {
              delete replacement.contentVerification.wrongArticle;
              delete replacement.contentVerification.verifiedAt;
              delete replacement.contentVerification.verifiedBy;
              delete replacement.contentVerification.reasoning;
              delete replacement.contentVerification.confidence;
              delete replacement.contentVerification.isValid;
            }
            delete replacement.fetchAttempts;
            delete replacement.lastFetchDate;
            // Signal that text needs to be collected from the new URL
            if (!replacement.fullText) {
              replacement.needsRecollection = true;
            }
            fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(replacement, null, 2) + '\n');
            if (existingFile !== filename) {
              fs.renameSync(path.join(showDir, existingFile), filepath);
            }
            console.log(`    ♻ Replaced wrongShow/wrongProd file ${existingFile} with fresh URL (all blocking flags cleared)`);
            return true;
          }

          // Same outlet+critic - merge data instead of skipping
          const merged = mergeReviews(existingReview, {
            ...reviewData,
            source: reviewData.source || 'gather-reviews',
          }, mergeOpts);
          fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(merged, null, 2));

          // Rename to canonical filename if different
          if (existingFile !== filename) {
            fs.renameSync(path.join(showDir, existingFile), filepath);
          }

          console.log(`    ⟳ ${!merged.isPreviewPlaceholder && existingReview.isPreviewPlaceholder ? 'Replaced placeholder' : 'Merged'} into ${filename}`);
          return true;
        }

        // Check URL match — merge instead of skipping to capture new metadata
        // But skip URL match if the existing file is wrongShow — same bad URL shouldn't merge.
        // Also skip if both critics are different named critics at the same outlet:
        // multi-critic outlets (NYSR, TimeOut) each get their own file even when DTLI/SERP
        // discovers them simultaneously with the same URL (Proof incident: Torre's URL leaked
        // into Suskin's file, which then scored on Torre's content).
        const existingOutletForUrlCheck = normalizeOutlet(existingReview.outlet || existingReview.outletId);
        const existingCriticForUrlCheck = normalizeCritic(existingReview.criticName);
        const isDifferentNamedCriticsAtSameOutlet = existingOutletForUrlCheck === normalizedOutletId
          && existingCriticForUrlCheck !== 'unknown'
          && normalizedCriticName !== 'unknown'
          && existingCriticForUrlCheck !== normalizedCriticName;
        if (isDifferentNamedCriticsAtSameOutlet && reviewData.url
            && normalizeUrl(existingReview.url) === normalizeUrl(reviewData.url)) {
          console.log(`    ⚠ URL shared by ${existingCriticForUrlCheck} and ${normalizedCriticName} at ${normalizedOutletId} — creating separate file (URL to be re-discovered per critic via SERP)`);
        } else if (reviewData.url && normalizeUrl(existingReview.url) === normalizeUrl(reviewData.url)
            && !existingReview.wrongShow) {
          const merged = mergeReviews(existingReview, {
            ...reviewData,
            source: reviewData.source || 'gather-reviews',
          }, mergeOpts);
          fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(merged, null, 2));
          console.log(`    ⟳ URL match: ${!merged.isPreviewPlaceholder && existingReview.isPreviewPlaceholder ? 'replaced placeholder' : 'merged'} ${filename} into ${existingFile}`);
          return true;
        }
      } catch (e) {
        // Skip files that can't be parsed
      }
    }
  }

  // Same-show URL dedup via global URL index — catches phantom outlet duplicates
  // where the same URL exists under a different outlet name in the same show
  if (reviewData.url) {
    const globalIdx = getGlobalUrlIndex();
    const existing = globalIdx.get(normalizeUrl(reviewData.url));
    if (existing && existing.showId === showId) {
      console.log(`    Skipping ${filename} (URL already indexed in ${existing.file} for same show)`);
      return 'duplicate';
    }
  }

  // Create new review file with normalized data
  // Clean all text fields to decode HTML entities and strip junk
  const review = {
    showId,
    outletId: normalizedOutletId,
    outlet: getOutletDisplayName(normalizedOutletId),
    criticName: reviewData.criticName || 'Unknown',
    url: reviewData.url || null,
    publishDate: normalizePublishDate(reviewData.publishDate) || null,
    // NOTE: Previously fell back to show's opening date when no review date available.
    // Removed: fake dates mask wrong-production reviews (e.g., OB review stamped with
    // Broadway opening date defeats date-based guards). Null is safer — downstream
    // scripts (backfill-review-dates, backfill-llm-dates) will fill in real dates later.
    fullText: null,  // Never populate from excerpts — let collect-review-texts.js scrape real fullText
    isFullReview: false,
    dtliExcerpt: cleanText(reviewData.dtliExcerpt || (reviewData.source !== 'serp-discovery' ? reviewData.excerpt : null)) || null,
    // AGGREGATOR SCORE GUARD: Never store aggregator-sourced scores as originalScore.
    // Aggregator stars are third-party ratings, not the outlet's own score.
    ...(() => {
      const isAggregator = AGGREGATOR_SCORE_SOURCES.has(reviewData.scoreSource);
      const parsedScore = reviewData.originalRating
        ? parseRating(reviewData.originalRating, normalizedOutletId)
        : (reviewData.score != null ? reviewData.score : null);
      if (isAggregator) {
        return { originalScore: null, aggregatorStars: parsedScore };
      }
      return { originalScore: parsedScore };
    })(),
    scoreSource: reviewData.scoreSource || null,
    assignedScore: null,
    source: reviewData.source || 'gather-reviews',
    dtliThumb: reviewData.dtliThumb || null,
    dtliUrl: reviewData.dtliUrl || null,
    bwwExcerpt: cleanText(reviewData.bwwExcerpt) || null,
    bwwRoundupUrl: reviewData.bwwRoundupUrl || null,
    showScoreExcerpt: cleanText(reviewData.showScoreExcerpt || (reviewData.source !== 'serp-discovery' ? reviewData.excerpt : null)) || null
  };

  // Auto-tag known roundup outlets whose pages OFTEN cover multiple shows.
  // Skip the tag when the URL is on the outlet's own domain in an individual-post
  // path — these outlets do publish single-show reviews too, and the flag
  // suppresses scoring downstream. Notion 34e637c5.
  const KNOWN_ROUNDUP_OUTLETS = new Set([
    'interested-bystander',
    'the-interested-bystander',
    'the-clyde-fitch-report',
  ]);
  if (KNOWN_ROUNDUP_OUTLETS.has(normalizedOutletId)) {
    const url = review.url || '';
    // Per-month post path on outlet domain looks individual EXCEPT when the slug
    // itself names a roundup. Mirrors the LBO carve-out in isRoundupUrl.
    const isPerMonthPost =
      /clydefitchreport\.com\/\d{4}\/\d{2}\//i.test(url) ||
      /interestedbystander\.com\/\d{4}\/\d{2}\//i.test(url);
    const slugLooksRoundup = /\/[^/]*(?:roundup|round-up)[^/]*\.?html?$|\/[^/]*(?:roundup|round-up)[^/]*\/?$/i.test(url);
    const looksIndividual = isPerMonthPost && !slugLooksRoundup;
    if (!looksIndividual) {
      review.isRoundupArticle = true;
    }
  }

  // Auto-tag BWW Review Roundup pages by URL pattern — these are aggregator pages,
  // not individual reviews. They list excerpts from multiple outlets.
  if (review.url && /broadwayworld\.com\/article\/.*review-roundup/i.test(review.url)) {
    review.isRoundupArticle = true;
  }

  // Classify content quality so downstream scoring knows what it's working with
  const tier = classifyContentTier(review);
  review.contentTier = tier.contentTier;
  review.contentTierReason = tier.tierReason;

  // (_showMeta loaded above, before merge loop)

  // Date-based production guard: warn if review was published >30 days before
  // the show's earliest date (previews/opening). Likely from a prior production.
  // Off-Broadway shows are exempt: they commonly transfer from regional theaters,
  // so date mismatches are expected and wrongProduction flags are almost always false positives.
  // Production-continuity exemption (Phase 1): also skip when publishDate falls
  // inside a declared priorRuns window — legitimate coverage of an earlier run.
  if (review.publishDate && _showMeta) {
    try {
      const show = _showMeta;
      if (show.category !== 'off-broadway' && !isWithinPriorRun(review.publishDate, show.priorRuns)) {
        const earliest = show.previewsStartDate || show.openingDate;
        if (earliest) {
          const pubDate = new Date(review.publishDate);
          const earliestDate = new Date(earliest);
          const daysBefore = (earliestDate - pubDate) / (1000 * 60 * 60 * 24);
          if (daysBefore > 30) {
            console.log(`    ⚠️  WARNING: Review published ${Math.round(daysBefore)} days before show's earliest date (${earliest}).`);
            console.log(`       Likely from a prior production. Flagging as wrongProduction.`);
            review.wrongProduction = true;
            review.wrongProductionNote = `Auto-flagged: published ${Math.round(daysBefore)} days before show earliest date ${earliest}`;
          }
        }
      }
    } catch (e) {}
  }

  // URL-path date fallback: when publishDate is null (common on Unknown-byline
  // SERP hits), extract /YYYY/MM/DD/ from the URL and apply the same 30-day rule.
  // Only fires on Unknown/Staff bylines — named critics get the benefit of the
  // doubt (pre-transfer UK/OB coverage is a real category the URL-date rule
  // can't distinguish from "different production"). See helper for detail.
  // Was gap on Fallen Angels 2026 — 7 wrong files needed manual cleanup.
  if (!review.wrongProduction && _showMeta) {
    try {
      const reason = getWrongProductionReasonForUnknownCritic(review, _showMeta);
      if (reason) {
        console.log(`    ⚠️  ${reason}`);
        review.wrongProduction = true;
        review.wrongProductionNote = reason;
      }
    } catch (e) {}
  }

  // NULL-URL GUARD: Reject --unknown reviews with no URL AND no aggregator excerpt.
  // These are unfetchable and unverifiable — likely aggregator artifacts.
  // Named critics may legitimately have no URL (from ShowScore excerpts).
  if (!review.url && normalizedCriticName === 'unknown') {
    const hasExcerpt = review.bwwExcerpt || review.dtliExcerpt || review.showScoreExcerpt || review.playbillExcerpt || review.nycTheatreExcerpt || review.lboRoundupExcerpt;
    if (!hasExcerpt) {
      console.log(`    ✗ Skipping ${filename}: no URL and no excerpt — unfetchable/unverifiable`);
      return 'nullUrl';
    }
  }

  // URL/DOMAIN VALIDATION: Reject reviews where URL domain doesn't match the attributed outlet.
  // This catches aggregator scraping errors where a URL from outlet-A gets attributed to outlet-B
  // (e.g., the-sun outletId with thetimes.co.uk URL, or timeout outletId with westendtheatre.com URL).
  // Validate ALL sources — previously only SERP + unknown critics, but BWW roundups and ShowScore
  // also misattribute. Wire services and shared-domain outlets are exempted below.
  const shouldValidateDomain = true;
  if (review.url && shouldValidateDomain) {
    const WIRE_SERVICES = new Set(['ap', 'reuters', 'bloomberg', 'upi']);
    if (!WIRE_SERVICES.has(normalizedOutletId)) {
      try {
        const resolved = resolveOutletFromUrl(review.url);
        if (resolved && resolved.outletId !== normalizedOutletId) {
          // Allow if both outlets share the same registry domain (e.g., timeout / timeout-london)
          const reg = _outletRegistryCache || (() => {
            try {
              const r = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8'));
              _outletRegistryCache = r.outlets || {};
              return _outletRegistryCache;
            } catch (e) { return {}; }
          })();
          const attrDomain = reg[normalizedOutletId]?.domain?.replace(/^www\./, '').toLowerCase();
          const resolvedDomain = reg[resolved.outletId]?.domain?.replace(/^www\./, '').toLowerCase();
          const sharedDomain = attrDomain && resolvedDomain && attrDomain === resolvedDomain;
          if (!sharedDomain) {
            console.log(`    ✗ Skipping ${filename}: URL domain resolves to "${resolved.outletId}" but attributed to "${normalizedOutletId}"`);
            return 'domainMismatch';
          }
        }
      } catch (e) { /* URL parse error — proceed */ }
    }
  }

  // Mark file as a preview-period placeholder when the show hasn't opened yet.
  // mergeReviews() respects this flag: post-opening discoveries replace the file
  // wholesale rather than merging into stale preview data.
  // _showMeta is already loaded above — no second disk read needed.
  if (_showMeta) {
    const isPreviewsStatus = _showMeta.status === 'previews';
    const hasNotOpenedYet = _showMeta.openingDate
      && new Date(_showMeta.openingDate) > new Date();
    if (isPreviewsStatus || hasNotOpenedYet) {
      review.isPreviewPlaceholder = true;
    }
  }

  // Pattern Card #4: route --unknown.json files with a URL to _pending/ instead of
  // the main show directory. Decision logic + carve-out rationale lives in
  // scripts/lib/review-guards.js → shouldRouteUnknownCriticToPending().
  // Tested at tests/unit/pending-strand-routing.test.mjs.
  if (shouldRouteUnknownCriticToPending({ criticName: normalizedCriticName, url: review.url, source: review.source })) {
    const pendingDir = path.join(REVIEW_TEXTS_DIR, '_pending', showId);
    if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });
    const urlHash = (() => {
      let h = 0;
      for (const c of review.url) { h = ((h << 5) - h + c.charCodeAt(0)) | 0; }
      return Math.abs(h).toString(16).slice(0, 8);
    })();
    const pendingFilename = `${normalizedOutletId}--${urlHash}.json`;
    const pendingPath = path.join(pendingDir, pendingFilename);
    fs.writeFileSync(pendingPath, JSON.stringify({ ...review, pendingReason: 'no-byline' }, null, 2));
    console.log(`    → no byline — routing to pending: _pending/${showId}/${pendingFilename}`);
    return true;
  }

  fs.writeFileSync(filepath, JSON.stringify(review, null, 2));

  // Register in global URL index so subsequent calls see it
  if (review.url && _globalUrlIndex) {
    _globalUrlIndex.set(normalizeUrl(review.url), { showId, file: path.basename(filepath) });
  }

  try {
    emitStage({
      showId,
      reviewKey: `${normalizedOutletId}:${normalizeCritic(reviewData.criticName)}:${reviewData.url || ''}`,
      stage: 'review-first-seen',
    });
  } catch (e) { process.stderr.write(`[stage-latency] gather emit failed: ${e.message}\n`); }

  console.log(`    ✓ Created ${filename}`);
  return true;
}

/**
 * Parse a rating string into a 0-100 score
 */
// Outlets that use letter grade scoring (from src/config/scoring.ts scoreFormat: 'letter').
// Letter grades from other outlets are rejected to prevent cross-contamination
// (e.g., BWW roundup leaking EW's grade into a text_bucket outlet like NYDN).
const LETTER_GRADE_OUTLETS = new Set(['ew', 'jks-theatre-scene', 'gotham-playgoer']);

function parseRating(rating, outletId) {
  if (!rating) return null;

  const r = rating.toLowerCase().trim();

  // Star ratings out of 5 — accepted for any outlet
  const stars5 = r.match(/([\d.]+)\s*(?:\/|\s*out of\s*)?\s*5/);
  if (stars5) return Math.round((parseFloat(stars5[1]) / 5) * 100);

  // Star ratings out of 4 — accepted for any outlet
  const stars4 = r.match(/([\d.]+)\s*(?:\/|\s*out of\s*)?\s*4/);
  if (stars4) return Math.round((parseFloat(stars4[1]) / 4) * 100);

  // Letter grades — only for outlets that use letter grade scoring.
  // Uses canonical LETTER_GRADES from score-extractors.js (matches src/config/scoring.ts).
  const upperR = r.toUpperCase();
  if (LETTER_GRADES[upperR] !== undefined) {
    if (outletId && !LETTER_GRADE_OUTLETS.has(outletId)) {
      console.warn(`⚠️  Rejecting letter grade "${rating}" for ${outletId} (not a letter-grade outlet)`);
      return null;
    }
    return LETTER_GRADES[upperR];
  }

  return null;
}

/**
 * Main review gathering for a single show
 */
async function gatherReviewsForShow(showId, aggregatorsOnly = false, options = {}) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Gathering reviews for: ${showId}`);
  console.log('='.repeat(60));

  const show = loadShowData(showId);
  if (!show) {
    console.error(`Show not found: ${showId}`);
    return { success: false, error: 'Show not found' };
  }

  // Skip shows in previews — they haven't opened yet, any scraped reviews are wrong-production
  if (show.status === 'previews') {
    console.log(`[SKIP] ${showId}: Show is in previews (opens ${show.openingDate}) — skipping to avoid wrong-production contamination`);
    return { success: true, skipped: true, reason: 'previews' };
  }

  const year = new Date(show.openingDate).getFullYear();
  console.log(`Title: ${show.title}`);
  console.log(`Year: ${year}`);
  console.log(`Status: ${show.status}`);

  const foundReviews = [];
  const outlets = loadOutlets({ category: show.category });
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);

  // Per-show health tracking
  const health = {
    category: show.category || 'broadway',
    status: show.status,
    dtli: { found: false, extracted: 0, skipped: false },
    showScore: { found: false, extracted: 0, skipped: false },
    bww: { found: false, extracted: 0, skipped: false },
    lbo: { found: false, extracted: 0, skipped: false },
    serp: { calls: 0, hits: 0, skipped: false },
    wrongUrlRetry: { found: 0, retried: 0, fixed: 0, skipped: false },
    rejections: { junkOutlet: 0, suspiciousOutlet: 0, nonBroadway: 0, tourReview: 0, crossMarketBroadway: 0, nonReviewPath: 0, wrongProduction: 0, duplicate: 0, crossShow: 0, crossShowUrl: 0, domainMismatch: 0, aggregatorUrlMismatch: 0, nullUrl: 0 },
    urlValidation: { checked: 0, nulled: 0 },
  };

  // STEP 1: Check ALL THREE aggregators (DTLI, Show Score, BWW Review Roundups)
  console.log('\n[1/4] Checking aggregators...');

  // 1a. Did They Like It - Has individual thumb ratings (Up/Meh/Down)
  console.log('\n  === Did They Like It ===');
  let dtliResult = await searchDTLI(show);
  if (dtliResult && dtliResult.html) {
    const dtliValidation = await validatePageMatchesShow(dtliResult.html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null });
    if (!dtliValidation.valid) {
      console.log(`    ✗ DTLI page doesn't match "${show.title}": ${dtliValidation.reason}`);
      dtliResult = null;
    }
  }
  if (dtliResult) {
    health.dtli.found = true;
    let dtliReviews = extractDTLIReviews(dtliResult.html, showId, dtliResult.url, show.title);
    const dtliExpected = countExpectedReviews(dtliResult.html, 'dtli');
    // LLM fallback, two triggers:
    //   1. Regex extracted 0 but page has review markers — full site redesign case.
    //   2. Regex extracted < expected (thumb-summary total) by >=3 — partial
    //      parser miss, e.g. DTLI adds a new block variant and we silently drop
    //      2 of 8 reviews. Merges LLM-found reviews into the regex baseline.
    if (dtliReviews.length === 0 && hasStructuralMarkers(dtliResult.html, 'dtli')) {
      dtliReviews = await llmFallbackExtract(dtliResult.html, {
        aggregator: 'dtli', showTitle: show.title, showId,
      });
    } else if (isPartialExtraction(dtliReviews.length, dtliExpected) && hasStructuralMarkers(dtliResult.html, 'dtli')) {
      console.log(`    ⚠ DTLI partial extraction: regex got ${dtliReviews.length}, thumb-summary says ~${dtliExpected} — running LLM for the gap`);
      const llmReviews = await llmFallbackExtract(dtliResult.html, {
        aggregator: 'dtli', showTitle: show.title, showId,
      });
      const before = dtliReviews.length;
      dtliReviews = mergeAggregatorReviews(dtliReviews, llmReviews);
      console.log(`    ✓ DTLI partial merge: ${before} regex + ${llmReviews.length} LLM → ${dtliReviews.length} after dedup`);
    }
    health.dtli.extracted = dtliReviews.length;
    foundReviews.push(...dtliReviews);
    // Archive the page
    archiveAggregatorPage('dtli', showId, dtliResult.url, dtliResult.html);
  }
  await sleep(DELAY_MS);

  // 1b. Show Score - Has critic reviews with excerpts
  console.log('\n  === Show Score ===');
  let showScoreResult = await searchShowScore(show);
  if (showScoreResult && showScoreResult.html) {
    const ssValidation = await validatePageMatchesShow(showScoreResult.html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null });
    if (!ssValidation.valid) {
      console.log(`    ✗ ShowScore page doesn't match "${show.title}": ${ssValidation.reason}`);
      showScoreResult = null;
    }
  }
  if (showScoreResult) {
    health.showScore.found = true;
    let showScoreCount = 0;
    // Extract initial reviews from page (first 8 visible in carousel)
    if (showScoreResult.reviews && showScoreResult.reviews.length > 0) {
      console.log(`    Playwright extracted ${showScoreResult.reviews.length} reviews directly`);
      for (const review of showScoreResult.reviews) {
        // Map Playwright review to our format
        // When outlet is missing from Playwright extraction, resolve from URL domain
        let outletId, outletDisplayName;
        if (review.outlet) {
          outletId = slugify(review.outlet);
          outletDisplayName = review.outlet;
        } else {
          // Try to resolve outlet from URL using registry
          const resolved = resolveOutletFromUrl(review.url);
          if (resolved) {
            outletId = resolved.outletId;
            outletDisplayName = resolved.displayName;
          } else {
            // Fallback: use domain base (without TLD) as both ID and display name
            // Never use literal "Unknown" - use the domain so the review is attributable
            try {
              const hostname = new URL(review.url).hostname.replace(/^www\./, '').toLowerCase();
              const domainBase = hostname.split('.')[0];
              outletId = domainBase;
              outletDisplayName = domainBase; // Will be displayed as-is (e.g., "culturesauce")
            } catch {
              outletId = 'unknown';
              outletDisplayName = 'Unknown';
            }
          }
        }
        showScoreCount++;
        // Convert star rating to originalRating format if available
        let originalRating = null;
        if (review.starRating != null) {
          const scale = review.starMax || 5;
          originalRating = review.starRating > 5
            ? `${review.starRating}/100`
            : `${review.starRating}/${scale}`;
        }
        foundReviews.push({
          showId,
          outlet: outletDisplayName,
          outletId,
          criticName: sanitizeCriticName(review.critic) || 'Unknown',
          url: (show.title && review.url && !urlLooksLikeReview(review.url, show.title)) ? null : review.url,
          publishDate: normalizePublishDate(review.date) || null,
          showScoreExcerpt: review.excerpt || null,
          originalRating,
          source: 'show-score-playwright'
        });
      }
    } else {
      // Fall back to HTML extraction for initial reviews
      const showScoreReviews = extractShowScoreReviews(showScoreResult.html, showId, show.title);
      showScoreCount += showScoreReviews.length;
      foundReviews.push(...showScoreReviews);
    }

    // Fetch remaining reviews via Show Score pagination API
    // The initial page only shows 8 critic reviews; the rest are loaded via AJAX
    const paginatedReviews = await fetchShowScorePaginatedReviews(
      showScoreResult.url, showScoreResult.html, showId, show.title
    );
    for (const review of paginatedReviews) {
      // Only add if not already found (avoid duplicates from initial extraction)
      if (!foundReviews.some(r => r.url === review.url)) {
        showScoreCount++;
        foundReviews.push(review);
      }
    }

    health.showScore.extracted = showScoreCount;

    // Extract verified star ratings from outlet pages for SS-sourced reviews.
    // SS assigns its own star ratings which are wrong ~11% of the time.
    // Fetching the actual outlet page and running extractScore() gives us the
    // outlet's real rating at gather time, before collect-review-texts.js runs.
    const ssReviews = foundReviews.filter(r =>
      (r.source === 'show-score-playwright' || r.source === 'show-score') && r.url
    );
    if (ssReviews.length > 0) {
      console.log(`\n    --- Extracting verified star ratings from ${ssReviews.length} SS outlet URLs ---`);
      let extracted = 0, skipped = 0, failed = 0;
      for (const review of ssReviews) {
        // Skip if we already have a score from an aggregator for this outlet
        const hasAggregatorScore = foundReviews.some(r =>
          r !== review &&
          normalizeOutlet(r.outlet || r.outletId) === normalizeOutlet(review.outlet || review.outletId) &&
          r.scoreSource
        );
        if (hasAggregatorScore) {
          skipped++;
          continue;
        }
        try {
          const result = await fetchPage(review.url);
          const html = result?.content || (typeof result === 'string' ? result : '');
          if (html && html.length > 500) {
            const outletId = normalizeOutlet(review.outlet || review.outletId);
            const score = extractScore(html, '', outletId);
            if (score && score.normalizedScore != null) {
              const prevRating = review.originalRating || '(none)';
              review.originalRating = score.originalScore || `${Math.round(score.normalizedScore)}/100`;
              review.score = score.normalizedScore;
              review.scoreSource = score.source || 'outlet-page-extraction';
              extracted++;
              console.log(`      ✓ ${outletId}: ${review.originalRating} [${review.scoreSource}] (was SS: ${prevRating})`);
            }
          }
        } catch (e) {
          failed++;
          // Silently fall back to SS star rating
        }
        await sleep(1000); // Rate limit outlet fetches
      }
      console.log(`    Star extraction: ${extracted} verified, ${skipped} had aggregator score, ${failed} failed`);
      if (!health.starExtraction) health.starExtraction = {};
      health.starExtraction.extracted = extracted;
      health.starExtraction.skipped = skipped;
      health.starExtraction.failed = failed;
    }

    // Archive the page
    archiveAggregatorPage('show-score', showId, showScoreResult.url, showScoreResult.html);
  }
  await sleep(DELAY_MS);

  // 1c. BroadwayWorld Review Roundups - Compiles all reviews in one article
  console.log('\n  === BroadwayWorld Review Roundups ===');
  if (isOffBroadway) {
    health.bww.skipped = true;
    console.log(`    [SKIP] BWW roundups disabled for off-Broadway (URL patterns are Broadway-specific)`);
  }
  let bwwResult = isOffBroadway ? null : await searchBWWRoundup(show, year);
  // Validate page matches target show (prevents cross-show contamination)
  if (bwwResult && bwwResult.html) {
    const validation = await validatePageMatchesShow(bwwResult.html, show.title, {
      openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
      pageUrl: bwwResult.url,
    });
    if (!validation.valid) {
      console.log(`    ✗ BWW roundup page doesn't match "${show.title}": ${validation.reason}`);
      bwwResult = null;
    }
  }
  if (bwwResult) {
    health.bww.found = true;
    // Check if the roundup article is about a tour/regional/non-Broadway production.
    // BWW roundup article URLs/titles clearly indicate: "National-Tour-of-...", "on-Tour",
    // "at-the-Kennedy-Center", "at-the-Ahmanson" etc. Reject the entire page if so.
    const roundupTitle = (bwwResult.url || '').replace(/-/g, ' ').toLowerCase();
    if (isNotBroadway(roundupTitle, { allowOffBroadway: isOffBroadway, allowWestEnd: isWestEnd, allowOpera: show.type === 'opera' }) ||
        /\bon tour\b/.test(roundupTitle) || /\bat the kennedy center\b/.test(roundupTitle) ||
        /\bat the (ahmanson|old globe|la jolla|goodman|steppenwolf|arena stage)\b/.test(roundupTitle)) {
      console.log(`    ✗ Skipping non-Broadway roundup: ${bwwResult.url}`);
    } else {
      let bwwReviews = extractBWWRoundupReviews(bwwResult.html, showId, bwwResult.url, show.title);
      const bwwExpected = countExpectedReviews(bwwResult.html, 'bww');
      // LLM fallback, two triggers:
      //   1. Regex extracted 0 but page has roundup markers — BWW redesign case.
      //   2. Regex extracted < expected (thumb image count) by >=3 — partial
      //      parser miss, e.g. BWW adds a new format variant (Fallen Angels
      //      `uptrans2.png` case class) and the JSON-LD/Method-2 pipeline drops
      //      some critics. Merges LLM-found reviews into the regex baseline.
      if (bwwReviews.length === 0 && hasStructuralMarkers(bwwResult.html, 'bww')) {
        bwwReviews = await llmFallbackExtract(bwwResult.html, {
          aggregator: 'bww', showTitle: show.title, showId,
        });
      } else if (isPartialExtraction(bwwReviews.length, bwwExpected) && hasStructuralMarkers(bwwResult.html, 'bww')) {
        console.log(`    ⚠ BWW partial extraction: regex got ${bwwReviews.length}, thumb-count says ~${bwwExpected} — running LLM for the gap`);
        const llmReviews = await llmFallbackExtract(bwwResult.html, {
          aggregator: 'bww', showTitle: show.title, showId,
        });
        const before = bwwReviews.length;
        bwwReviews = mergeAggregatorReviews(bwwReviews, llmReviews);
        console.log(`    ✓ BWW partial merge: ${before} regex + ${llmReviews.length} LLM → ${bwwReviews.length} after dedup`);
      }
      // Validate geographic accuracy — filter non-local outlets, reject if majority are wrong
      bwwReviews = validateBWWRoundupGeography(bwwReviews, bwwResult.html, showId, isWestEnd);
      // Validate publish year — reject roundups from older productions of the same title
      bwwReviews = validateBWWRoundupYear(bwwReviews, bwwResult.html, show.openingDate, showId, bwwResult.url);
      health.bww.extracted = bwwReviews.length;
      foundReviews.push(...bwwReviews);
      // Archive the page
      archiveAggregatorPage('bww-roundups', showId, bwwResult.url, bwwResult.html);
    }
  }
  await sleep(DELAY_MS);

  // Helper: extract publish date from roundup HTML (JSON-LD, meta tags, or <time>)
  function extractRoundupDateFromHtml(html) {
    if (!html || html.length < 100) return null;
    // JSON-LD datePublished
    const jsonLdMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
    if (jsonLdMatch) {
      const d = jsonLdMatch[1].substring(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    }
    // article:published_time meta
    const metaMatch = html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i);
    if (metaMatch) {
      const d = metaMatch[1].substring(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    }
    // <time datetime="...">
    const timeMatch = html.match(/<time[^>]*datetime=["']([^"']+)["']/i);
    if (timeMatch) {
      const d = timeMatch[1].substring(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    }
    return null;
  }

  // 1d. London Box Office Review Roundups (West End only, archive-based)
  console.log('\n  === London Box Office Review Roundups ===');
  if (!isWestEnd) {
    health.lbo.skipped = true;
    console.log(`    [SKIP] LBO roundups are West End only`);
  } else {
    const lboArchivePath = path.join(__dirname, '../data/aggregator-archive/lbo-roundups', `${showId}.html`);
    if (fs.existsSync(lboArchivePath)) {
      const lboHtml = fs.readFileSync(lboArchivePath, 'utf8');
      // Validate the cached archive actually matches this show — past bug
      // wrote roundup HTML for the wrong show under {showId}.html, then this
      // block read it and filed reviews against the wrong show.
      // (Stuart King mis-attribution incident, 2026-04-25.)
      const validation = validateRoundupPageTitle(lboHtml, show.title || showId);
      if (!validation.ok) {
        console.log(`    ✗ LBO archive page-title mismatch (${validation.reason}): "${(validation.pageTitle || '').substring(0, 60)}" — quarantining`);
        try { fs.renameSync(lboArchivePath, lboArchivePath + '.mismatch'); } catch (e) {}
        health.lbo.skipped = true;
        // Fall through to the rest of the function (other aggregators).
      } else {
      const lboRawReviews = extractReviewsFromLBO(lboHtml, showId);
      const lboRoundupDate = extractRoundupDateFromHtml(lboHtml);
      health.lbo.found = true;
      console.log(`    ✓ LBO archive found, extracted ${lboRawReviews.length} reviews${lboRoundupDate ? ` (date: ${lboRoundupDate})` : ''}`);

      for (const lboReview of lboRawReviews) {
        foundReviews.push({
          outlet: lboReview.outlet,
          outletId: normalizeOutlet(lboReview.outlet),
          criticName: lboReview.critic,
          url: lboReview.url || '',
          excerpt: lboReview.excerpt || '',
          score: lboReview.score,
          scoreSource: lboReview.score !== null ? 'lbo-star-rating' : undefined,
          source: 'lbo-roundup',
          publishDate: lboRoundupDate || null,
        });
      }
      health.lbo.extracted = lboRawReviews.length;
      } // close validated-archive block
    } else {
      console.log(`    No LBO archive found for ${showId}`);
    }
  }

  // 1e. WE Aggregators (West End only, archive-based — WET, TR, SD, TS)
  // These are populated by the weekly sweep-we-aggregators workflow.
  // For opening nights, archives may not exist yet (roundups take days to publish).
  // But for follow-up gather runs and rebuilds, they provide the best WE review data.
  if (isWestEnd) {
    console.log('\n  === WE Aggregators (archive) ===');
    const archBase = path.join(__dirname, '../data/aggregator-archive');

    // WestEndTheatre.com (WET) — cached API responses
    const wetCache = path.join(archBase, 'westendtheatre', `${showId}.json`);
    if (fs.existsSync(wetCache)) {
      try {
        const cached = JSON.parse(fs.readFileSync(wetCache, 'utf8'));
        const wetReviews = cached.reviews || cached.ratings || [];
        const wetPostDate = cached.postDate || null;
        if (wetReviews.length > 0) {
          console.log(`    ✓ WET: ${wetReviews.length} reviews from cache${wetPostDate ? ` (date: ${wetPostDate})` : ''}`);
          for (const r of wetReviews) {
            foundReviews.push({
              outlet: r.outlet, outletId: r.outletId || normalizeOutlet(r.outlet),
              criticName: r.critic || 'Unknown', url: r.url || r.reviewUrl || '',
              excerpt: r.excerpt || '',
              // WET rates shows independently — don't use as outlet's score
              wetStars: r.stars ? `${r.stars}/${r.starsOutOf || 5}` : undefined,
              source: 'westendtheatre', publishDate: normalizePublishDate(r.date || wetPostDate) || null,
            });
          }
        }
      } catch {}
    }

    // theatre.reviews (TR) — cached HTML
    const { extractReviews: extractTR } = require('./scrape-theatre-reviews');
    const trArchive = path.join(archBase, 'theatre-reviews', `${showId}.html`);
    if (fs.existsSync(trArchive)) {
      try {
        const html = fs.readFileSync(trArchive, 'utf8');
        const trVal = validateRoundupPageTitle(html, show.title || showId);
        if (!trVal.ok) {
          console.log(`    ✗ TR archive page-title mismatch (${trVal.reason}) — quarantining`);
          try { fs.renameSync(trArchive, trArchive + '.mismatch'); } catch (e) {}
          throw new Error('quarantined');
        }
        const trReviews = extractTR(html, showId);
        const trRoundupDate = extractRoundupDateFromHtml(html);
        if (trReviews.length > 0) {
          console.log(`    ✓ TR:  ${trReviews.length} reviews from archive${trRoundupDate ? ` (date: ${trRoundupDate})` : ''}`);
          for (const r of trReviews) {
            foundReviews.push({
              outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
              criticName: r.critic || 'Unknown', url: r.url || '',
              excerpt: r.excerpt || '',
              // TR rates shows independently — don't use as outlet's score
              theatreReviewsStars: r.stars ? `${r.stars}/${r.starsOutOf || 5}` : undefined,
              source: 'theatre-reviews', publishDate: trRoundupDate || null,
            });
          }
        }
      } catch {}
    }

    // Stagedoor (SD) — cached JSON
    const sdArchive = path.join(archBase, 'stagedoor', `${showId}.json`);
    if (fs.existsSync(sdArchive)) {
      try {
        const data = JSON.parse(fs.readFileSync(sdArchive, 'utf8'));
        const sdReviews = data.criticReviews || [];
        if (sdReviews.length > 0) {
          console.log(`    ✓ SD:  ${sdReviews.length} reviews from archive`);
          for (const r of sdReviews) {
            foundReviews.push({
              outlet: r.outlet, outletId: normalizeOutlet(r.outlet || ''),
              criticName: 'Unknown', url: '',
              excerpt: r.excerpt || '',
              score: r.stars ? Math.round((r.stars / 5) * 100) : null,
              scoreSource: r.stars ? 'stagedoor-star-rating' : undefined,
              source: 'stagedoor', publishDate: null,
            });
          }
        }
      } catch {}
    }

    // The Stage (TS) — cached HTML
    const { extractReviews: extractTS } = require('./scrape-thestage-roundups');
    const tsArchive = path.join(archBase, 'thestage-roundups', `${showId}.html`);
    if (fs.existsSync(tsArchive)) {
      try {
        const html = fs.readFileSync(tsArchive, 'utf8');
        const tsVal = validateRoundupPageTitle(html, show.title || showId);
        if (!tsVal.ok) {
          console.log(`    ✗ TS archive page-title mismatch (${tsVal.reason}) — quarantining`);
          try { fs.renameSync(tsArchive, tsArchive + '.mismatch'); } catch (e) {}
          throw new Error('quarantined');
        }
        const tsReviews = extractTS(html, showId);
        const tsRoundupDate = extractRoundupDateFromHtml(html);
        if (tsReviews.length > 0) {
          console.log(`    ✓ TS:  ${tsReviews.length} reviews from archive${tsRoundupDate ? ` (date: ${tsRoundupDate})` : ''}`);
          for (const r of tsReviews) {
            foundReviews.push({
              outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
              criticName: r.critic || 'Unknown', url: r.url || '',
              excerpt: r.excerpt || '',
              score: r.stars ? Math.round((r.stars / (r.starsOutOf || 5)) * 100) : null,
              scoreSource: r.stars ? 'thestage-roundup-star-rating' : undefined,
              source: 'thestage-roundup', publishDate: tsRoundupDate || null,
            });
          }
        }
      } catch {}
    }

    const weArchiveTotal = foundReviews.length - (health.lbo.extracted || 0);

    // 1f. WE Aggregators LIVE FETCH (if archives didn't have data)
    // For opening nights: roundups may publish same night or next day.
    // Date-gated: only accept posts published after the show's opening date.
    if (weArchiveTotal === 0) {
      console.log('    No WE archives — trying live fetch...');
      const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY || '';
      const openingDate = show.openingDate ? new Date(show.openingDate) : null;
      // Date floor: 7 days before opening (roundups sometimes publish early)
      const dateFloor = openingDate ? new Date(openingDate.getTime() - 7 * 86400000).toISOString() : null;
      const { extractStarRatings, extractSectionReviews, extractShowTitle, fetchRenderedPageHtml } = require('./scrape-westendtheatre-roundups');

      // WET live fetch: WP API search with date filter
      try {
        const searchTitle = cleanSearchTitle(show.title);
        let apiUrl = `https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=5&search=${encodeURIComponent(searchTitle)}`;
        if (dateFloor) apiUrl += `&after=${dateFloor}`;

        let posts = null;
        // Try curl first, SB fallback
        try {
          const { execFileSync } = require('child_process');
          const raw = execFileSync('curl', ['-s', '-L', apiUrl, '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', '-H', 'Accept: application/json', '--compressed'], { timeout: 15000, encoding: 'utf8' });
          posts = JSON.parse(raw);
        } catch {}
        if (!posts && scrapingBeeKey) {
          try {
            const axios = require('axios');
            const resp = await axios.get('https://app.scrapingbee.com/api/v1', {
              params: { api_key: scrapingBeeKey, url: apiUrl, render_js: 'false' },
              timeout: 20000, responseType: 'text',
            });
            try { posts = JSON.parse(resp.data); } catch {}
          } catch {}
        }

        if (posts && Array.isArray(posts)) {
          for (const post of posts.slice(0, 3)) {
            const wpTitle = (post.title?.rendered || '').replace(/&#8217;/g, "'").replace(/&#8211;/g, '\u2013').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '');
            // Validate the WP post title actually matches our show.
            // Old check used first 8 chars which was too loose (e.g. "op" matched American Psycho for Op Mincemeat).
            // New check: normalize both titles and require significant word overlap.
            const normalizeForMatch = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
            const wpNorm = normalizeForMatch(wpTitle);
            const showNorm = normalizeForMatch(searchTitle);
            const showWords = showNorm.split(' ').filter(w => w.length > 2);
            const matchedWords = showWords.filter(w => wpNorm.includes(w));
            // Require at least 60% of significant words to match, minimum 2 words (or all if title is 1-2 words)
            const minMatch = showWords.length <= 2 ? showWords.length : Math.ceil(showWords.length * 0.6);
            if (matchedWords.length < minMatch) {
              console.log(`    ✗ WET title mismatch: "${wpTitle.slice(0, 60)}" doesn't match "${searchTitle}" (${matchedWords.length}/${showWords.length} words)`);
              continue;
            }

            const htmlContent = post.content?.rendered || '';
            let reviews = extractStarRatings(htmlContent).map(r => ({
              outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
              criticName: r.critic || 'Unknown', url: post.link || '',
              excerpt: r.excerpt || '', stars: r.stars, starsOutOf: 5,
            }));
            if (reviews.length === 0 && post.link) {
              const pageHtml = await fetchRenderedPageHtml(post.link);
              if (pageHtml) {
                reviews = extractSectionReviews(pageHtml).map(r => ({
                  outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
                  criticName: r.critic || 'Unknown', url: r.reviewUrl || post.link || '',
                  excerpt: r.excerpt || '', stars: r.stars, starsOutOf: 5,
                }));
              }
            }
            if (reviews.length > 0) {
              console.log(`    ✓ WET live: ${reviews.length} reviews`);
              for (const r of reviews) {
                foundReviews.push({
                  outlet: r.outlet, outletId: r.outletId,
                  criticName: r.criticName, url: r.url,
                  excerpt: r.excerpt,
                  // WET rates shows independently — don't use as outlet's score
                  wetStars: r.stars ? `${r.stars}/${r.starsOutOf || 5}` : undefined,
                  source: 'westendtheatre', publishDate: post.date || null,
                });
              }
              // Cache for future runs
              const wetArchDir = path.join(archBase, 'westendtheatre');
              if (!fs.existsSync(wetArchDir)) fs.mkdirSync(wetArchDir, { recursive: true });
              fs.writeFileSync(path.join(wetArchDir, `${showId}.json`),
                JSON.stringify({ reviews: reviews.map(r => ({ ...r, source: 'westendtheatre' })), fetchedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
              break;
            }
          }
        }
      } catch (err) {
        console.log(`    WET live fetch error: ${(err.message || '').substring(0, 60)}`);
      }

      // TR live fetch: also WordPress — same WP API pattern
      try {
        const searchTitle = cleanSearchTitle(show.title);
        let apiUrl = `https://theatre.reviews/wp-json/wp/v2/posts?per_page=5&search=${encodeURIComponent(searchTitle)}`;
        if (dateFloor) apiUrl += `&after=${dateFloor}`;

        // theatre.reviews blocks API with CleanTalk — try nodeFetch on homepage link instead
        const trHttp = require('https');
        const homepageHtml = await new Promise(r => {
          trHttp.get('https://theatre.reviews/', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'text/html' },
          }, res => { if (res.statusCode !== 200) { r(null); return; } let d = ''; res.on('data', c => d += c); res.on('end', () => r(d)); }).on('error', () => r(null));
        });

        if (homepageHtml) {
          const cheerio = require('cheerio');
          const $ = cheerio.load(homepageHtml);
          const titleLower = searchTitle.toLowerCase();
          let roundupUrl = null;
          $('a[href*="/reviews-roundup/"]').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            if (text.includes(titleLower.substring(0, 8)) && href.includes('/reviews-roundup/')) {
              roundupUrl = href.startsWith('http') ? href : `https://theatre.reviews${href}`;
              return false;
            }
          });

          if (roundupUrl) {
            const { extractReviews: extractTR } = require('./scrape-theatre-reviews');
            const trPageHtml = await new Promise(r => {
              trHttp.get(roundupUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
              }, res => { if (res.statusCode !== 200) { r(null); return; } let d = ''; res.on('data', c => d += c); res.on('end', () => r(d)); }).on('error', () => r(null));
            });

            if (trPageHtml) {
              const trReviews = extractTR(trPageHtml, showId);
              const trLiveDate = extractRoundupDateFromHtml(trPageHtml);
              if (trReviews.length > 0) {
                console.log(`    ✓ TR live: ${trReviews.length} reviews${trLiveDate ? ` (date: ${trLiveDate})` : ''}`);
                for (const r of trReviews) {
                  foundReviews.push({
                    outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
                    criticName: r.critic || 'Unknown', url: r.url || '',
                    excerpt: r.excerpt || '',
                    // TR rates shows independently — don't use as outlet's score
                    theatreReviewsStars: r.stars ? `${r.stars}/${r.starsOutOf || 5}` : undefined,
                    source: 'theatre-reviews', publishDate: trLiveDate || null,
                  });
                }
                // Cache
                const trArchDir = path.join(archBase, 'theatre-reviews');
                if (!fs.existsSync(trArchDir)) fs.mkdirSync(trArchDir, { recursive: true });
                fs.writeFileSync(path.join(trArchDir, `${showId}.html`), trPageHtml);
              }
            }
          }
        }
      } catch (err) {
        console.log(`    TR live fetch error: ${(err.message || '').substring(0, 60)}`);
      }

      // TS live fetch: SERP to discover URL + BB with cookie auth (no login session)
      const bbApiKey = process.env.BROWSERBASE_API_KEY;
      const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
      const { loadCookiesForDomain: loadStageCookies } = require('./lib/cookie-loader');
      const stageCookies = loadStageCookies('thestage.co.uk');
      if (bbApiKey && bbProjectId && stageCookies) {
        try {
          // SERP to find the roundup URL (shared provider chain: BD first → SB fallback)
          const serpResults = await serpQuery(
            `site:thestage.co.uk/review-round-ups "${show.title}" review round-up`,
            { scrapingBeeKey, nbResults: 3 }
          ).catch(() => null);

          let tsUrl = null;
          if (serpResults) {
            for (const r of serpResults) {
              if (r.url && r.url.includes('review-round-up') && r.url.toLowerCase().includes(show.title.toLowerCase().substring(0, 6))) {
                tsUrl = r.url;
                break;
              }
            }
          }

          if (tsUrl) {
            // BB session with cookie injection (no login — avoids session limit)
            const { chromium } = require('playwright');
            const tsSession = await new Promise((resolve, reject) => {
              const req = require('https').request('https://www.browserbase.com/v1/sessions', {
                method: 'POST',
                headers: { 'x-bb-api-key': bbApiKey, 'Content-Type': 'application/json' },
              }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
              req.on('error', reject);
              req.end(JSON.stringify({ projectId: bbProjectId, keepAlive: true, timeout: 300, browserSettings: { solveCaptchas: true } }));
            });

            const tsBrowser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${bbApiKey}&sessionId=${tsSession.id}`);
            try {
              const tsCtx = tsBrowser.contexts()[0] || await tsBrowser.newContext();
              const tsPage = tsCtx.pages()[0] || await tsCtx.newPage();

              // Inject cookies instead of logging in (avoids creating new sessions)
              const pwCookies = stageCookies.map(c => ({
                name: c.name, value: c.value,
                domain: c.domain || '.thestage.co.uk',
                path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
                ...(c.sameSite ? { sameSite: c.sameSite } : {}),
              }));
              await tsCtx.addCookies(pwCookies);

              // Fetch the roundup page directly (no login needed)
              await tsPage.goto(tsUrl, { waitUntil: 'networkidle', timeout: 30000 });
              await tsPage.waitForTimeout(2000);
              const tsHtml = await tsPage.content();

              if (tsHtml && tsHtml.length > 5000) {
                const { extractReviews: extractTS } = require('./scrape-thestage-roundups');
                const tsReviews = extractTS(tsHtml, showId);
                const tsLiveDate = extractRoundupDateFromHtml(tsHtml);
                if (tsReviews.length > 0) {
                  console.log(`    ✓ TS live: ${tsReviews.length} reviews${tsLiveDate ? ` (date: ${tsLiveDate})` : ''}`);
                  for (const r of tsReviews) {
                    foundReviews.push({
                      outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
                      criticName: r.critic || 'Unknown', url: r.url || '',
                      excerpt: r.excerpt || '',
                      score: r.stars ? Math.round((r.stars / (r.starsOutOf || 5)) * 100) : null,
                      scoreSource: r.stars ? 'thestage-roundup-star-rating' : undefined,
                      source: 'thestage-roundup', publishDate: tsLiveDate || null,
                    });
                  }
                  // Cache
                  const tsArchDir = path.join(archBase, 'thestage-roundups');
                  if (!fs.existsSync(tsArchDir)) fs.mkdirSync(tsArchDir, { recursive: true });
                  fs.writeFileSync(path.join(tsArchDir, `${showId}.html`), tsHtml);
                }
              }
            } finally {
              await tsBrowser.close().catch(() => {});
            }
          }
        } catch (err) {
          console.log(`    TS live fetch error: ${(err.message || '').substring(0, 60)}`);
        }
      }

      // SD: archive-only (Cloudflare + need Stagedoor ID — not feasible for live fetch)
    }

    const weTotal = foundReviews.length - (health.lbo.extracted || 0);
    if (weTotal > 0) console.log(`    WE aggregators total: ${weTotal} reviews`);
    else console.log('    No WE aggregator data found');
  }

  // STEP 1b: Retry SERP for reviews flagged with wrongUrl
  // These reviews got bad URLs during opening-night discovery and have no automated recovery path.
  // Re-SERP them now with targeted per-outlet queries using the review's own metadata.
  {
    const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY || '';
    const brightDataKey = process.env.BRIGHTDATA_TOKEN || '';
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);

    if (aggregatorsOnly || (!scrapingBeeKey && !brightDataKey)) {
      health.wrongUrlRetry.skipped = true;
    } else if (fs.existsSync(showDir)) {
      const reviewFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
      const wrongUrlFiles = [];

      for (const file of reviewFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
          if (data.wrongUrl === true && !data.wrongShow && !data.wrongProduction && !data.duplicateOf) {
            wrongUrlFiles.push({ file, data });
          }
        } catch {}
      }

      health.wrongUrlRetry.found = wrongUrlFiles.length;

      if (wrongUrlFiles.length > 0) {
        const WRONG_URL_BUDGET = 20;
        console.log(`\n[1b/4] Retrying SERP for ${wrongUrlFiles.length} wrongUrl reviews (budget: ${WRONG_URL_BUDGET})...`);

        for (const { file, data } of wrongUrlFiles) {
          if (health.wrongUrlRetry.retried >= WRONG_URL_BUDGET) {
            console.log(`  ⚠ wrongUrl retry budget exhausted (${WRONG_URL_BUDGET})`);
            break;
          }

          const outletId = data.outletId || normalizeOutlet(data.outlet);
          const outletName = data.outlet || outletId;
          process.stdout.write(`  ${outletName} (${file})... `);

          // Build review object for discoverCorrectUrl with critic name for better targeting.
          // Merge in file state (incompleteReason, serpRetryCount, serpRetryAfter,
          // serpDiscoveryAbandoned, filePath) so the lifecycle gate has what it needs.
          const reviewObj = {
            ...data,
            showId,
            outletId,
            outlet: outletName,
            criticName: (data.criticName && data.criticName !== 'Unknown') ? data.criticName : 'Unknown',
            source: 'wrongUrl-retry',
            url: data.url || '', // pass current (bad) URL so SERP skips it
            filePath: path.join(showDir, file),
          };

          // Lifecycle SERP retry gate (defense-in-depth). The wrongUrl filter at
          // line 3489 currently excludes wrongShow/wrongProduction, so gated files
          // (incompleteReason='wrong_content') can't reach here today — but if that
          // filter relaxes, this gate prevents the pathology from recurring here.
          const gate = shouldRetryUrlDiscovery(show, reviewObj);
          if (!gate.shouldRetry) {
            console.log(`✗ gated: ${gate.reason}`);
            if (gate.updates) {
              try {
                Object.assign(data, gate.updates);
                fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n');
              } catch (e) { /* non-fatal */ }
            }
            continue;
          }

          health.wrongUrlRetry.retried++;
          const result = await discoverCorrectUrl(reviewObj, scrapingBeeKey, {
            brightDataKey,
            log: (msg) => process.stdout.write(msg.replace(/^\s+/, '  ') + '\n'),
            forceHistorical: options.historical,
          });

          // Advance SERP attempt state even on failure so perpetually-null responses
          // progress toward abandonment instead of retrying forever.
          try {
            const attemptUpdates = recordSerpAttempt(show, reviewObj);
            if (Object.keys(attemptUpdates).length > 0) {
              Object.assign(data, attemptUpdates);
              fs.writeFileSync(path.join(showDir, file), JSON.stringify(data, null, 2) + '\n');
            }
          } catch (e) { /* non-fatal */ }

          if (result && result !== '__SERP_UNAVAILABLE__' && result !== data.url) {
            console.log(`✓ Found: ${result}`);
            // Update the review file in-place
            const filePath = path.join(showDir, file);
            data.urlCorrectedFrom = data.url;
            data.urlCorrectedReason = 'wrongUrl SERP retry via gather-reviews';
            data.url = result;
            data.urlDiscoveredAt = new Date().toISOString();
            data.urlDiscoveryMethod = 'wrongUrl-serp-retry';
            delete data.wrongUrl;
            delete data.wrongUrlReason;
            // Clear stale content from wrong URL so collect-review-texts refetches
            if (data.wrongFullText) {
              delete data.wrongFullText;
            }
            data.needsRefetch = true;
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
            health.wrongUrlRetry.fixed++;
          } else {
            console.log('✗');
          }

          await sleep(DELAY_MS);
        }

        console.log(`  wrongUrl retries: ${health.wrongUrlRetry.fixed}/${health.wrongUrlRetry.retried} fixed`);
      }
    }
  }

  // STEP 2: Search outlets via Google SERP (ScrapingBee / Bright Data)
  if (aggregatorsOnly) {
    health.serp.skipped = true;
    console.log(`\n[2/4] SKIPPED SERP search (--aggregators-only mode)`);
  } else {
    const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY || '';
    const brightDataKey = process.env.BRIGHTDATA_TOKEN || '';

    if (!scrapingBeeKey && !brightDataKey) {
      health.serp.skipped = true;
      console.log(`\n[2/4] SKIPPED SERP search (no SCRAPINGBEE_API_KEY or BRIGHTDATA_TOKEN)`);
    } else {
      // Build set of outlets already found by aggregators to skip.
      // Only count an outlet as "found" if the URL actually matches the outlet's expected domain.
      // Aggregators sometimes misattribute URLs (e.g. labeling a NYSR URL as "WSJ"), and trusting
      // that misattribution suppresses SERP re-discovery of the real outlet's review.
      const outletDomainMap = new Map(outlets.map(o => [o.id.toLowerCase(), (o.domain || '').toLowerCase()]));
      const foundOutletIds = new Set(
        foundReviews
          .filter(r => {
            const oid = (r.outletId || '').toLowerCase();
            const expectedDomain = outletDomainMap.get(oid);
            if (!expectedDomain || !r.url) return true; // no domain to validate against — keep
            try {
              const urlHost = new URL(r.url).hostname.toLowerCase().replace(/^www\./, '');
              const exp = expectedDomain.replace(/^www\./, '');
              const matches = urlHost === exp || urlHost.endsWith('.' + exp);
              if (!matches) {
                console.log(`  ⚠ Aggregator outlet/URL mismatch: ${oid} URL ${urlHost} ≠ expected ${exp} — will re-search via SERP`);
              }
              return matches;
            } catch { return true; }
          })
          .map(r => (r.outletId || '').toLowerCase())
      );

      // Tier 1 first, then Tier 2, then Tier 3 — filtered by market
      const domainMarketMap = getDomainMarketMap();
      const allOutlets = outlets
        .filter(outlet => {
          if (domainMarketMap.size === 0) return true; // no registry = no filter
          const domain = (outlet.domain || '').toLowerCase();
          const marketInfo = domainMarketMap.get(domain);
          if (!marketInfo) return true;            // unknown outlet → keep (safe default)
          if (marketInfo.isDualMarket) return true; // dual-market → always search
          if (isWestEnd) return marketInfo.region === 'london';
          return marketInfo.region !== 'london';    // BW/OB: exclude london-only
        })
        .sort((a, b) => a.tier - b.tier);

      if (isWestEnd || isOffBroadway) {
        console.log(`  Market filter: ${outlets.length} total → ${allOutlets.length} outlets for ${show.category}`);
      }

      const SERP_BUDGET = 150;
      let serpCallCount = 0;
      // Once both SERP providers are unavailable, every subsequent call will
      // fail the same way. Short-circuit the entire SERP phase instead of
      // burning 50+ outlets × 6 critics of wasted budget + DELAY_MS sleeps.
      let serpUnavailable = false;

      console.log(`\n[2/4] Searching ${allOutlets.length} outlets via SERP (budget: ${SERP_BUDGET})...`);

      for (const outlet of allOutlets) {
        if (serpUnavailable) break;
        if (serpCallCount >= SERP_BUDGET) {
          console.log(`  ⚠ SERP budget exhausted (${SERP_BUDGET} calls)`);
          break;
        }

        const outletIdLower = outlet.id.toLowerCase();
        const criticList = Array.isArray(outlet.critics) ? outlet.critics : [];
        const isMultiCriticOutlet = _shouldQueryPerCritic(outletIdLower, criticList);

        if (isMultiCriticOutlet) {
          // Per-critic SERP queries: each named critic gets their own search so the
          // non-primary critic isn't silently swallowed by Google's top-result bias.
          // Aggregators may have already found 1 critic; compute which critics are
          // still uncovered and only query those (blanket-skip on foundOutletIds
          // would defeat the purpose of per-critic routing).
          const foundForOutlet = foundReviews.filter(r => (r.outletId || '').toLowerCase() === outletIdLower);
          const criticsToQuery = _remainingCritics(criticList, foundForOutlet);
          const aggregatorCovered = foundForOutlet.length > 0;

          if (criticsToQuery.length === 0) {
            console.log(`  ${outlet.name}... ⟳ all ${criticList.length} critics already covered`);
            continue;
          }

          const coverageSuffix = aggregatorCovered
            ? `, ${criticList.length - criticsToQuery.length}/${criticList.length} already via aggregator`
            : '';
          console.log(`  ${outlet.name} (multi-critic: ${criticsToQuery.length} critics to query${coverageSuffix})...`);
          const seenUrlsForOutlet = new Set(
            foundForOutlet.map(r => _normalizeUrlForDedup(r.url)).filter(Boolean)
          );
          let outletHits = 0;
          for (const critic of criticsToQuery) {
            if (serpCallCount >= SERP_BUDGET) {
              console.log(`    ⚠ SERP budget exhausted mid-outlet`);
              break;
            }
            process.stdout.write(`    ↳ ${critic}... `);
            serpCallCount++;
            const result = await searchForReviewViaSERP(showId, outlet, scrapingBeeKey, brightDataKey, {
              historical: options.historical,
              criticName: critic,
            });
            if (result && result.unavailable) {
              console.log('✗ (SERP providers unavailable — aborting SERP phase)');
              serpUnavailable = true;
              break;
            }
            if (result && result.url) {
              const urlKey = _normalizeUrlForDedup(result.url);
              if (seenUrlsForOutlet.has(urlKey)) {
                console.log(`⟳ dup URL`);
              } else {
                seenUrlsForOutlet.add(urlKey);
                outletHits++;
                health.serp.hits++;
                console.log(`✓`);
                foundReviews.push({
                  showId,
                  outletId: outlet.id,
                  outlet: outlet.name,
                  criticName: critic,
                  url: result.url,
                  source: 'serp-discovery-per-critic',
                });
              }
            } else {
              console.log('✗');
            }
            await sleep(DELAY_MS);
          }
          if (serpUnavailable) break;
          // Legacy outlet-level fallback: if no per-critic query hit AND the aggregator
          // hadn't covered this outlet at all, fire a generic outlet query to catch
          // freelancer / guest-critic reviews not in critic-outlets.json. Skip when
          // the aggregator already provided coverage — that would just rediscover
          // the same URL or attribute a duplicate to Unknown.
          if (outletHits === 0 && !aggregatorCovered && serpCallCount < SERP_BUDGET) {
            process.stdout.write(`    ↳ (outlet fallback)... `);
            serpCallCount++;
            const result = await searchForReviewViaSERP(showId, outlet, scrapingBeeKey, brightDataKey, { historical: options.historical });
            if (result && result.unavailable) {
              console.log('✗ (SERP providers unavailable — aborting SERP phase)');
              serpUnavailable = true;
            } else if (result && result.url) {
              health.serp.hits++;
              console.log('✓');
              foundReviews.push({
                showId,
                outletId: outlet.id,
                outlet: outlet.name,
                criticName: 'Unknown',
                url: result.url,
                source: 'serp-discovery',
              });
            } else {
              console.log('✗');
            }
            await sleep(DELAY_MS);
          }
          continue;
        }

        // Non-multi-critic outlets: blanket-skip when the aggregator already
        // found any review. A second generic-query SERP would just rediscover
        // the same URL and burn budget.
        if (foundOutletIds.has(outlet.id.toLowerCase())) {
          console.log(`  ${outlet.name}... ⟳ already found via aggregator`);
          continue;
        }

        process.stdout.write(`  ${outlet.name}... `);
        serpCallCount++;

        const result = await searchForReviewViaSERP(showId, outlet, scrapingBeeKey, brightDataKey, { historical: options.historical });

        if (result && result.unavailable) {
          console.log('✗ (SERP providers unavailable — aborting SERP phase)');
          serpUnavailable = true;
        } else if (result && result.url) {
          health.serp.hits++;
          // For single-critic outlets, default to that critic so saveReview doesn't route
          // to _pending (where reviews never get scored). For multi-critic outlets, leave
          // criticName as Unknown — collect will extract the real byline from the page.
          const isSingleCriticOutlet = outlet.critics && outlet.critics.length === 1;
          const defaultCritic = isSingleCriticOutlet ? outlet.critics[0] : 'Unknown';
          console.log(isSingleCriticOutlet ? `✓ Found (default critic: ${defaultCritic})` : '✓ Found');
          foundReviews.push({
            showId,
            outletId: outlet.id,
            outlet: outlet.name,
            criticName: defaultCritic,
            url: result.url,
            source: 'serp-discovery'
          });
        } else {
          console.log('✗');
        }

        await sleep(DELAY_MS);
      }

      health.serp.calls = serpCallCount;
      console.log(`  SERP calls used: ${serpCallCount}/${SERP_BUDGET}`);
    }
  }

  // STEP 3: Deduplicate and create review files
  console.log('\n[3/4] Deduplicating and creating review files...');

  let created = 0;
  for (const review of foundReviews) {
    if (review.url && !review.needsUrl) {
      // --validate-urls: fetch roundup-sourced URLs and verify the page is about this show.
      // If validation fails, null the URL but keep score/critic data.
      if (options.validateUrls && shouldValidateUrl(review)) {
        try {
          const pageResult = await fetchPage(review.url, { timeout: 15000 });
          if (pageResult && pageResult.content) {
            const validation = await validatePageMatchesShow(pageResult.content, show.title, {
              openingYear: year,
            });
            health.urlValidation.checked++;
            if (!validation.valid) {
              console.log(`    ⚠ URL validation failed for ${review.outlet || review.outletId}: ${validation.reason}`);
              console.log(`      Nulling URL (keeping score/critic): ${review.url}`);
              review.url = null;
              health.urlValidation.nulled++;
            }
          }
          // fetchPage returned null/no HTML — keep URL (innocent until proven guilty)
        } catch (e) {
          // Network error, paywall, etc. — keep URL (innocent until proven guilty)
          console.log(`    ⟳ URL validation fetch failed for ${review.url}: ${e.message} — keeping URL`);
        }
      }

      const result = createReviewFile(showId, review, { allowOffBroadway: isOffBroadway, allowWestEnd: isWestEnd, allowOpera: show.type === 'opera' });
      if (result === true) {
        created++;
      } else if (typeof result === 'string' && health.rejections[result] !== undefined) {
        health.rejections[result]++;
      }
    }
  }

  if (options.validateUrls && health.urlValidation.checked > 0) {
    console.log(`  URL validation: ${health.urlValidation.checked} checked, ${health.urlValidation.nulled} nulled`);
  }

  // [3b/4] Merge BWW excerpt-only reviews into existing files, create stubs for unmatched
  // BWW roundups provide excerpts but no individual URLs, so we merge them into existing files
  // or create stub files for reviews that don't match any existing file
  const rawBwwReviews = foundReviews.filter(r => r.source === 'bww-roundup' && !r.url && r.bwwExcerpt);
  if (rawBwwReviews.length > 0) {
    // Deduplicate BWW reviews by outlet+critic to prevent duplicate stubs from roundup format overlap
    const bwwSeen = new Set();
    const bwwReviews = [];
    for (const r of rawBwwReviews) {
      const key = `${normalizeOutlet(r.outlet || r.outletId)}|${normalizeCritic(r.criticName)}`;
      if (!bwwSeen.has(key)) {
        bwwSeen.add(key);
        bwwReviews.push(r);
      }
    }
    if (bwwReviews.length < rawBwwReviews.length) {
      console.log(`    Deduplicated ${rawBwwReviews.length} → ${bwwReviews.length} BWW excerpts`);
    }

    console.log(`\n[3b/4] Merging ${bwwReviews.length} BWW excerpts into existing files...`);
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    fs.mkdirSync(showDir, { recursive: true });
    const existingFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    let merged = 0;
    let stubsCreated = 0;

    for (const bwwReview of bwwReviews) {
      const criticNorm = normalizeCritic(bwwReview.criticName);
      const outletNorm = normalizeOutlet(bwwReview.outlet || bwwReview.outletId);

      let matched = false;
      for (const file of existingFiles) {
        const expectedPattern = `${outletNorm}--${criticNorm}`;
        if (file.startsWith(expectedPattern + '.json') || file.startsWith(expectedPattern + '-') ||
            file.includes(`--${criticNorm}.json`) || file.includes(`--${criticNorm}-`)) {
          const filePath = path.join(showDir, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

          if (!data.bwwExcerpt) {
            data.bwwExcerpt = bwwReview.bwwExcerpt;
            data.bwwRoundupUrl = bwwReview.bwwRoundupUrl;
            if (bwwReview.bwwThumb) data.bwwThumb = bwwReview.bwwThumb;
            if (!data.sources) data.sources = [];
            if (!data.sources.includes('bww-roundup')) data.sources.push('bww-roundup');

            // Atomic write: .tmp then rename
            const tmpPath = filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
            fs.renameSync(tmpPath, filePath);
            console.log(`    [BWW merged] ${file}`);
            merged++;
          }
          matched = true;
          break;
        }
      }

      // Create stub file for unmatched BWW excerpts
      if (!matched) {
        // Non-Broadway guard for BWW stubs (tours, off-Broadway, film/TV)
        if (isNotBroadway(bwwReview.outlet || bwwReview.outletId || '', { allowOffBroadway: isOffBroadway, allowWestEnd: isWestEnd, allowOpera: show.type === 'opera' })) {
          console.log(`    [BWW skip] Non-Broadway outlet: ${bwwReview.outlet}`);
          continue;
        }

        const filename = generateReviewFilename(bwwReview.outlet || bwwReview.outletId, bwwReview.criticName);
        const filePath = path.join(showDir, filename);

        // Don't overwrite existing files (could exist from a different source or variant outlet ID)
        const existingFile = findExistingReviewFile(showDir, bwwReview.outlet || bwwReview.outletId, bwwReview.criticName);
        if (!existingFile && !fs.existsSync(filePath)) {
          const stub = {
            showId,
            outletId: outletNorm,
            outlet: bwwReview.outlet || outletNorm,
            criticName: bwwReview.criticName,
            url: null,
            publishDate: null,
            fullText: null,
            isFullReview: false,
            bwwExcerpt: bwwReview.bwwExcerpt,
            bwwRoundupUrl: bwwReview.bwwRoundupUrl || null,
            bwwThumb: bwwReview.bwwThumb || null,
            showScoreExcerpt: null,
            contentTier: 'excerpt',
            contentTierReason: 'Only aggregator excerpts available',
            source: 'bww-roundup',
            sources: ['bww-roundup']
          };

          // Atomic write: .tmp then rename
          const tmpPath = filePath + '.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify(stub, null, 2) + '\n');
          fs.renameSync(tmpPath, filePath);
          console.log(`    [BWW stub] ${filename}`);
          stubsCreated++;
        }
      }
    }
    console.log(`    Merged BWW data into ${merged} existing files, created ${stubsCreated} new stubs`);
  }

  // [3c/4] Merge LBO excerpt-only reviews (no URL) into existing files or create stubs
  const lboNoUrlReviews = foundReviews.filter(r => r.source === 'lbo-roundup' && !r.url && r.excerpt);
  if (lboNoUrlReviews.length > 0) {
    console.log(`\n[3c/4] Merging ${lboNoUrlReviews.length} LBO excerpt-only reviews...`);
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    fs.mkdirSync(showDir, { recursive: true });
    const existingFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    let lboMerged = 0, lboStubs = 0;

    for (const lboReview of lboNoUrlReviews) {
      const outletNorm = normalizeOutlet(lboReview.outlet || lboReview.outletId);
      const criticNorm = normalizeCritic(lboReview.criticName);

      let matched = false;
      for (const file of existingFiles) {
        const expectedPattern = `${outletNorm}--${criticNorm}`;
        if (file.startsWith(expectedPattern + '.json') || file.startsWith(expectedPattern + '-') ||
            file.includes(`--${criticNorm}.json`) || file.includes(`--${criticNorm}-`)) {
          const filePath = path.join(showDir, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

          if (!data.lboRoundupExcerpt) {
            data.lboRoundupExcerpt = lboReview.excerpt;
            if (lboReview.score !== null && lboReview.score !== undefined && !data.originalScore && !data.aggregatorStars) {
              data.aggregatorStars = lboReview.score;
              data.scoreSource = 'lbo-star-rating';
              data.scorePriority = 'P0';
            }
            if (!data.sources) data.sources = [];
            if (!data.sources.includes('lbo-roundup')) data.sources.push('lbo-roundup');

            const tmpPath = filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
            fs.renameSync(tmpPath, filePath);
            console.log(`    [LBO merged] ${file}`);
            lboMerged++;
          }
          matched = true;
          break;
        }
      }

      if (!matched) {
        const filename = generateReviewFilename(lboReview.outlet || lboReview.outletId, lboReview.criticName);
        const filePath = path.join(showDir, filename);
        const existingFile = findExistingReviewFile(showDir, lboReview.outlet || lboReview.outletId, lboReview.criticName);
        if (!existingFile && !fs.existsSync(filePath)) {
          const stub = {
            showId,
            outletId: outletNorm,
            outlet: lboReview.outlet || outletNorm,
            criticName: lboReview.criticName,
            url: null,
            publishDate: null,
            fullText: null,
            isFullReview: false,
            lboRoundupExcerpt: lboReview.excerpt,
            originalScore: null,
            aggregatorStars: lboReview.score || null,
            scoreSource: lboReview.score ? 'lbo-star-rating' : null,
            showScoreExcerpt: null,
            contentTier: 'excerpt',
            contentTierReason: 'Only LBO roundup excerpt available',
            source: 'lbo-roundup',
            sources: ['lbo-roundup']
          };
          const tmpPath = filePath + '.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify(stub, null, 2) + '\n');
          fs.renameSync(tmpPath, filePath);
          console.log(`    [LBO stub] ${filename}`);
          lboStubs++;
        }
      }
    }
    console.log(`    Merged LBO data into ${lboMerged} existing files, created ${lboStubs} new stubs`);
  }

  // Per-show health warnings
  const aggHits = [health.dtli, health.showScore, health.bww, health.lbo].filter(a => a.found).length;
  if (aggHits === 0 && show.status === 'open') {
    console.log(`\n⚠️  WARNING: Zero aggregators returned results for ${showId}`);
  }
  if (health.showScore.found && health.showScore.extracted === 0) {
    console.log(`\n⚠️  WARNING: Show Score page found but 0 reviews extracted for ${showId}`);
  }

  // Enhanced summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY for ${showId}`);
  console.log('='.repeat(60));
  console.log(`  Aggregators: DTLI=${health.dtli.extracted}, ShowScore=${health.showScore.extracted}, BWW=${health.bww.extracted}${health.bww.skipped ? ' (skipped)' : ''}, LBO=${health.lbo.extracted}${health.lbo.skipped ? ' (skipped)' : ''}`);
  if (health.wrongUrlRetry.found > 0) {
    console.log(`  wrongUrl retry: ${health.wrongUrlRetry.fixed}/${health.wrongUrlRetry.found} fixed`);
  }
  if (!health.serp.skipped) {
    console.log(`  SERP: ${health.serp.hits}/${health.serp.calls} hits`);
  } else {
    console.log(`  SERP: skipped`);
  }
  const rej = health.rejections;
  const totalRej = rej.junkOutlet + rej.nonBroadway + rej.wrongProduction + rej.duplicate + rej.crossShow + rej.domainMismatch + rej.aggregatorUrlMismatch;
  if (totalRej > 0) {
    console.log(`  Rejections: ${totalRej} (${rej.junkOutlet} junk, ${rej.nonBroadway} non-Broadway, ${rej.wrongProduction} wrongProd, ${rej.duplicate} dupes, ${rej.crossShow} crossShow, ${rej.domainMismatch} domainMismatch, ${rej.aggregatorUrlMismatch} aggregatorUrlMismatch)`);
  }
  console.log(`  Total found: ${foundReviews.length} → Created: ${created} files`);

  return {
    success: true,
    showId,
    reviewsFound: foundReviews.length,
    filesCreated: created,
    health,
  };
}

/**
 * Rebuild reviews.json from review-texts
 */
async function rebuildReviewsJson() {
  console.log('\nRebuilding reviews.json...');

  // Use the existing rebuild script if available
  const rebuildScript = path.join(__dirname, 'rebuild-all-reviews.js');
  if (fs.existsSync(rebuildScript)) {
    const { execSync } = require('child_process');
    try {
      execSync(`node "${rebuildScript}"`, { stdio: 'inherit' });
      console.log('✓ reviews.json rebuilt');
    } catch (e) {
      console.log('⚠️  Failed to rebuild reviews.json:', e.message);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse --shows argument
  const showsArg = args.find(a => a.startsWith('--shows='));
  if (!showsArg) {
    console.log('Usage: node scripts/gather-reviews.js --shows=show-id-1,show-id-2');
    console.log('Example: node scripts/gather-reviews.js --shows=all-out-2025');
    process.exit(1);
  }

  const showIds = showsArg.replace('--shows=', '').split(',').map(s => s.trim());
  const aggregatorsOnly = args.includes('--aggregators-only');
  const validateUrls = args.includes('--validate-urls');
  /**
   * NOTE: For historical shows where SERP yields few/no hits (typically pre-2010
   * Broadway, where Google has deindexed older outlet archives), do NOT implement
   * a Wayback fallback inline here. The repo already has dedicated infrastructure:
   *
   *   - scripts/backfill-review-dates.js — CDX query patterns at ~line 206
   *     ("Archive.org Wayback Machine" fetchFromArchiveOrg) and ~line 384
   *     (date extraction from Wayback snapshots)
   *   - .github/workflows/recover-wayback-reviews.yml — workflow_dispatch
   *     entrypoint for Wayback-based review recovery, scoped by outlet domain
   *     or tier (inputs: source_mode, domain_filter, tier_filter, dry_run)
   *
   * Workflow when SERP returns <3 hits for a historical show — scope by outlet:
   *   gh workflow run recover-wayback-reviews.yml \
   *     -f source_mode=failed-fetches \
   *     -f domain_filter=nytimes.com,variety.com
   *
   * Or run dry-run first to see candidates without writing files:
   *   gh workflow run recover-wayback-reviews.yml -f dry_run=true
   *
   * Inline Wayback in this file would duplicate that infrastructure and add a
   * second discovery path to maintain. See plan-review notes from Joe Turner
   * 2009 historical recovery (2026-04-26).
   */
  const historical = args.includes('--historical');

  console.log('========================================');
  console.log('Broadway Review Gatherer');
  console.log('========================================');
  console.log(`Shows to process: ${showIds.join(', ')}`);
  console.log(`Mode: ${aggregatorsOnly ? 'Aggregators only (fast)' : 'Full (aggregators + SERP discovery)'}`);
  if (historical) {
    console.log('Historical mode: ON (date filter skipped from first query — better for pre-2005 shows)');
  }
  if (validateUrls) {
    console.log('URL validation: ON (roundup-sourced URLs will be content-checked)');
  }
  if (!aggregatorsOnly) {
    console.log(`SCRAPINGBEE_API_KEY: ${process.env.SCRAPINGBEE_API_KEY ? 'Set' : 'NOT SET'}`);
    console.log(`BRIGHTDATA_TOKEN: ${process.env.BRIGHTDATA_TOKEN ? 'Set' : 'NOT SET'}`);
  }

  const results = [];

  for (const showId of showIds) {
    let result;
    try {
      result = await gatherReviewsForShow(showId, aggregatorsOnly, { validateUrls, historical });
    } catch (err) {
      console.error(`✗ Unhandled error for ${showId}: ${err.message}`);
      result = { showId, success: false, error: err.message, reviewsFound: 0, filesCreated: 0 };
    }
    results.push(result);
    await sleep(2000); // Delay between shows
  }

  // Rebuild reviews.json (skip in aggregators-only mode — caller rebuilds once at end)
  if (aggregatorsOnly) {
    console.log('\nSkipping rebuild (--aggregators-only mode)');
  } else {
    await rebuildReviewsJson();
  }

  // Final per-show summary
  console.log('\n========================================');
  console.log('FINAL SUMMARY');
  console.log('========================================');
  for (const r of results) {
    if (r.skipped) {
      console.log(`⟳ ${r.showId}: skipped (${r.reason})`);
    } else if (r.success) {
      console.log(`✓ ${r.showId}: ${r.reviewsFound} found, ${r.filesCreated} created`);
    } else {
      console.log(`✗ ${r.showId}: ${r.error}`);
    }
  }

  // Batch health report — aggregator hit rates catch systemic failures
  const healthResults = results.filter(r => r.health);
  if (healthResults.length >= 1) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('BATCH HEALTH REPORT');
    console.log('═'.repeat(60));
    console.log(`Shows processed: ${results.length} (${healthResults.length} with health data)`);

    // Category breakdown
    const categories = {};
    for (const r of healthResults) {
      const cat = r.health.category || 'unknown';
      categories[cat] = (categories[cat] || 0) + 1;
    }
    console.log(`  By category: ${Object.entries(categories).map(([k, v]) => `${k}=${v}`).join(', ')}`);

    // Aggregator hit rates per category
    for (const cat of Object.keys(categories)) {
      const catResults = healthResults.filter(r => r.health.category === cat);
      const dtliHits = catResults.filter(r => r.health.dtli.found).length;
      const ssHits = catResults.filter(r => r.health.showScore.found).length;
      const ssExtracted0 = catResults.filter(r => r.health.showScore.found && r.health.showScore.extracted === 0).length;
      const bwwHits = catResults.filter(r => r.health.bww.found).length;
      const bwwSkipped = catResults.filter(r => r.health.bww.skipped).length;
      const lboHits = catResults.filter(r => r.health.lbo && r.health.lbo.found).length;
      const lboSkipped = catResults.filter(r => r.health.lbo && r.health.lbo.skipped).length;
      const zeroAgg = catResults.filter(r =>
        !r.health.dtli.found && !r.health.showScore.found && !r.health.bww.found && !(r.health.lbo && r.health.lbo.found) && r.health.status === 'open'
      ).length;

      console.log(`\n  ${cat} (${catResults.length} shows):`);
      console.log(`    DTLI: ${dtliHits}/${catResults.length} (${Math.round(100 * dtliHits / catResults.length)}%)`);
      console.log(`    ShowScore: ${ssHits}/${catResults.length} (${Math.round(100 * ssHits / catResults.length)}%)${ssExtracted0 > 0 ? ` ⚠️ ${ssExtracted0} found but 0 extracted` : ''}`);
      if (bwwSkipped === catResults.length) {
        console.log(`    BWW: skipped (all ${cat})`);
      } else {
        console.log(`    BWW: ${bwwHits}/${catResults.length - bwwSkipped} (${catResults.length - bwwSkipped > 0 ? Math.round(100 * bwwHits / (catResults.length - bwwSkipped)) : 0}%)`);
      }
      if (lboSkipped < catResults.length) {
        console.log(`    LBO: ${lboHits}/${catResults.length - lboSkipped} (${catResults.length - lboSkipped > 0 ? Math.round(100 * lboHits / (catResults.length - lboSkipped)) : 0}%)`);
      }
      if (zeroAgg > 0) {
        console.log(`    ⚠️  ${zeroAgg} open shows with ZERO aggregator hits`);
      }
    }

    // Total URL validation stats
    const totalUrlChecked = healthResults.reduce((s, r) => s + (r.health.urlValidation ? r.health.urlValidation.checked : 0), 0);
    const totalUrlNulled = healthResults.reduce((s, r) => s + (r.health.urlValidation ? r.health.urlValidation.nulled : 0), 0);
    if (totalUrlChecked > 0) {
      console.log(`\n  URL validation: ${totalUrlChecked} checked, ${totalUrlNulled} nulled (${Math.round(100 * totalUrlNulled / totalUrlChecked)}% rejection rate)`);
    }

    // Total wrongUrl retry stats
    const totalWrongUrlFound = healthResults.reduce((s, r) => s + r.health.wrongUrlRetry.found, 0);
    const totalWrongUrlFixed = healthResults.reduce((s, r) => s + r.health.wrongUrlRetry.fixed, 0);
    if (totalWrongUrlFound > 0) {
      console.log(`\n  wrongUrl retries: ${totalWrongUrlFixed}/${totalWrongUrlFound} fixed`);
    }

    // Total SERP stats
    const totalSerpCalls = healthResults.reduce((s, r) => s + r.health.serp.calls, 0);
    const totalSerpHits = healthResults.reduce((s, r) => s + r.health.serp.hits, 0);
    if (totalSerpCalls > 0) {
      console.log(`\n  SERP totals: ${totalSerpHits}/${totalSerpCalls} hits (${Math.round(100 * totalSerpHits / totalSerpCalls)}%)`);
    }

    // Total rejection stats
    const totalRej = healthResults.reduce((s, r) => {
      const rej = r.health.rejections || {};
      return {
        junkOutlet: s.junkOutlet + (rej.junkOutlet || 0),
        nonBroadway: s.nonBroadway + (rej.nonBroadway || 0),
        wrongProduction: s.wrongProduction + (rej.wrongProduction || 0),
        duplicate: s.duplicate + (rej.duplicate || 0),
        crossShow: s.crossShow + (rej.crossShow || 0),
      };
    }, { junkOutlet: 0, nonBroadway: 0, wrongProduction: 0, duplicate: 0, crossShow: 0, domainMismatch: 0 });
    const rejTotal = totalRej.junkOutlet + totalRej.nonBroadway + totalRej.wrongProduction + totalRej.duplicate + totalRej.crossShow + totalRej.domainMismatch;
    if (rejTotal > 0) {
      console.log(`\n  Rejections: ${rejTotal} total (${totalRej.junkOutlet} junk, ${totalRej.nonBroadway} non-Broadway, ${totalRej.wrongProduction} wrongProd, ${totalRej.duplicate} dupes, ${totalRej.crossShow} crossShow, ${totalRej.domainMismatch} domainMismatch)`);
    }

    console.log('═'.repeat(60));
  }

  // Set output for GitHub Actions
  const totalCreated = results.reduce((sum, r) => sum + (r.filesCreated || 0), 0);
  console.log(`\nshows_processed=${results.length}`);
  console.log(`reviews_created=${totalCreated}`);
}

// Allow importing as a module (for opening-night-poller.js) without running CLI
if (require.main === module) {
  main().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  searchDTLI,
  searchShowScore,
  searchBWWRoundup,
  extractDTLIReviews,
  extractShowScoreReviews,
  extractBWWRoundupReviews,
  sanitizeBwwJsonLd,
  validateBWWRoundupYear,
  validateBWWRoundupGeography,
  createReviewFile,
  gatherReviewsForShow,
  loadShowData,
  getGlobalUrlIndex,
  shouldValidateUrl,
  ROUNDUP_URL_SOURCES,
  detectCrossShowUrlMismatch,
  __test__loadOutlets: loadOutlets,
};
