#!/usr/bin/env node
/**
 * IBDB Date Lookup Module
 *
 * Extracts preview dates, opening dates, and closing dates from IBDB
 * (Internet Broadway Database) production pages.
 *
 * IBDB has separate "1st Preview" and "Opening Date" fields, unlike
 * Broadway.org which only has an ambiguous "Begins:" field.
 *
 * Uses Google SERP to find IBDB production URLs, then ScrapingBee
 * with premium proxy to extract dates from production pages.
 */

const { fetchPage, cleanup } = require('./scraper');

const IBDB_BASE = 'https://www.ibdb.com';
const RATE_LIMIT_MS = 1500;

/**
 * Search for IBDB production page URLs via Google SERP
 * @param {string} title - Show title
 * @param {Object} options
 * @param {number} [options.openingYear] - Narrow results to a specific year
 * @returns {Promise<Array<{url: string, title: string, year: string|null}>>}
 */
async function searchIBDB(title, options = {}) {
  const { openingYear } = options;

  // Build Google search query
  const yearStr = openingYear ? ` ${openingYear}` : '';
  const query = `site:ibdb.com/broadway-production "${title}"${yearStr}`;

  console.log(`  🔍 Searching IBDB: ${query}`);

  let results = [];

  // Try ScrapingBee Google SERP first
  try {
    const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY;
    if (scrapingBeeKey) {
      const url = `https://app.scrapingbee.com/api/v1/?` +
        `api_key=${scrapingBeeKey}` +
        `&search=${encodeURIComponent(query)}` +
        `&search_engine=google`;

      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const organic = data.organic_results || [];
        results = organic
          .filter(r => r.url && r.url.includes('/broadway-production/'))
          .map(r => ({
            url: r.url,
            title: r.title || '',
            year: extractYearFromUrl(r.url)
          }));
      }
    }
  } catch (e) {
    console.log(`  ⚠️  ScrapingBee SERP failed: ${e.message}`);
  }

  // Fallback: try Bright Data SERP
  if (results.length === 0) {
    try {
      const brightToken = process.env.BRIGHTDATA_TOKEN;
      if (brightToken) {
        const resp = await fetch('https://api.brightdata.com/serp/req', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${brightToken}`
          },
          body: JSON.stringify({
            query: query,
            search_engine: 'google',
            country: 'us'
          })
        });

        if (resp.ok) {
          const data = await resp.json();
          const organic = data.organic || [];
          results = organic
            .filter(r => r.link && r.link.includes('/broadway-production/'))
            .map(r => ({
              url: r.link,
              title: r.title || '',
              year: extractYearFromUrl(r.link)
            }));
        }
      }
    } catch (e) {
      console.log(`  ⚠️  Bright Data SERP failed: ${e.message}`);
    }
  }

  // Fallback: construct URL directly from title slug
  if (results.length === 0) {
    const slug = title.toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    // Try common IBDB URL patterns
    console.log(`  📎 No SERP results, trying direct URL construction for "${title}"`);
    results.push({
      url: `${IBDB_BASE}/broadway-production/${slug}`,
      title: title,
      year: openingYear ? String(openingYear) : null,
      isGuessed: true
    });
  }

  return results;
}

/**
 * Extract year from IBDB production URL
 * IBDB URLs end with a numeric ID, not a year, but sometimes the title has a year
 */
function extractYearFromUrl(url) {
  // IBDB production URLs: /broadway-production/title-slug-123456
  // The number is an internal ID, not a year
  // Try to extract year from the title portion
  const match = url.match(/\/broadway-production\/.*?(\d{4})/);
  if (match) {
    const year = parseInt(match[1]);
    if (year >= 1850 && year <= 2030) return String(year);
  }
  return null;
}

/**
 * Extract dates from an IBDB production page
 * @param {string} url - Full IBDB production URL
 * @returns {Promise<{previewsStartDate: string|null, openingDate: string|null, closingDate: string|null, theatre: string|null, ibdbUrl: string}>}
 */
async function extractDatesFromIBDBPage(url) {
  console.log(`  📄 Fetching IBDB page: ${url}`);

  const result = {
    previewsStartDate: null,
    openingDate: null,
    closingDate: null,
    theatre: null,
    ibdbUrl: url
  };

  let content = null;

  // Try ScrapingBee with premium proxy (works reliably based on testing)
  try {
    const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY;
    if (scrapingBeeKey) {
      const apiUrl = `https://app.scrapingbee.com/api/v1/?` +
        `api_key=${scrapingBeeKey}` +
        `&url=${encodeURIComponent(url)}` +
        `&premium_proxy=true` +
        `&render_js=true`;

      const resp = await fetch(apiUrl);
      if (resp.ok) {
        content = await resp.text();
      }
    }
  } catch (e) {
    console.log(`  ⚠️  ScrapingBee page fetch failed: ${e.message}`);
  }

  // Fallback: shared scraper
  if (!content) {
    try {
      const pageResult = await fetchPage(url);
      content = pageResult.content;
    } catch (e) {
      console.log(`  ⚠️  Scraper fallback failed: ${e.message}`);
      return result;
    }
  }

  if (!content) return result;

  // Check if we got redirected to homepage (page not found)
  if (content.includes('Opening Nights in History') && !content.includes('Opening Date')) {
    console.log(`  ⚠️  IBDB page redirected to homepage (production not found)`);
    return result;
  }

  // Parse dates from markdown/text content
  // Format observed: "Opening Date\n\nNov 12, 2024"
  // and "1st Preview\n\nOct 16, 2024"

  // Opening Date
  const openingMatch = content.match(/Opening Date\s*\n+\s*([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/);
  if (openingMatch) {
    result.openingDate = parseIBDBDate(openingMatch[1]);
  }

  // Also try "Open Date:" format (seen in structured data section)
  if (!result.openingDate) {
    const openDateMatch = content.match(/Open Date:\s*([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/);
    if (openDateMatch) {
      result.openingDate = parseIBDBDate(openDateMatch[1]);
    }
  }

  // 1st Preview
  const previewMatch = content.match(/1st Preview\s*\n+\s*([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/);
  if (previewMatch) {
    result.previewsStartDate = parseIBDBDate(previewMatch[1]);
  }

  // Closing Date
  const closingMatch = content.match(/Closing Date\s*\n+\s*([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/);
  if (closingMatch) {
    result.closingDate = parseIBDBDate(closingMatch[1]);
  }
  // Also try "Close Date:" format
  if (!result.closingDate) {
    const closeDateMatch = content.match(/Close Date:\s*([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/);
    if (closeDateMatch) {
      result.closingDate = parseIBDBDate(closeDateMatch[1]);
    }
  }

  // Theatre - from "Theatres" section or structured text
  const theatreMatch = content.match(/Theatres[^\n]*\n+\s*\[([^\]]+)\]/);
  if (theatreMatch) {
    result.theatre = theatreMatch[1].trim();
  }

  return result;
}

/**
 * Parse IBDB date string (e.g., "Nov 12, 2024") to ISO format "2024-11-12"
 */
function parseIBDBDate(dateStr) {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr.trim());
    if (isNaN(parsed.getTime())) return null;
    return parsed.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Find the best matching production from search results
 * @param {Array} results - Search results from searchIBDB
 * @param {Object} options
 * @param {number} [options.openingYear] - Expected opening year
 * @param {string} [options.venue] - Expected venue name
 * @returns {Object|null} Best matching result
 */
function findBestProduction(results, options = {}) {
  if (!results || results.length === 0) return null;
  if (results.length === 1) return results[0];

  const { openingYear, venue } = options;

  // Score each result
  const scored = results.map(r => {
    let score = 0;

    // Year match
    if (openingYear && r.year) {
      if (String(r.year) === String(openingYear)) score += 10;
      else if (Math.abs(parseInt(r.year) - openingYear) <= 1) score += 5;
    }

    // Prefer non-guessed URLs
    if (!r.isGuessed) score += 3;

    // Venue match in title
    if (venue && r.title && r.title.toLowerCase().includes(venue.toLowerCase())) {
      score += 5;
    }

    // Recent productions score higher (likely more relevant)
    if (r.year) {
      const y = parseInt(r.year);
      if (y >= 2020) score += 2;
      else if (y >= 2010) score += 1;
    }

    return { ...r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

/**
 * Look up dates for a single show from IBDB
 * @param {string} title - Show title
 * @param {Object} options
 * @param {number} [options.openingYear] - Approximate opening year
 * @param {string} [options.venue] - Theatre venue name
 * @returns {Promise<{previewsStartDate: string|null, openingDate: string|null, closingDate: string|null, ibdbUrl: string|null, found: boolean}>}
 */
async function lookupIBDBDates(title, options = {}) {
  const notFound = {
    previewsStartDate: null,
    openingDate: null,
    closingDate: null,
    ibdbUrl: null,
    found: false
  };

  try {
    // Step 1: Search for IBDB production page
    const searchResults = await searchIBDB(title, options);

    if (searchResults.length === 0) {
      console.log(`  ❌ No IBDB results found for "${title}"`);
      return notFound;
    }

    // Step 2: Find best matching production
    const bestMatch = findBestProduction(searchResults, options);

    if (!bestMatch) {
      console.log(`  ❌ No suitable IBDB production found for "${title}"`);
      return notFound;
    }

    // Step 3: Extract dates from the production page
    const dates = await extractDatesFromIBDBPage(bestMatch.url);

    if (!dates.openingDate && !dates.previewsStartDate) {
      console.log(`  ❌ No dates extracted from IBDB page for "${title}"`);
      return { ...notFound, ibdbUrl: bestMatch.url };
    }

    console.log(`  ✅ IBDB dates for "${title}":`);
    if (dates.previewsStartDate) console.log(`     1st Preview: ${dates.previewsStartDate}`);
    if (dates.openingDate) console.log(`     Opening: ${dates.openingDate}`);
    if (dates.closingDate) console.log(`     Closing: ${dates.closingDate}`);

    return {
      previewsStartDate: dates.previewsStartDate,
      openingDate: dates.openingDate,
      closingDate: dates.closingDate,
      ibdbUrl: dates.ibdbUrl,
      found: true
    };

  } catch (e) {
    console.log(`  ⚠️  IBDB lookup failed for "${title}": ${e.message}`);
    return notFound;
  }
}

/**
 * Batch lookup IBDB dates for multiple shows with rate limiting
 * @param {Array<{title: string, openingYear?: number, venue?: string}>} shows
 * @param {Object} options
 * @param {number} [options.rateLimitMs=1500] - Delay between requests
 * @param {number} [options.maxConcurrent=1] - Max concurrent requests
 * @returns {Promise<Map<string, Object>>} Map of title -> date results
 */
async function batchLookupIBDBDates(shows, options = {}) {
  const { rateLimitMs = RATE_LIMIT_MS } = options;
  const results = new Map();

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    console.log(`\n📌 [${i + 1}/${shows.length}] Looking up "${show.title}"...`);

    const dates = await lookupIBDBDates(show.title, {
      openingYear: show.openingYear,
      venue: show.venue
    });

    results.set(show.title, dates);

    // Rate limit between requests (skip after last one)
    if (i < shows.length - 1) {
      await sleep(rateLimitMs);
    }
  }

  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  searchIBDB,
  extractDatesFromIBDBPage,
  findBestProduction,
  lookupIBDBDates,
  batchLookupIBDBDates,
  parseIBDBDate
};
