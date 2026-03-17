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
const { domainMatchesExpected } = scraper;
const { isUrlYearOutsideWindow } = require('./content-filters');
const { isLondonMarket } = require('./venue-classification');

// Outlet-to-domain mapping for URL discovery via Google SERP
const OUTLET_DOMAINS = {
  'nytimes': 'nytimes.com',
  'nyt': 'nytimes.com',
  'variety': 'variety.com',
  'hollywood-reporter': 'hollywoodreporter.com',
  'thr': 'hollywoodreporter.com',
  'vulture': 'vulture.com',
  'vult': 'vulture.com',
  'timeout': 'timeout.com',
  'time-out': 'timeout.com',
  'deadline': 'deadline.com',
  'wsj': 'wsj.com',
  'ew': 'ew.com',
  'entertainment-weekly': 'ew.com',
  'nypost': 'nypost.com',
  'new-york-post': 'nypost.com',
  'guardian': 'theguardian.com',
  'the-guardian': 'theguardian.com',
  'chicagotribune': 'chicagotribune.com',
  'chicago-tribune': 'chicagotribune.com',
  'wapo': 'washingtonpost.com',
  'washpost': 'washingtonpost.com',
  'washington-post': 'washingtonpost.com',
  'usatoday': 'usatoday.com',
  'usa-today': 'usatoday.com',
  'ap': 'apnews.com',
  'associated-press': 'apnews.com',
  'rollingstone': 'rollingstone.com',
  'rolling-stone': 'rollingstone.com',
  'daily-beast': 'thedailybeast.com',
  'thedailybeast': 'thedailybeast.com',
  'observer': 'observer.com',
  'the-wrap': 'thewrap.com',
  'thewrap': 'thewrap.com',
  'nydailynews': 'nydailynews.com',
  'new-york-daily-news': 'nydailynews.com',
  'newsday': 'newsday.com',
  'theatermania': 'theatermania.com',
  'newyorktheatreguide': 'newyorktheatreguide.com',
  'new-york-theatre-guide': 'newyorktheatreguide.com',
  'nystagereview': 'nystagereview.com',
  'ny-stage-review': 'nystagereview.com',
  'new-york-stage-review': 'nystagereview.com',
  'theatrely': 'theatrely.com',
  'newyorktheater': 'newyorktheater.me',
  'broadwayworld': 'broadwayworld.com',
  'bww': 'broadwayworld.com',
  'cititour': 'cititour.com',
  'amny': 'amny.com',
  'am-new-york': 'amny.com',
  'newyorker': 'newyorker.com',
  'the-new-yorker': 'newyorker.com',
  'indiewire': 'indiewire.com',
  'forward': 'forward.com',
  'talkinbroadway': 'talkinbroadway.com',
  'talkin-broadway': 'talkinbroadway.com',
  'broadway-news': 'broadwaynews.com',
  'stage-and-cinema': 'stageandcinema.com',
  'culture-sauce': 'culturesauce.com',
  'dc-metro-theater-arts': 'dcmetrotheaterarts.com',
  'nj-arts': 'njarts.net',
  'nyt-theater': 'newyorktheater.me',
  'dailybeast': 'thedailybeast.com',
  'front-row-center': 'thefrontrowcenter.com',
  'theater-life': 'theaterlife.com',
  'frontmezzjunkies': 'frontmezzjunkies.com',
  'theatre-reviews-limited': 'theatrereviews.com',
  'thestage': 'thestage.co.uk',
  'the-stage-uk': 'thestage.co.uk',
  'nytg': 'newyorktheatreguide.com',
  'new-york-sun': 'nysun.com',
  'theater-pizzazz': 'theaterpizzazz.com',
  'stagebuddy': 'stagebuddy.com',
  'culturesauce': 'culturesauce.com',
  'theatres-leiter-side': 'slleiter.blogspot.com',
  'dctheatrescene': 'dctheatrescene.com',
  'theater-scene': 'theaterscene.net',
  'stage-left': 'stageleft.nyc',
  'gotham-playgoer': 'gotham-playgoer.blogspot.com',
  'scribicide': 'scribicide.com',
  'broadway-blog': 'thebroadwayblog.com',
  'the-clyde-fitch-report': 'clydefitchreport.com',
  'the-interested-bystander': 'interestedbystander.com',
  'pages-on-stages': 'pagesonstages.com',
  'nysr': 'nystagereview.com',
  'slantmagazine': 'slantmagazine.com',
  'financial-times-uk': 'ft.com',
  'latimes': 'latimes.com',
  'la-times': 'latimes.com',
  'huffpost': 'huffpost.com',
  'huffington-post': 'huffpost.com',
  // UK outlets for West End SERP discovery
  'telegraph': 'telegraph.co.uk',
  'the-telegraph-uk': 'telegraph.co.uk',
  'evening-standard': 'standard.co.uk',
  'standard': 'standard.co.uk',
  'the-times-uk': 'thetimes.co.uk',
  'times-uk': 'thetimes.co.uk',
  'dailymail': 'dailymail.co.uk',
  'daily-mail': 'dailymail.co.uk',
  'whatsonstage': 'whatsonstage.com',
  'timeout-london': 'timeout.com',
  'time-out-london': 'timeout.com',
  'independent': 'independent.co.uk',
  'the-independent-uk': 'independent.co.uk',
  'london-theatre': 'londontheatre.co.uk',
  'londontheatre': 'londontheatre.co.uk',
  'inews': 'inews.co.uk',
  'the-i-uk': 'inews.co.uk',
  'stage-uk': 'thestage.co.uk',
  'the-arts-desk': 'theartsdesk.com',
  'artsdesk': 'theartsdesk.com',
  'everythingtheatre': 'everythingtheatre.co.uk',
  'everything-theatre': 'everythingtheatre.co.uk',
  'thereviewshub': 'thereviewshub.com',
  'metro-uk': 'metro.co.uk',
  'mirror': 'mirror.co.uk',
  'the-sun': 'thesun.co.uk',
  'west-end-best-friend': 'westendbestfriend.co.uk',
  'bloomberg': 'bloomberg.com',
  'bloomberg-news': 'bloomberg.com',
};

// Known domain redirects (old domain → new domain)
const DOMAIN_REDIRECTS = {
  'huffingtonpost.com': 'huffpost.com',
  'www.huffingtonpost.com': 'www.huffpost.com',
};

let _showsJsonCache = null;

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
      return {
        title: showEntry.title,
        year: (showEntry.openingDate || '').substring(0, 4),
        category: showEntry.category || 'broadway',
        openingDate: showEntry.openingDate || null,
        closingDate: showEntry.closingDate || null,
        previewsStartDate: showEntry.previewsStartDate || null,
      };
    }
  } catch (e) { /* fall through */ }

  // Fallback to slug-derived
  const title = (showId || '').replace(/-\d{4}$/, '').replace(/-/g, ' ');
  const yearMatch = (showId || '').match(/-(\d{4})$/);
  return { title: title || null, year: yearMatch ? yearMatch[1] : '' };
}

// ============================================================================
// SERP Providers
// ============================================================================

let _scrapingBeeSerpExhausted = false;
let _brightDataConsecutiveFailures = 0;
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
async function _serpViaBrightData(query, apiKey, log, dateRange) {
  if (!apiKey || _brightDataConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;

  const fmtD = d => d.toISOString().split('T')[0];
  const dateQuery = dateRange ? ` after:${fmtD(dateRange.dateMin)} before:${fmtD(dateRange.dateMax)}` : '';
  const fullQuery = query + dateQuery;

  // Try synchronous SERP API first (fastest, returns structured JSON directly)
  const syncResult = await _serpViaBrightDataWebUnlocker(fullQuery, apiKey, log);
  if (syncResult !== null) return syncResult;

  // Fallback: async SERP API (polling-based, slower but more reliable)
  return _serpViaBrightDataSerpApi(fullQuery, apiKey, log);
}

const _BD_CUSTOMER = process.env.BRIGHTDATA_CUSTOMER || 'hl_a2c64a47';
const _BD_SERP_ZONE = process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1';

async function _serpViaBrightDataSerpApi(query, apiKey, log) {
  try {
    // Use Google UK for West End queries, Google US for Broadway/OB
    const geo = query.includes('West End') ? 'gb' : 'us';
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
      return null; // Fall through to Web Unlocker
    }
    const submitData = await submitRes.json();
    const responseId = submitData.response_id;
    if (!responseId) {
      _brightDataConsecutiveFailures++;
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
        return null;
      }
      const data = await pollRes.json();
      if (data.organic) {
        _brightDataConsecutiveFailures = 0;
        return data.organic.slice(0, 10).map(r => ({
          url: r.link || r.url || '',
          title: r.title || '',
        }));
      }
      if (data.response_id) continue;
      _brightDataConsecutiveFailures = 0;
      return [];
    }
    _brightDataConsecutiveFailures++;
    log('    ⚠ BD SERP API timeout (20s) — trying Web Unlocker');
    return null;
  } catch (error) {
    _brightDataConsecutiveFailures++;
    log(`    ✗ BD SERP API error: ${error.message} — trying Web Unlocker`);
    return null;
  }
}

async function _serpViaBrightDataWebUnlocker(query, apiKey, log) {
  const axios = require('axios');
  // Use SERP zone — Web Unlocker (mcp_unlocker) can't access Google Search
  const geo = query.includes('West End') ? 'gb' : 'us';
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
      return data.organic.slice(0, 10).map(r => ({
        url: r.link || r.url || '',
        title: r.title || '',
      }));
    }

    // Raw HTML — parse with regex
    const html = typeof data === 'string' ? data : '';
    if (!html || html.length < 500) return [];

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
    return results.slice(0, 10);
  } catch (error) {
    _brightDataConsecutiveFailures++;
    log(`    ✗ Bright Data Web Unlocker error (${_brightDataConsecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message}`);
    if (_brightDataConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`    ⚠ Bright Data SERP disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
    }
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
async function _serpWithChain(query, scrapingBeeKey, brightDataKey, log, dateRange, preferSpeed) {
  const primary = preferSpeed
    ? { fn: _serpViaScrapingBee, key: scrapingBeeKey, name: 'scrapingbee' }
    : { fn: _serpViaBrightData, key: brightDataKey, name: 'brightdata' };
  const fallback = preferSpeed
    ? { fn: _serpViaBrightData, key: brightDataKey, name: 'brightdata' }
    : { fn: _serpViaScrapingBee, key: scrapingBeeKey, name: 'scrapingbee' };

  let results = await primary.fn(query, primary.key, log, dateRange);
  let provider = primary.name;
  if (!results || results.length === 0) {
    const fbResults = await fallback.fn(query, fallback.key, log, dateRange);
    if (fbResults && fbResults.length > 0) {
      results = fbResults;
      provider = fallback.name;
    } else if (!results && !fbResults) {
      results = null; // Both providers down
    }
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
 * @returns {string|null|'__SERP_UNAVAILABLE__'|{url: string, serpTitle: string}} - Discovered URL (or object if returnMetadata)
 */
async function discoverCorrectUrl(review, scrapingBeeKey, options = {}) {
  const log = options.log || console.log;
  const brightDataKey = options.brightDataKey || '';
  let dateRange = options.dateRange || null;
  const returnMetadata = options.returnMetadata || false;
  const preferSpeed = options.preferSpeed || false;

  if (!scrapingBeeKey && !brightDataKey) return '__SERP_UNAVAILABLE__';

  const showInfo = getShowInfo(review.showId);
  if (!showInfo.title) return null;

  // Auto-compute date range when caller doesn't provide one (prevents cross-production SERP contamination)
  if (!dateRange && showInfo) {
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
    query = `site:${domain} "${serpTitle}" ${marketTerm}${yearClause}${criticClause}`;
  } else {
    query = `"${serpTitle}" ${marketTerm}${yearClause} "${outletName}"${criticClause}`;
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
        strippedQuery = `site:${domain} "${primaryTitle}" ${marketTerm}${yearClause}${criticClause}`;
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
    const reviewTerms = ['review', 'theater', 'theatre', 'stage', 'musical', 'broadway', 'west end'];
    const titleHasReview = reviewTerms.some(t => title.includes(t));
    const urlHasReview = reviewTerms.some(t => urlLower.includes(t));

    if (!titleHasShow && !urlHasShow) continue;
    const isTimeoutListing = urlDomain.includes('timeout.com') && urlLower.includes('/theater/');
    if (!titleHasReview && !urlHasReview && !isTimeoutListing) continue;

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

module.exports = {
  OUTLET_DOMAINS,
  DOMAIN_REDIRECTS,
  discoverCorrectUrl,
  getShowInfo,
  calculateDateWindow,
  buildDateTbs,
};
