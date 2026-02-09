/**
 * URL Discovery via Google SERP (shared module)
 *
 * Extracted from collect-review-texts.js for reuse by:
 * - collect-review-texts.js (full text collection)
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
      };
    }
  } catch (e) { /* fall through */ }

  // Fallback to slug-derived
  const title = (showId || '').replace(/-\d{4}$/, '').replace(/-/g, ' ');
  const yearMatch = (showId || '').match(/-(\d{4})$/);
  return { title: title || null, year: yearMatch ? yearMatch[1] : '' };
}

/**
 * Discover correct URL for a review via Google SERP search (ScrapingBee).
 *
 * @param {Object} review - Review object with showId, outletId, outlet, url
 * @param {string} scrapingBeeKey - ScrapingBee API key
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.log] - Logging function (default: console.log)
 * @returns {string|null} - Discovered URL, or null if not found
 */
async function discoverCorrectUrl(review, scrapingBeeKey, options = {}) {
  const log = options.log || console.log;
  const axios = require('axios');

  if (!scrapingBeeKey) return null;

  const showInfo = getShowInfo(review.showId);
  if (!showInfo.title) return null;

  // Get domain for the outlet
  const outletId = (review.outletId || '').toLowerCase();
  const domain = OUTLET_DOMAINS[outletId];

  // Build search query — include year to disambiguate revivals
  const yearClause = showInfo.year ? ` ${showInfo.year}` : '';
  let query;
  if (domain) {
    query = `site:${domain} "${showInfo.title}" Broadway review${yearClause}`;
  } else {
    const outletName = review.outlet || outletId;
    query = `"${showInfo.title}" Broadway review${yearClause} "${outletName}"`;
  }

  log(`  [URL Discovery] Searching: ${query}`);

  try {
    const response = await axios.get('https://app.scrapingbee.com/api/v1/store/google', {
      params: {
        api_key: scrapingBeeKey,
        search: query,
      },
      timeout: 30000,
    });

    const data = response.data;
    const results = data.organic_results || data.results || [];

    if (!results.length) {
      log('    ✗ No search results found');
      return null;
    }

    // Extract the old URL's domain for comparison
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

      log(`    ✓ Found: ${url}`);
      return url;
    }

    log('    ✗ No matching URL found in search results');
    return null;
  } catch (error) {
    log(`    ✗ URL discovery failed: ${error.message}`);
    return null;
  }
}

module.exports = {
  OUTLET_DOMAINS,
  DOMAIN_REDIRECTS,
  discoverCorrectUrl,
  getShowInfo,
};
