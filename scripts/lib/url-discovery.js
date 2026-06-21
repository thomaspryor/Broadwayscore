/**
 * URL Discovery via Google SERP (shared module)
 *
 * Default provider chain: Bright Data ($0.0015/q, async 4-20s) → ScrapingBee (25 credits/q, sync 1-3s).
 * With preferSpeed=true: ScrapingBee first → Bright Data fallback.
 *
 * Used by:
 * - collect-review-texts.js (full text collection — has its own inline copy)
 * - rediscover-review-urls.js (URL rediscovery pre-processing)
 * - opening-night-poller.js (time-sensitive — uses preferSpeed=true)
 */

const fs = require('fs');
const path = require('path');
const scraper = require('./scraper');
const { domainMatchesExpected, setRegistryDomainAliases } = scraper;
const { isUrlYearOutsideWindow, hasTryoutUrlMarker } = require('./content-filters');
const { isLondonMarket } = require('./venue-classification');
const { urlLooksLikeReview, isSluglessReviewUrl } = require('./review-guards');
const { validateSerpCandidate } = require('./serp-candidate-validator');
const { recordBdCall, recordSdCall } = require('./bd-telemetry');

// Scrapingdog SERP — flag-gated cheap primary ahead of BD/SB SERP. Google Light
// Search = 5 credits (~$0.45/1k) vs BD SERP (~$1.50/1k). Default OFF.
const SCRAPINGDOG_API_KEY = process.env.SCRAPINGDOG_API_KEY;
const USE_SCRAPINGDOG = process.env.SCRAPER_USE_SCRAPINGDOG === '1';

// Derive outlet-to-domain mapping from outlet-registry.json (single source of truth)
// Maps outlet IDs + aliases → primary domain for SERP URL discovery
// Also builds domainAliases map for domain matching (e.g., 1minutecritic.com → oneminutecritic.com)
function buildOutletDomains() {
  const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const outlets = registry.outlets || registry;
  const map = {};
  const aliasMap = {}; // domain → Set of equivalent domains (from domainAliases)
  for (const [id, o] of Object.entries(outlets)) {
    if (!o.domain) continue;
    map[id] = o.domain;
    if (o.aliases) {
      for (const alias of o.aliases) {
        map[alias] = o.domain;
      }
    }
    // Build domain alias groups from registry's domainAliases field
    if (o.domainAliases && o.domainAliases.length > 0) {
      const allDomains = [o.domain, ...o.domainAliases];
      for (const d of allDomains) {
        if (!aliasMap[d]) aliasMap[d] = new Set();
        for (const other of allDomains) {
          if (other !== d) aliasMap[d].add(other);
        }
      }
    }
  }
  return { map, aliasMap };
}

const { map: OUTLET_DOMAINS, aliasMap: REGISTRY_DOMAIN_ALIASES } = buildOutletDomains();

// Build a Google `site:` clause covering a domain AND its registry domainAliases.
// Outlets often publish on an alias TLD (theatreandtonic.com primary vs .co.uk live;
// londontheatrereviews.co.uk primary vs londontheatre.co.uk live); a single-domain
// query returns 0 and the review is silently missed (A Life in Four Seasons,
// 2026-06-16). Pure + exported so it's unit-testable. aliasOverride lets tests inject.
function buildSiteClause(domain, aliasOverride) {
  // Sanitize: a domain must be a non-empty token with no whitespace (a space would
  // emit malformed `site:foo bar`). Dedupe so alias===primary can't yield
  // `(site:a OR site:a)`. Returns '' for an unusable primary domain.
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const primary = clean(domain);
  if (!primary || /\s/.test(primary)) return '';
  const aliases = aliasOverride || REGISTRY_DOMAIN_ALIASES[domain];
  const aliasArr = aliases instanceof Set ? [...aliases] : (aliases || []);
  const domains = [...new Set([primary, ...aliasArr.map(clean)].filter(d => d && !/\s/.test(d)))];
  return domains.length > 1
    ? `(${domains.map(x => `site:${x}`).join(' OR ')})`
    : `site:${domains[0]}`;
}

// Inject registry domain aliases into scraper.js for domainMatchesExpected()
setRegistryDomainAliases(REGISTRY_DOMAIN_ALIASES);

// Known domain redirects (old domain → new domain)
const DOMAIN_REDIRECTS = {
  'huffingtonpost.com': 'huffpost.com',
  'www.huffingtonpost.com': 'www.huffpost.com',
};

let _showsJsonCache = null;

// Per-show tryout/TV/film/world-premiere URL rejection counter.
// Keyed by showId (or '__global__' when no showId available).
// Exposed via getTryoutRejectionStats() for instrumentation / broadcast-time audit.
const _tryoutRejections = new Map();
function _recordTryoutRejection(showId, marker, url) {
  const key = showId || '__global__';
  if (!_tryoutRejections.has(key)) _tryoutRejections.set(key, []);
  _tryoutRejections.get(key).push({ marker, url });
}

function getTryoutRejectionStats() {
  const out = {};
  for (const [showId, entries] of _tryoutRejections.entries()) {
    out[showId] = { count: entries.length, entries };
  }
  return out;
}

function resetTryoutRejectionStats() {
  _tryoutRejections.clear();
}

/**
 * Look up show title and year from shows.json
 */
function getShowInfo(showId) {
  try {
    if (!_showsJsonCache) {
      _showsJsonCache = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/shows.json'), 'utf8'));
    }
    const showEntry = _showsJsonCache.shows.find(s => s.id === showId);
    if (showEntry) {
      const leadActor = Array.isArray(showEntry.cast) && showEntry.cast.length > 0
        ? showEntry.cast[0].name : null;
      return {
        id: showEntry.id,
        title: showEntry.title,
        year: (showEntry.openingDate || '').substring(0, 4),
        category: showEntry.category || 'broadway',
        openingDate: showEntry.openingDate || null,
        closingDate: showEntry.closingDate || null,
        previewsStartDate: showEntry.previewsStartDate || null,
        venue: showEntry.venue || showEntry.theater || null,
        cast: Array.isArray(showEntry.cast) ? showEntry.cast : [],
        leadActor,
      };
    }
  } catch (e) { /* fall through */ }

  // Fallback to slug-derived. Populate enough fields that downstream
  // consumers (notably validateSerpCandidate) can reason about market /
  // venue without crashing on missing keys. Default category to broadway
  // because slug-only paths are almost always Broadway/OB rediscovery.
  const title = (showId || '').replace(/-\d{4}$/, '').replace(/-/g, ' ');
  const yearMatch = (showId || '').match(/-(\d{4})$/);
  return {
    id: showId || null,
    title: title || null,
    year: yearMatch ? yearMatch[1] : '',
    category: 'broadway',
    openingDate: null,
    closingDate: null,
    previewsStartDate: null,
    venue: null,
    cast: [],
    leadActor: null,
  };
}

// ============================================================================
// SERP Providers
// ============================================================================

let _scrapingBeeSerpExhausted = false;
let _brightDataConsecutiveFailures = 0;
let _scrapingdogSerpFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;

// Rolling window health tracking for ScrapingBee SERP
const _scrapingBeeSerpResults = []; // true=success, false=failure
const ROLLING_WINDOW_SIZE = 20;
const ROLLING_FAILURE_THRESHOLD = 0.6; // disable if 60%+ failures
function _recordSerpResult(success) {
  _scrapingBeeSerpResults.push(success);
  if (_scrapingBeeSerpResults.length > ROLLING_WINDOW_SIZE) _scrapingBeeSerpResults.shift();
  if (_scrapingBeeSerpResults.length >= ROLLING_WINDOW_SIZE) {
    const failures = _scrapingBeeSerpResults.filter(r => !r).length;
    if (failures / ROLLING_WINDOW_SIZE >= ROLLING_FAILURE_THRESHOLD) {
      _scrapingBeeSerpExhausted = true;
    }
  }
}

/**
 * Search via ScrapingBee SERP API (returns structured JSON).
 * @param {string} query - Google search query
 * @param {string} apiKey - ScrapingBee API key
 * @param {Function} log - Logging function
 * @param {{ dateMin: Date, dateMax: Date }} [dateRange] - Optional date range filter
 * @returns {Array<{url: string, title: string}>|null} organic results, or null if provider unavailable
 */
// Geo derivation: explicit override > heuristic. Slug-discovery and other UK-
// only callers pass `geo: 'gb'` explicitly because their query strings don't
// contain the literal "West End" trigger word.
function _resolveGeo(query, override) {
  if (override) return override;
  return query.includes('West End') ? 'gb' : 'us';
}

/**
 * Search via Scrapingdog's Google endpoint (structured JSON, synchronous).
 * Returns [{url, title, snippet}] or null if unavailable/failed (so the chain
 * falls through to BD/SB). Bake-off 2026-06-21 confirmed clean organic results.
 */
async function _serpViaScrapingdog(query, log, dateRange, geo) {
  // Circuit breaker (mirrors BD/SB SERP): once Scrapingdog SERP has failed
  // MAX_CONSECUTIVE_FAILURES times in a row this run, stop trying it first so a
  // degraded provider doesn't burn a credit + latency on every query before the
  // BD/SB fallback runs. Resets to 0 on any success.
  if (!USE_SCRAPINGDOG || !SCRAPINGDOG_API_KEY || _scrapingdogSerpFailures >= MAX_CONSECUTIVE_FAILURES) return null;
  const axios = require('axios');
  let q = query;
  if (dateRange) {
    const fmtD = d => d.toISOString().split('T')[0];
    q += ` after:${fmtD(dateRange.dateMin)} before:${fmtD(dateRange.dateMax)}`;
  }
  try {
    const response = await axios.get('https://api.scrapingdog.com/google/', {
      params: { api_key: SCRAPINGDOG_API_KEY, query: q, results: 10, country: geo || 'us' },
      timeout: 30000,
    });
    const data = response.data || {};
    const organic = data.organic_results || data.organic_data || [];
    _scrapingdogSerpFailures = 0;
    recordSdCall({ host: 'serp.scrapingdog', fn: 'serp', success: true, status: 200, credits: 5 });
    return organic.slice(0, 10).map(r => ({
      url: r.link || r.url || '',
      title: r.title || '',
      snippet: r.description || r.snippet || '',
    })).filter(r => r.url);
  } catch (error) {
    _scrapingdogSerpFailures++;
    recordSdCall({ host: 'serp.scrapingdog', fn: 'serp', success: false, status: error.response?.status || (error.message || 'error').slice(0, 80), credits: 5 });
    log(`    ✗ Scrapingdog SERP error (${_scrapingdogSerpFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message} — falling back to BD/SB`);
    return null;
  }
}

async function _serpViaScrapingBee(query, apiKey, log, dateRange) {
  if (_scrapingBeeSerpExhausted || !apiKey || scraper.sbCreditsLow) return null;

  const axios = require('axios');
  const RETRYABLE_STATUSES = new Set([500, 502, 503]);
  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const params = { api_key: apiKey, search: query };
      if (dateRange) {
        // Use Google's after:/before: operators (ScrapingBee doesn't support tbs param)
        const fmtD = d => d.toISOString().split('T')[0];
        params.search += ` after:${fmtD(dateRange.dateMin)} before:${fmtD(dateRange.dateMax)}`;
      }
      const response = await axios.get('https://app.scrapingbee.com/api/v1/store/google', {
        params,
        timeout: 30000,
      });
      const data = response.data;
      _recordSerpResult(true);
      return (data.organic_results || data.results || []).map(r => ({
        url: r.url || r.link,
        title: r.title || '',
        snippet: r.description || r.snippet || '',
      }));
    } catch (error) {
      const status = error.response?.status;
      if (status === 401 || status === 403 || status === 429) {
        _scrapingBeeSerpExhausted = true;
        log(`    ⚠ ScrapingBee SERP exhausted (${status}) — falling back to Bright Data`);
        return null;
      }
      // Retry on 500-series errors
      if (RETRYABLE_STATUSES.has(status) && attempt < MAX_ATTEMPTS) {
        log(`    ↻ ScrapingBee SERP ${status}, retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      _recordSerpResult(false);
      const failCount = _scrapingBeeSerpResults.filter(r => !r).length;
      log(`    ✗ ScrapingBee SERP error (${failCount}/${ROLLING_WINDOW_SIZE} recent failures): ${error.message}`);
      if (_scrapingBeeSerpExhausted) {
        log(`    ⚠ ScrapingBee SERP disabled — ${Math.round(failCount / ROLLING_WINDOW_SIZE * 100)}% failure rate exceeds threshold`);
      }
      return null;
    }
  }
  return null;
}

/**
 * Search via Bright Data SERP API (structured JSON, async polling).
 * Falls back to Web Unlocker (HTML parsing) if SERP API unavailable.
 * @param {string} query - Google search query
 * @param {string} apiKey - Bright Data API token
 * @param {Function} log - Logging function
 * @param {{ dateMin: Date, dateMax: Date }} [dateRange] - Optional date range filter
 * @returns {Array<{url: string, title: string}>|null} organic results, or null if provider unavailable
 */
async function _serpViaBrightData(query, apiKey, log, dateRange, geo) {
  if (!apiKey || _brightDataConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;

  const fmtD = d => d.toISOString().split('T')[0];
  const dateQuery = dateRange ? ` after:${fmtD(dateRange.dateMin)} before:${fmtD(dateRange.dateMax)}` : '';
  const fullQuery = query + dateQuery;

  // Try synchronous SERP API first (fastest, returns structured JSON directly)
  const syncResult = await _serpViaBrightDataWebUnlocker(fullQuery, apiKey, log, geo);
  if (syncResult !== null) return syncResult;

  // Fallback: async SERP API (polling-based, slower but more reliable)
  return _serpViaBrightDataSerpApi(fullQuery, apiKey, log, geo);
}

const _BD_CUSTOMER = process.env.BRIGHTDATA_CUSTOMER || 'hl_a2c64a47';
const _BD_SERP_ZONE = process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1';

async function _serpViaBrightDataSerpApi(query, apiKey, log, geoOverride) {
  try {
    // Use Google UK for West End queries, Google US for Broadway/OB
    // (explicit override wins — see _resolveGeo for UK-only slug-discovery callers)
    const geo = _resolveGeo(query, geoOverride);
    const submitRes = await fetch(
      `https://api.brightdata.com/serp/req?customer=${_BD_CUSTOMER}&zone=${_BD_SERP_ZONE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: { q: query, gl: geo } }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!submitRes.ok) {
      _brightDataConsecutiveFailures++;
      log(`    ✗ BD SERP API submit ${submitRes.status} (${_brightDataConsecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) — trying Web Unlocker`);
      recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: false, status: submitRes.status });
      return null; // Fall through to Web Unlocker
    }
    const submitData = await submitRes.json();
    const responseId = submitData.response_id;
    if (!responseId) {
      _brightDataConsecutiveFailures++;
      recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: false, status: 'no_response_id' });
      return null;
    }

    // Poll for results (max 20s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(
        `https://api.brightdata.com/serp/get_result?customer=${_BD_CUSTOMER}&zone=${_BD_SERP_ZONE}&response_id=${responseId}`,
        {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (pollRes.status === 202) continue;
      if (!pollRes.ok) {
        _brightDataConsecutiveFailures++;
        recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: false, status: pollRes.status });
        return null;
      }
      const data = await pollRes.json();
      if (data.organic) {
        _brightDataConsecutiveFailures = 0;
        recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: true, status: 200 });
        return data.organic.slice(0, 10).map(r => ({
          url: r.link || r.url || '',
          title: r.title || '',
          snippet: r.description || r.snippet || '',
        }));
      }
      if (data.response_id) continue;
      _brightDataConsecutiveFailures = 0;
      recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: true, status: 'empty' });
      return [];
    }
    _brightDataConsecutiveFailures++;
    log('    ⚠ BD SERP API timeout (20s) — trying Web Unlocker');
    recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: false, status: 'timeout' });
    return null;
  } catch (error) {
    _brightDataConsecutiveFailures++;
    log(`    ✗ BD SERP API error: ${error.message} — trying Web Unlocker`);
    recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: false, status: error.message?.slice(0, 80) || 'error' });
    return null;
  }
}

async function _serpViaBrightDataWebUnlocker(query, apiKey, log, geoOverride) {
  const axios = require('axios');
  // Use SERP zone — Web Unlocker (mcp_unlocker) can't access Google Search
  const geo = _resolveGeo(query, geoOverride);
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en&gl=${geo}`;

  try {
    const response = await axios.post('https://api.brightdata.com/request', {
      zone: _BD_SERP_ZONE,
      url: googleUrl,
      format: 'raw',
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 30000,
    });

    const data = response.data;

    // Structured JSON response (unlikely from Web Unlocker but handle it)
    if (data && typeof data === 'object' && Array.isArray(data.organic)) {
      _brightDataConsecutiveFailures = 0;
      recordBdCall({ host: 'serp.brightdata', fn: 'serp-unlocker', success: true, status: 200, fallbackFrom: 'serp-api' });
      return data.organic.slice(0, 10).map(r => ({
        url: r.link || r.url || '',
        title: r.title || '',
        snippet: r.description || r.snippet || '',
      }));
    }

    // Raw HTML — parse with regex
    const html = typeof data === 'string' ? data : '';
    if (!html || html.length < 500) {
      recordBdCall({ host: 'serp.brightdata', fn: 'serp-unlocker', success: false, status: 'short_html', fallbackFrom: 'serp-api' });
      return [];
    }

    const results = [];
    const hrefRegex = /href="(https?:\/\/(?!(?:www\.)?google\.)[^"]+)"/g;
    const titleRegex = /<h3[^>]*>([^<]+)<\/h3>/g;
    let match;

    const seenUrls = new Set();
    while ((match = hrefRegex.exec(html)) !== null) {
      let url = match[1];
      if (url.includes('/url?q=')) {
        try { url = new URL(url).searchParams.get('q') || url; } catch (e) {}
      }
      if (url.includes('google.com') || url.includes('googleapis.com')) continue;
      if (url.includes('webcache.') || url.includes('translate.')) continue;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      results.push({ url, title: '' });
    }

    let titleIdx = 0;
    while ((match = titleRegex.exec(html)) !== null && titleIdx < results.length) {
      results[titleIdx].title = match[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      titleIdx++;
    }

    _brightDataConsecutiveFailures = 0;
    recordBdCall({ host: 'serp.brightdata', fn: 'serp-unlocker', success: true, status: 200, fallbackFrom: 'serp-api' });
    return results.slice(0, 10);
  } catch (error) {
    _brightDataConsecutiveFailures++;
    log(`    ✗ Bright Data Web Unlocker error (${_brightDataConsecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message}`);
    if (_brightDataConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`    ⚠ Bright Data SERP disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
    }
    recordBdCall({ host: 'serp.brightdata', fn: 'serp-unlocker', success: false, status: error.message?.slice(0, 80) || 'error', fallbackFrom: 'serp-api' });
    return null;
  }
}

// ============================================================================
// SERP provider chain helper
// ============================================================================

/**
 * Try SERP providers in order based on preferSpeed flag.
 * Default (preferSpeed=false): BrightData first (cheap), ScrapingBee fallback (fast).
 * preferSpeed=true: ScrapingBee first (sync ~1-3s), BrightData fallback.
 *
 * @returns {{ results: Array|null, provider: string }}
 *   results=null means both providers are down; []=searched but nothing found.
 */
const _serpCache = require('./serp-cache');

async function _serpWithChain(query, scrapingBeeKey, brightDataKey, log, dateRange, preferSpeed, geoOverride) {
  // 24h disk cache — same query within TTL returns cached results, no API call.
  // Cuts duplicate SERP spend across orchestrator iterations, poller dispatches,
  // gather-reviews runs targeting the same shows. See scripts/lib/serp-cache.js.
  //
  // dateMax is rounded to weekly buckets in the cache key (downstream SERP call
  // still uses the precise dateMax). Without this, calculateDateWindow's
  // now+30d window made the cache key churn daily on every open show — neutering
  // the cache for the highest-volume case. Weekly buckets keep results stable
  // enough that one cached snapshot serves a whole week of queries with near-
  // identical Google windows.
  const _weeklyBucket = (d) => {
    if (!d) return '';
    const wkMs = 7 * 24 * 60 * 60 * 1000;
    return new Date(Math.floor(d.getTime() / wkMs) * wkMs).toISOString().split('T')[0];
  };
  const resolvedGeo = _resolveGeo(query, geoOverride);
  const cacheOpts = {
    geo: resolvedGeo,
    dateMin: dateRange ? dateRange.dateMin.toISOString().split('T')[0] : '',
    dateMax: dateRange ? _weeklyBucket(dateRange.dateMax) : '',
  };
  const cached = _serpCache.get(query, cacheOpts);
  if (cached) {
    log(`    📦 SERP cache hit: "${query.slice(0, 60)}..."`);
    return { results: cached.results, provider: `${cached.provider}-cached` };
  }

  // Scrapingdog first (flag-gated, ~3x cheaper than BD SERP). On null/empty it
  // falls through to the existing BD/SB chain, which stays as the safety net.
  if (USE_SCRAPINGDOG && SCRAPINGDOG_API_KEY) {
    const sdResults = await _serpViaScrapingdog(query, log, dateRange, resolvedGeo);
    if (sdResults && sdResults.length > 0) {
      if (!(preferSpeed && sdResults.length === 0)) {
        _serpCache.set(query, cacheOpts, { results: sdResults, provider: 'scrapingdog' });
      }
      return { results: sdResults, provider: 'scrapingdog' };
    }
  }

  const primary = preferSpeed
    ? { fn: _serpViaScrapingBee, key: scrapingBeeKey, name: 'scrapingbee' }
    : { fn: _serpViaBrightData, key: brightDataKey, name: 'brightdata' };
  const fallback = preferSpeed
    ? { fn: _serpViaBrightData, key: brightDataKey, name: 'brightdata' }
    : { fn: _serpViaScrapingBee, key: scrapingBeeKey, name: 'scrapingbee' };

  // Geo override only flows to BD providers — ScrapingBee's SERP endpoint does
  // not accept a country param (its /store/google endpoint geo-localizes by SB's
  // own proxy pool, not by a request param). Pass undefined to SB to keep the
  // existing behavior.
  const bdGeo = geoOverride;
  const _withGeo = (fn) => (q, k, l, dr) => (fn === _serpViaBrightData
    ? fn(q, k, l, dr, bdGeo)
    : fn(q, k, l, dr));

  let results = await _withGeo(primary.fn)(query, primary.key, log, dateRange);
  let provider = primary.name;
  if (!results || results.length === 0) {
    const fbResults = await _withGeo(fallback.fn)(query, fallback.key, log, dateRange);
    if (fbResults && fbResults.length > 0) {
      results = fbResults;
      provider = fallback.name;
    } else if (!results && !fbResults) {
      results = null; // Both providers down
    }
  }

  // Cache successful results. Empty arrays ARE cached for routine flows because
  // "no organic results" is a stable answer. EXCEPTION: during opening-night
  // polling (preferSpeed=true), an empty array often means "review hasn't
  // dropped yet" — caching it would hide a freshly-published review for up to
  // 24h. So we skip caching empty results on the opening-night path; routine
  // gather-reviews scans still benefit from negative caching.
  const shouldCache = results !== null && !(preferSpeed && results.length === 0);
  if (shouldCache) {
    _serpCache.set(query, cacheOpts, { results, provider });
  }
  return { results, provider };
}

// ============================================================================
// Main discovery function
// ============================================================================

/**
 * Discover correct URL for a review via Google SERP search.
 * Default provider chain: Bright Data (cheap) → ScrapingBee (fast fallback).
 * With preferSpeed=true: ScrapingBee (fast) → Bright Data (fallback).
 *
 * @param {Object} review - Review object with showId, outletId, outlet, url
 * @param {string} scrapingBeeKey - ScrapingBee API key (can be empty)
 * @param {Object} [options] - Optional settings
 * @param {string} [options.brightDataKey] - Bright Data API token (fallback provider)
 * @param {Function} [options.log] - Logging function (default: console.log)
 * @param {{ dateMin: Date, dateMax: Date }} [options.dateRange] - Optional date range for Google's tbs filter
 * @param {boolean} [options.returnMetadata] - If true, return { url, serpTitle } instead of just url
 * @param {boolean} [options.preferSpeed] - If true, use ScrapingBee first (sync, ~1-3s) instead of BrightData (async, ~4-20s). Use for time-sensitive flows like opening night polling.
 * @param {boolean} [options.forceHistorical] - If true, skip date filter entirely from the first query (best for pre-2005 shows where Google date metadata is unreliable).
 * @returns {string|null|'__SERP_UNAVAILABLE__'|{url: string, serpTitle: string}} - Discovered URL (or object if returnMetadata)
 */
async function discoverCorrectUrl(review, scrapingBeeKey, options = {}) {
  const log = options.log || console.log;
  const brightDataKey = options.brightDataKey || '';
  let dateRange = options.dateRange || null;
  const returnMetadata = options.returnMetadata || false;
  const preferSpeed = options.preferSpeed || false;
  const forceHistorical = options.forceHistorical || false;

  if (!scrapingBeeKey && !brightDataKey) return '__SERP_UNAVAILABLE__';

  const showInfo = getShowInfo(review.showId);
  if (!showInfo.title) return null;

  // Auto-compute date range when caller doesn't provide one (prevents cross-production SERP contamination)
  // Skip entirely for historical mode — Google's date filter is unreliable for articles >5 years old.
  if (!forceHistorical && !dateRange && showInfo) {
    dateRange = calculateDateWindow(showInfo);
  }

  // Get domain for the outlet (explicit override > OUTLET_DOMAINS map)
  const outletId = (review.outletId || '').toLowerCase();
  const domain = options.domainOverride || OUTLET_DOMAINS[outletId];

  // Build search query — include year to disambiguate revivals
  // Include critic name as an unquoted boost when available and trustworthy.
  // Web-search sourced reviews often have fabricated critic names — skip those.
  const yearClause = showInfo.year ? ` ${showInfo.year}` : '';
  const criticName = (review.criticName && review.criticName !== 'Unknown'
    && review.source !== 'web-search') ? review.criticName : '';
  const criticClause = criticName ? ` ${criticName}` : '';
  const outletName = review.outlet || outletId;

  // For historical shows with recent revivals, anchor SERP to the right production
  // by including the lead actor name. "Bernadette Peters Gypsy Broadway review 2003"
  // surfaces the correct production; "Gypsy Broadway review 2003" returns only the revival.
  const leadActorClause = (forceHistorical && showInfo.leadActor)
    ? ` "${showInfo.leadActor}"` : '';

  // Use market-appropriate search term based on show category
  const marketTerm = isLondonMarket(showInfo.category) ? 'West End review'
    : showInfo.category === 'off-broadway' ? 'Off-Broadway review'
    : 'Broadway review';

  // Strip venue/subtitle suffix for alternate search (e.g., "The Tempest - Globe" → "The Tempest")
  // Reviewers omit these suffixes, so SERP with the full title returns 0 results.
  // Also handles "Dog Man - The Musical" → "Dog Man", "Midnight - A New Original..." → "Midnight"
  const primaryTitle = showInfo.title.includes(' - ')
    ? showInfo.title.split(' - ')[0].trim()
    : null;

  // Sanitize title for SERP: replace & with "and" to avoid URL encoding issues
  const serpTitle = showInfo.title.replace(/\s*&\s*/g, ' and ');

  let query;
  if (domain) {
    query = `${buildSiteClause(domain)} "${serpTitle}"${leadActorClause} ${marketTerm}${yearClause}${criticClause}`;
  } else {
    query = `"${serpTitle}"${leadActorClause} ${marketTerm}${yearClause} "${outletName}"${criticClause}`;
  }

  log(`  [URL Discovery] Searching: ${query}`);

  // Provider chain: BD first (cheap) unless preferSpeed (opening night → SB first)
  let { results, provider } = await _serpWithChain(query, scrapingBeeKey, brightDataKey, log, dateRange, preferSpeed);

  // Both providers down
  if (results === null) {
    log('    ✗ All SERP providers unavailable');
    return '__SERP_UNAVAILABLE__';
  }

  // Extract old URL's domain for fallback matching
  let oldDomain = '';
  try {
    oldDomain = new URL(review.url).hostname.replace(/^www\./, '');
  } catch (e) {}

  if (!results.length) {
    // Fallback 1: retry with stripped title (e.g., "The Tempest" instead of "The Tempest - Globe")
    // Reviewers omit venue/subtitle suffixes, causing 0 SERP hits for the full title
    if (primaryTitle && primaryTitle.length >= 3) {
      let strippedQuery;
      if (domain) {
        strippedQuery = `${buildSiteClause(domain)} "${primaryTitle}" ${marketTerm}${yearClause}${criticClause}`;
      } else {
        strippedQuery = `"${primaryTitle}" ${marketTerm}${yearClause} "${outletName}"${criticClause}`;
      }
      log(`    Retry with stripped title: ${strippedQuery}`);
      ({ results, provider } = await _serpWithChain(strippedQuery, scrapingBeeKey, brightDataKey, log, dateRange, preferSpeed));
      provider = provider ? provider + '-stripped' : null;
      if (results === null) {
        log('    ✗ All SERP providers unavailable');
        return '__SERP_UNAVAILABLE__';
      }
    }
  }

  if (!results.length) {
    // Fallback 2: broader search without site: restriction, using outlet + critic name
    // This catches articles Google didn't index under the domain (URL changes, redirects)
    if (criticName && (domain || oldDomain)) {
      const fallbackQuery = `"${serpTitle}" "${outletName}" "${criticName}" ${marketTerm}${yearClause}`;
      log(`    Fallback search (no site:): ${fallbackQuery}`);
      ({ results, provider } = await _serpWithChain(fallbackQuery, scrapingBeeKey, brightDataKey, log, dateRange, preferSpeed));
      provider = provider ? provider + '-fallback' : null;
      if (results === null) {
        log('    ✗ All SERP providers unavailable');
        return '__SERP_UNAVAILABLE__';
      }
    }

    // Fallback 3: for historical shows (closed >3 years ago), drop the date filter.
    // Google's date-range filter is unreliable for articles >5 years old — indexing dates
    // are often wrong or missing, causing genuine results to be filtered out. The year
    // keyword in the query is a more reliable disambiguator for historical shows.
    if (!results || !results.length) {
      const closingDate = showInfo.closingDate ? new Date(showInfo.closingDate) : null;
      const isHistorical = closingDate && (Date.now() - closingDate.getTime()) > 3 * 365 * 24 * 3600 * 1000;
      if (isHistorical && dateRange) {
        const noDateQuery = domain
          ? `${buildSiteClause(domain)} "${serpTitle}" ${marketTerm}${yearClause}${criticClause}`
          : `"${serpTitle}" ${marketTerm}${yearClause} "${outletName}"${criticClause}`;
        log(`    Fallback 3 (no date filter, historical show): ${noDateQuery}`);
        ({ results, provider } = await _serpWithChain(noDateQuery, scrapingBeeKey, brightDataKey, log, null, preferSpeed));
        provider = provider ? provider + '-historical' : null;
        if (results === null) {
          log('    ✗ All SERP providers unavailable');
          return '__SERP_UNAVAILABLE__';
        }
      }
    }

    if (!results || !results.length) {
      log('    ✗ No search results found');
      return null;
    }
  }

  log(`    Using ${provider} (${results.length} results)`);

  // Filter and match results
  const targetDomain = domain || oldDomain;
  const showTitleLower = showInfo.title.toLowerCase();
  const primaryTitleLower = primaryTitle ? primaryTitle.toLowerCase() : null;
  const shortTitle = (review.showId || '')
    .replace(/-\d{4}$/, '')
    .replace(/-/g, ' ')
    .toLowerCase();
  const shortSlug = shortTitle.replace(/\s+/g, '-');

  for (const result of results.slice(0, 5)) {
    const url = result.url || result.link;
    if (!url) continue;

    const urlLower = url.toLowerCase();
    try { if (new URL(url).pathname === '/') continue; } catch (e) {}
    if (urlLower.includes('/search?') || urlLower.includes('/tag/') || urlLower.includes('/category/')) continue;
    if (urlLower.includes('/attachment/') || urlLower.match(/\.(jpg|jpeg|png|gif|webp)$/)) continue;
    // TheaterMania /shows/ pages are listing pages, not reviews
    if (urlLower.includes('theatermania.com/shows/')) continue;

    // Tryout / TV / film / world-premiere URL prefilter (Schmigadoon 2026 Bug #8).
    // Rejects SERP results whose URL slug names a non-Broadway production of the
    // same title — Kennedy Center / Apple TV / pre-Broadway / Old Globe / etc.
    // Category gate: only apply to broadway/west-end/off-broadway shows; for
    // historical/touring lookups we may legitimately want those results.
    const isBroadwayLike = ['broadway', 'west-end', 'off-broadway', 'off-west-end'].includes(showInfo.category);
    if (isBroadwayLike) {
      const tryoutCheck = hasTryoutUrlMarker(url);
      if (tryoutCheck.rejected) {
        _recordTryoutRejection(review.showId, tryoutCheck.marker, url);
        log(`    [SKIP] Tryout/non-Broadway URL marker "${tryoutCheck.marker}": ${url.substring(0, 100)}`);
        continue;
      }
    }

    // Skip URLs whose embedded year is outside the production window
    const openYear = showInfo.year ? parseInt(showInfo.year) : null;
    const closeYear = showInfo.closingDate ? new Date(showInfo.closingDate).getFullYear() : null;
    if (openYear && isUrlYearOutsideWindow(url, openYear, closeYear)) {
      log(`    [SKIP] URL year outside production window: ${url}`);
      continue;
    }

    // Skip if same as the current URL
    if (url === review.url) continue;

    let urlDomain = '';
    try {
      urlDomain = new URL(url).hostname.replace(/^www\./, '');
    } catch (e) { continue; }

    if (targetDomain && !domainMatchesExpected(targetDomain.replace(/^www\./, ''), urlDomain)) continue;

    const title = (result.title || '').toLowerCase();
    const showSlugCheck = showTitleLower.replace(/\s+/g, '-');
    const primarySlugCheck = primaryTitleLower ? primaryTitleLower.replace(/\s+/g, '-') : null;

    const titleHasShow = title.includes(showTitleLower) || title.includes(shortTitle)
      || (primaryTitleLower && title.includes(primaryTitleLower));
    const urlHasShow = urlLower.includes(showSlugCheck) || urlLower.includes(shortSlug)
      || (primarySlugCheck && urlLower.includes(primarySlugCheck));
    const reviewTerms = ['review', 'theater', 'theatre', 'stage', 'musical', 'broadway', 'west end',
      'culture', 'arts', 'entertainment', 'article'];
    const titleHasReview = reviewTerms.some(t => title.includes(t));
    const urlHasReview = reviewTerms.some(t => urlLower.includes(t));

    // Reject non-review content: interviews, box office reports, ticket/cast announcements, photos
    const nonReviewTerms = ['interview', 'box-office', 'box office', 'grosses', 'gross-', 'begins-previews',
      'first-look', 'first look', 'cast-announced', 'cast announced', 'full-cast', 'meet-the-cast',
      'photos:', 'photo-gallery', 'tickets-on-sale', 'lottery', 'rush-policy', 'all-that-chat',
      'allthatchat', '/forum/', 'business-news',
      // Obituaries — high-signal stem ('obituar' → obituary/obituaries), never appears in a
      // review slug or headline. Matters most for slugless outlets (FT /content/{uuid}): the
      // bypass below skips urlLooksLikeReview's URL-path /obituar reject, so this TITLE check
      // is what still catches FT obituaries. (Deliberately NOT adding broader tribute tokens
      // like 'appreciation' — they collide with legitimate review headlines.)
      'obituar'];
    const isNonReview = nonReviewTerms.some(t => title.includes(t) || urlLower.includes(t));
    if (isNonReview) {
      log(`    ✗ Skipping non-review: ${url.substring(0, 80)}...`);
      continue;
    }

    if (!titleHasShow && !urlHasShow) continue;
    const isTimeoutListing = urlDomain.includes('timeout.com') && urlLower.includes('/theater/');
    if (!titleHasReview && !urlHasReview && !isTimeoutListing) continue;

    // Cross-show URL slug guard: verify URL path contains show title words.
    // Catches SERP results where Google returns the right domain but wrong show
    // (e.g., Monte Cristo review when searching for Becky Shaw).
    //
    // Slugless-domain exemption (FT /content/{uuid}): these URLs carry no title
    // words in the path, so the strict urlLooksLikeReview() slug check rejects every
    // legitimate FT review. For slugless domains ONLY, disambiguate via the SERP
    // result TITLE instead (titleHasShow, computed above — a substring match that is
    // robust to "Show, Venue — review" headlines where word-boundary matching breaks
    // on the comma). The remaining guards that keep wrong FT /content/ articles out:
    //   - the domain-restricted, date-bounded SERP query (site:ft.com "title" review ${year})
    //   - the nonReviewTerms TITLE filter above (now includes obituaries/tributes),
    //     which is the content-type defense the URL-path /obituar reject can't give a
    //     slugless URL
    //   - the titleHasReview requirement above
    //   - validateSerpCandidate below (cross-market / wrong-production markers)
    // Scoped to slugless URLs so non-FT discovery behavior is byte-identical.
    const isSlugless = isSluglessReviewUrl(url);
    if (showInfo.title && !isSlugless && !urlLooksLikeReview(url, showInfo.title)) {
      log(`    ✗ URL slug doesn't match "${showInfo.title}": ${url.substring(0, 80)}`);
      continue;
    }
    if (isSlugless && !titleHasShow) {
      log(`    ✗ Slugless URL, show title not in result title for "${showInfo.title}": ${url.substring(0, 80)}`);
      continue;
    }

    // Pre-fetch wrong-production validator: inspect title + snippet for
    // sibling-venue / cross-market markers. Rejects same-titled results
    // from prior productions (Hamlet 1995 Belasco, RSC tour, etc.) and
    // cross-market hits (UK production for an OB target). High-precision —
    // only reject on POSITIVE evidence of a different production.
    const candValidation = validateSerpCandidate({
      show: { id: review.showId, ...showInfo },
      candidate: { url, title: result.title, snippet: result.snippet },
    });
    if (!candValidation.ok) {
      log(`    ✗ ${candValidation.reason}: ${candValidation.detail} — ${url.substring(0, 80)}`);
      continue;
    }

    log(`    ✓ Found via ${provider}: ${url}`);
    return returnMetadata ? { url, serpTitle: result.title || '' } : url;
  }

  log('    ✗ No matching URL found in search results');
  return null;
}

/**
 * Calculate a date window for SERP queries to avoid cross-production contamination.
 * Returns { dateMin: Date, dateMax: Date } or null if no dates available.
 */
function calculateDateWindow(show) {
  const opening = show.openingDate ? new Date(show.openingDate) : null;
  const closing = show.closingDate ? new Date(show.closingDate) : null;
  const previews = show.previewsStartDate ? new Date(show.previewsStartDate) : null;

  if (!opening && !previews) return null;

  const now = new Date();
  const DAY = 86400000;

  // Start: previewsStart - 7 days, or openingDate - 30 days
  const dateMin = previews
    ? new Date(previews.getTime() - 7 * DAY)
    : new Date(opening.getTime() - 30 * DAY);

  // End: earliest of (closingDate + 30, today + 30, openingDate + 180)
  const candidates = [new Date(now.getTime() + 30 * DAY)];
  if (closing) candidates.push(new Date(closing.getTime() + 30 * DAY));
  if (opening) candidates.push(new Date(opening.getTime() + 180 * DAY));
  const dateMax = new Date(Math.min(...candidates.map(d => d.getTime())));

  return { dateMin, dateMax };
}

/**
 * Format a Date as MM/DD/YYYY for Google's tbs parameter.
 */
function formatDateForGoogle(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

/**
 * Build the Google tbs date-range parameter string.
 * @param {{ dateMin: Date, dateMax: Date }} dateRange
 * @returns {string} e.g. "cdr:1,cd_min:1/1/2024,cd_max:6/1/2024"
 */
function buildDateTbs(dateRange) {
  return `cdr:1,cd_min:${formatDateForGoogle(dateRange.dateMin)},cd_max:${formatDateForGoogle(dateRange.dateMax)}`;
}

/**
 * Check if a URL's domain matches the expected domain for an outlet.
 * Returns true if the URL is valid for the outlet (or if no domain is registered).
 * Used by aggregator scrapers that create review files directly (bypassing gather-reviews.js).
 *
 * @param {string} url - The review URL
 * @param {string} outletId - Normalized outlet ID
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateUrlDomain(url, outletId) {
  if (!url || !outletId) return { valid: true };
  const expectedDomain = OUTLET_DOMAINS[outletId];
  if (!expectedDomain) return { valid: true }; // No registered domain — can't validate
  try {
    const urlDomain = new URL(url).hostname.replace(/^www\./, '');
    if (!domainMatchesExpected(expectedDomain.replace(/^www\./, ''), urlDomain)) {
      return { valid: false, reason: `URL domain ${urlDomain} doesn't match outlet ${outletId} (expected ${expectedDomain})` };
    }
    return { valid: true };
  } catch {
    return { valid: true }; // Invalid URL — let downstream handle
  }
}

/**
 * General-purpose Google SERP query.
 * Provider chain: Bright Data (cheap) → ScrapingBee (25 credits/query fallback).
 * With preferSpeed=true: ScrapingBee first → Bright Data fallback.
 *
 * @param {string} query - Google search query
 * @param {Object} [options] - Optional settings
 * @param {string} [options.scrapingBeeKey] - ScrapingBee API key (env: SCRAPINGBEE_API_KEY)
 * @param {string} [options.brightDataKey] - Bright Data token (env: BRIGHTDATA_TOKEN)
 * @param {Function} [options.log] - Logging function (default: console.log)
 * @param {number} [options.nbResults] - Max results to return (default: 10)
 * @param {{ dateMin: Date, dateMax: Date }} [options.dateRange] - Optional date range filter
 * @param {boolean} [options.preferSpeed] - If true, ScrapingBee first (for time-sensitive flows)
 * @returns {Array<{url: string, title: string}>|null} organic results, or null if all providers unavailable
 */
async function serpQuery(query, options = {}) {
  const sbKey = options.scrapingBeeKey || process.env.SCRAPINGBEE_API_KEY || '';
  const bdKey = options.brightDataKey || process.env.BRIGHTDATA_TOKEN || '';
  const log = options.log || console.log;
  const dateRange = options.dateRange || null;
  const preferSpeed = options.preferSpeed || false;
  const nbResults = options.nbResults || 10;
  // Explicit geo override for callers whose queries don't contain "West End"
  // but target UK-only sites (e.g. slug discovery for SeatPlan/LBO/LTD).
  const geo = options.geo;

  if (!sbKey && !bdKey) {
    log('    ⚠ No SERP API keys available (SCRAPINGBEE_API_KEY / BRIGHTDATA_TOKEN)');
    return null;
  }

  const { results } = await _serpWithChain(query, sbKey, bdKey, log, dateRange, preferSpeed, geo);
  if (!results) return null;

  return results.slice(0, nbResults);
}

module.exports = {
  OUTLET_DOMAINS,
  REGISTRY_DOMAIN_ALIASES,
  DOMAIN_REDIRECTS,
  buildSiteClause,
  discoverCorrectUrl,
  serpQuery,
  getShowInfo,
  calculateDateWindow,
  buildDateTbs,
  validateUrlDomain,
  getTryoutRejectionStats,
  resetTryoutRejectionStats,
};
