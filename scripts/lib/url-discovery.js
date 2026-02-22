/**
 * URL Discovery via Google SERP (shared module)
 *
 * Provider chain: ScrapingBee SERP API → Bright Data Web Unlocker (Google HTML).
 *
 * Used by:
 * - collect-review-texts.js (full text collection — has its own inline copy)
 * - rediscover-review-urls.js (URL rediscovery pre-processing)
 */

const fs = require('fs');
const path = require('path');

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
let _scrapingBeeConsecutiveFailures = 0;
let _brightDataConsecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Search via ScrapingBee SERP API (returns structured JSON).
 * @returns {Array<{url: string, title: string}>|null} organic results, or null if provider unavailable
 */
async function _serpViaScrapingBee(query, apiKey, log) {
  if (_scrapingBeeSerpExhausted || !apiKey) return null;

  const axios = require('axios');
  try {
    const response = await axios.get('https://app.scrapingbee.com/api/v1/store/google', {
      params: { api_key: apiKey, search: query },
      timeout: 30000,
    });
    const data = response.data;
    _scrapingBeeConsecutiveFailures = 0; // Reset on success
    return (data.organic_results || data.results || []).map(r => ({
      url: r.url || r.link,
      title: r.title || '',
    }));
  } catch (error) {
    const status = error.response?.status;
    if (status === 401 || status === 403 || status === 429) {
      _scrapingBeeSerpExhausted = true;
      log(`    ⚠ ScrapingBee SERP exhausted (${status}) — falling back to Bright Data`);
    } else {
      _scrapingBeeConsecutiveFailures++;
      log(`    ✗ ScrapingBee SERP error (${_scrapingBeeConsecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message}`);
      if (_scrapingBeeConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        _scrapingBeeSerpExhausted = true;
        log(`    ⚠ ScrapingBee SERP disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      }
    }
    return null;
  }
}

/**
 * Search via Bright Data Web Unlocker → Google HTML.
 * Parses organic results from Google's HTML response.
 * Ported from collect-review-texts.js _serpViaBrightData().
 * @returns {Array<{url: string, title: string}>|null} organic results, or null if provider unavailable
 */
async function _serpViaBrightData(query, apiKey, log) {
  if (!apiKey || _brightDataConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;

  const axios = require('axios');
  const zoneName = process.env.BRIGHTDATA_ZONE || 'mcp_unlocker';
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`;

  try {
    const response = await axios.post('https://api.brightdata.com/request', {
      zone: zoneName,
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

    // SERP API zone returns structured JSON with organic results
    if (data && typeof data === 'object' && Array.isArray(data.organic)) {
      _brightDataConsecutiveFailures = 0; // Reset on success
      return data.organic.slice(0, 10).map(r => ({
        url: r.link || r.url || '',
        title: r.title || '',
      }));
    }

    // Fallback: Web Unlocker zone returns raw HTML — parse it
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

    _brightDataConsecutiveFailures = 0; // Reset on success
    return results.slice(0, 10);
  } catch (error) {
    _brightDataConsecutiveFailures++;
    log(`    ✗ Bright Data SERP error (${_brightDataConsecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message}`);
    if (_brightDataConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`    ⚠ Bright Data SERP disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
    }
    return null;
  }
}

// ============================================================================
// Main discovery function
// ============================================================================

/**
 * Discover correct URL for a review via Google SERP search.
 * Provider chain: ScrapingBee → Bright Data Web Unlocker.
 *
 * @param {Object} review - Review object with showId, outletId, outlet, url
 * @param {string} scrapingBeeKey - ScrapingBee API key (can be empty)
 * @param {Object} [options] - Optional settings
 * @param {string} [options.brightDataKey] - Bright Data API token (fallback provider)
 * @param {Function} [options.log] - Logging function (default: console.log)
 * @returns {string|null|'__SERP_UNAVAILABLE__'} - Discovered URL, null if not found, or sentinel if all providers down
 */
async function discoverCorrectUrl(review, scrapingBeeKey, options = {}) {
  const log = options.log || console.log;
  const brightDataKey = options.brightDataKey || '';

  if (!scrapingBeeKey && !brightDataKey) return '__SERP_UNAVAILABLE__';

  const showInfo = getShowInfo(review.showId);
  if (!showInfo.title) return null;

  // Get domain for the outlet
  const outletId = (review.outletId || '').toLowerCase();
  const domain = OUTLET_DOMAINS[outletId];

  // Build search query — include year to disambiguate revivals
  // Include critic name as an unquoted boost when available and trustworthy.
  // Web-search sourced reviews often have fabricated critic names — skip those.
  const yearClause = showInfo.year ? ` ${showInfo.year}` : '';
  const criticName = (review.criticName && review.criticName !== 'Unknown'
    && review.source !== 'web-search') ? review.criticName : '';
  const criticClause = criticName ? ` ${criticName}` : '';
  const outletName = review.outlet || outletId;

  // Use market-appropriate search term based on show category
  const marketTerm = showInfo.category === 'west-end' ? 'West End review'
    : showInfo.category === 'off-broadway' ? 'Off-Broadway review'
    : 'Broadway review';

  let query;
  if (domain) {
    query = `site:${domain} "${showInfo.title}" ${marketTerm}${yearClause}${criticClause}`;
  } else {
    query = `"${showInfo.title}" ${marketTerm}${yearClause} "${outletName}"${criticClause}`;
  }

  log(`  [URL Discovery] Searching: ${query}`);

  // Provider chain: ScrapingBee → Bright Data
  // null = provider failure (down/exhausted), [] = searched but no results
  let results = await _serpViaScrapingBee(query, scrapingBeeKey, log);
  let provider = 'scrapingbee';
  if (!results) {
    results = await _serpViaBrightData(query, brightDataKey, log);
    provider = 'brightdata';
  }

  // Both providers down
  if (results === null) {
    log('    ✗ All SERP providers unavailable');
    return '__SERP_UNAVAILABLE__';
  }

  if (!results.length) {
    // Fallback: broader search without site: restriction, using outlet + critic name
    // This catches articles Google didn't index under the domain (URL changes, redirects)
    if (criticName && domain) {
      const fallbackQuery = `"${showInfo.title}" "${outletName}" "${criticName}" ${marketTerm}${yearClause}`;
      log(`    Fallback search (no site:): ${fallbackQuery}`);
      results = await _serpViaScrapingBee(fallbackQuery, scrapingBeeKey, log);
      provider = 'scrapingbee-fallback';
      if (!results) {
        results = await _serpViaBrightData(fallbackQuery, brightDataKey, log);
        provider = 'brightdata-fallback';
      }
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
  let oldDomain = '';
  try {
    oldDomain = new URL(review.url).hostname.replace(/^www\./, '');
  } catch (e) {}

  const targetDomain = domain || oldDomain;
  const showTitleLower = showInfo.title.toLowerCase();
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

    // Skip if same as the current URL
    if (url === review.url) continue;

    let urlDomain = '';
    try {
      urlDomain = new URL(url).hostname.replace(/^www\./, '');
    } catch (e) { continue; }

    if (targetDomain && !urlDomain.includes(targetDomain.replace(/^www\./, ''))) continue;

    const title = (result.title || '').toLowerCase();
    const showSlugCheck = showTitleLower.replace(/\s+/g, '-');

    const titleHasShow = title.includes(showTitleLower) || title.includes(shortTitle);
    const urlHasShow = urlLower.includes(showSlugCheck) || urlLower.includes(shortSlug);
    const titleHasReview = title.includes('review');

    if (!titleHasShow && !urlHasShow) continue;
    const isTimeoutListing = urlDomain.includes('timeout.com') && urlLower.includes('/theater/');
    if (!titleHasReview && !urlLower.includes('review') && !isTimeoutListing) continue;

    log(`    ✓ Found via ${provider}: ${url}`);
    return url;
  }

  log('    ✗ No matching URL found in search results');
  return null;
}

module.exports = {
  OUTLET_DOMAINS,
  DOMAIN_REDIRECTS,
  discoverCorrectUrl,
  getShowInfo,
};
