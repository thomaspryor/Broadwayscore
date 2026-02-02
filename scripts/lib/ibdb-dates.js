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

const { JSDOM } = require('jsdom');
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

  // Try ScrapingBee Google SERP first (dedicated search endpoint)
  try {
    const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY;
    if (scrapingBeeKey) {
      const url = `https://app.scrapingbee.com/api/v1/store/google?` +
        `api_key=${scrapingBeeKey}` +
        `&search=${encodeURIComponent(query)}`;

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
        if (results.length > 0) {
          console.log(`  ✅ Found ${results.length} IBDB production URL(s) via ScrapingBee SERP`);
        }
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

  // Normalize content to plain text for regex matching
  // IBDB pages may come as HTML or markdown depending on scraper
  let text = content;
  if (content.includes('<html') || content.includes('<div')) {
    // HTML content - extract text via JSDOM
    try {
      const dom = new JSDOM(content);
      text = dom.window.document.body.textContent || '';
    } catch (e) {
      // Fall through with raw content
    }
  }

  // Check if we got redirected to homepage (page not found)
  if (text.includes('Opening Nights in History') && !text.includes('Opening Date')) {
    console.log(`  ⚠️  IBDB page redirected to homepage (production not found)`);
    return result;
  }

  // Date pattern: month day, year (e.g., "Nov 12, 2024" or "November 12, 2024")
  const datePattern = '([A-Z][a-z]{2,8}\\s+\\d{1,2},\\s*\\d{4})';

  // Opening Date - try multiple formats seen in IBDB pages
  const openingPatterns = [
    new RegExp('Opening Date\\s*' + datePattern),
    new RegExp('Open Date:\\s*' + datePattern),
    new RegExp('Opening Date[\\s\\S]{0,20}?' + datePattern)
  ];
  for (const pat of openingPatterns) {
    const m = text.match(pat);
    if (m) {
      result.openingDate = parseIBDBDate(m[1]);
      if (result.openingDate) break;
    }
  }

  // 1st Preview
  const previewPatterns = [
    new RegExp('1st Preview\\s*' + datePattern),
    new RegExp('1st Preview[\\s\\S]{0,20}?' + datePattern),
    new RegExp('Previews?\\s+' + datePattern)
  ];
  for (const pat of previewPatterns) {
    const m = text.match(pat);
    if (m) {
      result.previewsStartDate = parseIBDBDate(m[1]);
      if (result.previewsStartDate) break;
    }
  }

  // Closing Date
  const closingPatterns = [
    new RegExp('Closing Date\\s*' + datePattern),
    new RegExp('Close Date:\\s*' + datePattern),
    new RegExp('Closing Date[\\s\\S]{0,20}?' + datePattern)
  ];
  for (const pat of closingPatterns) {
    const m = text.match(pat);
    if (m) {
      result.closingDate = parseIBDBDate(m[1]);
      if (result.closingDate) break;
    }
  }

  // Theatre - from text near "Theatres" heading
  const theatreMatch = text.match(/Theatres?\s*([A-Z][A-Za-z\s']+Theatre)/);
  if (theatreMatch) {
    result.theatre = theatreMatch[1].trim();
  }

  // Creative team extraction
  result.creativeTeam = extractCreativeTeamFromText(text);

  return result;
}

/**
 * Extract creative team members from IBDB page text.
 * IBDB credits are semicolon-separated entries like:
 *   "Directed by Saheem Ali; Choreographed by Patricia Delgado and Justin Peck; Book by Marco Ramirez"
 *   "Scenic Design by Arnulfo Maldonado; Musical Supervisor: Dean Sharenow"
 *
 * @param {string} text - Plain text content of the IBDB page
 * @returns {Array<{name: string, role: string}>}
 */
function extractCreativeTeamFromText(text) {
  const creativeTeam = [];
  const seen = new Set(); // Prevent duplicates
  const musicAndLyricsNames = new Set(); // Track "Music & Lyrics" names to suppress standalone Music/Lyrics

  // Role patterns: [regex, role label]
  // Order matters — "Music and Lyrics by" must come before "Music by" and "Lyrics by"
  const rolePatterns = [
    [/Music and Lyrics by\s+([^;:\n]+)/gi, 'Music & Lyrics'],
    [/Directed by\s+([^;:\n]+)/gi, 'Director'],
    [/Choreograph(?:ed|y) by\s+([^;:\n]+)/gi, 'Choreographer'],
    [/Book by\s+([^;:\n]+)/gi, 'Book'],
    [/Scenic Design by\s+([^;:\n]+)/gi, 'Scenic Design'],
    [/Costume Design by\s+([^;:\n]+)/gi, 'Costume Design'],
    [/Lighting Design by\s+([^;:\n]+)/gi, 'Lighting Design'],
    [/Sound Design by\s+([^;:\n]+)/gi, 'Sound Design'],
    [/Music (?:orchestrated|Orchestrated) by\s+([^;:\n]+)/gi, 'Orchestrations'],
    [/Orchestrations by\s+([^;:\n]+)/gi, 'Orchestrations'],
    [/Musical Supervisor:\s*([^;:\n]+)/gi, 'Music Supervision'],
    [/Musical Director:\s*([^;:\n]+)/gi, 'Music Direction'],
    [/Music direction by\s+([^;:\n]+)/gi, 'Music Direction'],
    [/Lyrics by\s+([^;:\n]+)/gi, 'Lyrics'],
    [/(?:^|[;.\n]\s*)Music by\s+([^;:\n]+)/gi, 'Music'],
  ];

  for (const [pattern, role] of rolePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const rawName = match[1].trim()
        // Strip trailing punctuation/junk
        .replace(/[.,;:\s]+$/, '')
        // Strip common IBDB trailing noise
        .replace(/\s+Based on\b.*$/i, '')
        .replace(/\s+Originally\b.*$/i, '')
        .replace(/\s+Additional\b.*$/i, '');

      if (!rawName || rawName.length < 2 || rawName.length > 100) continue;

      // Skip if this looks like a non-name (dates, numbers, etc.)
      if (/^\d/.test(rawName) || /\d{4}/.test(rawName)) continue;

      // Track "Music & Lyrics" names so we skip redundant standalone Lyrics/Music
      if (role === 'Music & Lyrics') {
        musicAndLyricsNames.add(rawName.toLowerCase());
      }

      // Skip standalone "Lyrics" or "Music" if same person already credited for "Music & Lyrics"
      if ((role === 'Lyrics' || role === 'Music') && musicAndLyricsNames.has(rawName.toLowerCase())) {
        continue;
      }

      const key = `${role}::${rawName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      creativeTeam.push({ name: rawName, role });
    }
  }

  return creativeTeam;
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
    creativeTeam: [],
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
      return { ...notFound, ibdbUrl: bestMatch.url, creativeTeam: dates.creativeTeam || [] };
    }

    console.log(`  ✅ IBDB dates for "${title}":`);
    if (dates.previewsStartDate) console.log(`     1st Preview: ${dates.previewsStartDate}`);
    if (dates.openingDate) console.log(`     Opening: ${dates.openingDate}`);
    if (dates.closingDate) console.log(`     Closing: ${dates.closingDate}`);
    if (dates.creativeTeam && dates.creativeTeam.length > 0) {
      console.log(`     Creative team: ${dates.creativeTeam.length} role(s)`);
    }

    return {
      previewsStartDate: dates.previewsStartDate,
      openingDate: dates.openingDate,
      closingDate: dates.closingDate,
      creativeTeam: dates.creativeTeam || [],
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
  extractCreativeTeamFromText,
  findBestProduction,
  lookupIBDBDates,
  batchLookupIBDBDates,
  parseIBDBDate
};
