#!/usr/bin/env node
/**
 * Broadway.com Runtime Scraper
 *
 * Scrapes runtime and intermission data from Broadway.com.
 *
 * Two sources:
 * 1. Centralized table: broadway.com/broadway-guide/54/broadway-run-times/
 *    - All currently running shows in one page (1 request)
 * 2. Individual show pages: broadway.com/shows/{slug}/
 *    - Closed shows, discovered via Google SERP
 *
 * Usage:
 *   const { scrapeCurrentRuntimes, scrapeShowRuntime, parseRuntimeText } = require('./lib/broadway-com-runtimes');
 *   const results = await scrapeCurrentRuntimes();
 *   // => [{ title: "Aladdin", runtime: "2h 30m", intermissions: 1 }, ...]
 */

const { fetchPage, cleanup } = require('./scraper');
const { matchTitleToShow, loadShows } = require('./show-matching');

const RUNTIMES_URL = 'https://www.broadway.com/broadway-guide/54/broadway-run-times/';

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse natural-language runtime text into compact format.
 *
 * Input examples:
 *   "2 hours and 40 minutes" → "2h 40m"
 *   "85 minutes"             → "1h 25m"
 *   "1 hour and 20 minutes"  → "1h 20m"
 *   "2 hours"                → "2h 0m"
 *   "90 minutes"             → "1h 30m"
 *   "1:30"                   → "1h 30m"
 *   "2h 15m"                 → "2h 15m" (already formatted)
 *
 * @param {string} text - Runtime text from Broadway.com
 * @returns {string|null} Formatted runtime like "2h 30m" or null if unparseable
 */
function parseRuntimeText(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (!t || t === 'n/a' || t === 'tbd' || t === 'tba' || t === 'varies') return null;

  // Already in our format: "2h 30m"
  const alreadyFormatted = t.match(/^(\d+)h\s*(\d+)m$/);
  if (alreadyFormatted) {
    return `${parseInt(alreadyFormatted[1])}h ${parseInt(alreadyFormatted[2])}m`;
  }

  // "X hours and Y minutes" or "X hour and Y minutes"
  const hoursAndMinutes = t.match(/(\d+)\s*hours?\s*(?:and\s*)?(\d+)\s*minutes?/);
  if (hoursAndMinutes) {
    return `${parseInt(hoursAndMinutes[1])}h ${parseInt(hoursAndMinutes[2])}m`;
  }

  // "X hours" only (no minutes)
  const hoursOnly = t.match(/^(\d+)\s*hours?$/);
  if (hoursOnly) {
    return `${parseInt(hoursOnly[1])}h 0m`;
  }

  // "X minutes" only — convert to hours + minutes
  const minutesOnly = t.match(/^(\d+)\s*minutes?$/);
  if (minutesOnly) {
    const totalMins = parseInt(minutesOnly[1]);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `${h}h ${m}m`;
  }

  // "H:MM" format
  const colonFormat = t.match(/^(\d+):(\d{2})$/);
  if (colonFormat) {
    return `${parseInt(colonFormat[1])}h ${parseInt(colonFormat[2])}m`;
  }

  console.warn(`  ⚠️  Could not parse runtime: "${text}"`);
  return null;
}

/**
 * Parse intermission text into a number.
 *
 * Input examples:
 *   "One intermission"  → 1
 *   "No intermission"   → 0
 *   "Two intermissions" → 2
 *   "1 intermission"    → 1
 *   "None"              → 0
 *
 * @param {string} text - Intermission text from Broadway.com
 * @returns {number|null} Number of intermissions or null if unparseable
 */
function parseIntermissionText(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (!t || t === 'n/a' || t === 'tbd' || t === 'tba') return null;

  // "No intermission" / "None"
  if (t.includes('no intermission') || t === 'none' || t === 'no') return 0;

  // Word-number mapping
  const wordToNum = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4,
    '1': 1, '2': 2, '3': 3, '4': 4,
  };

  // "One intermission", "Two intermissions", etc.
  const wordMatch = t.match(/^(\w+)\s+intermissions?$/);
  if (wordMatch) {
    const num = wordToNum[wordMatch[1]];
    if (num != null) return num;
  }

  // Just a number
  const numMatch = t.match(/^(\d+)$/);
  if (numMatch) return parseInt(numMatch[1]);

  console.warn(`  ⚠️  Could not parse intermission: "${text}"`);
  return null;
}

// ---------------------------------------------------------------------------
// Scraping: Centralized run-times table
// ---------------------------------------------------------------------------

/**
 * Parse the centralized Broadway.com run-times page (markdown format).
 *
 * Expected markdown table format:
 *   | [Show Title](url) | 2 hours and 40 minutes | One intermission |
 *
 * @param {string} markdown - Page content in markdown
 * @returns {Array<{title: string, runtime: string|null, intermissions: number|null, broadwayComUrl: string|null}>}
 */
function parseRuntimesTable(markdown) {
  const results = [];
  const lines = markdown.split('\n');

  for (const line of lines) {
    // Skip non-table lines and header/separator rows
    if (!line.startsWith('|') || line.includes('---') || line.toLowerCase().includes('show name')) continue;

    // Split into columns
    const cols = line.split('|').map(c => c.trim()).filter(c => c);
    if (cols.length < 3) continue;

    // Column 0: Show title (may be a markdown link)
    const titleCol = cols[0];
    let title = titleCol;
    let broadwayComUrl = null;

    // Extract from markdown link: [Title](url)
    const linkMatch = titleCol.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      title = linkMatch[1].trim();
      broadwayComUrl = linkMatch[2].trim();
    }

    // Column 1: Runtime
    const runtime = parseRuntimeText(cols[1]);

    // Column 2: Intermission
    const intermissions = parseIntermissionText(cols[2]);

    if (title && (runtime || intermissions != null)) {
      results.push({ title, runtime, intermissions, broadwayComUrl });
    }
  }

  return results;
}

/**
 * Parse the centralized run-times page from HTML format.
 *
 * Looks for <table> rows with show name, runtime, and intermission columns.
 *
 * @param {string} html - Page content in HTML
 * @returns {Array<{title: string, runtime: string|null, intermissions: number|null, broadwayComUrl: string|null}>}
 */
function parseRuntimesTableHTML(html) {
  const results = [];

  // Match table rows: <tr><td>...<a href="...">Title</a>...</td><td>runtime</td><td>intermission</td></tr>
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowContent = rowMatch[1];

    // Extract cells
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowContent)) !== null) {
      cells.push(cellMatch[1].trim());
    }

    if (cells.length < 3) continue;

    // Cell 0: Show title (may contain <a href="...">Title</a>)
    let title = cells[0].replace(/<[^>]+>/g, '').trim();
    let broadwayComUrl = null;
    const linkMatch = cells[0].match(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/);
    if (linkMatch) {
      broadwayComUrl = linkMatch[1];
      title = linkMatch[2].trim();
    }

    // Cell 1: Runtime
    const runtimeText = cells[1].replace(/<[^>]+>/g, '').trim();
    const runtime = parseRuntimeText(runtimeText);

    // Cell 2: Intermission
    const intermissionText = cells[2].replace(/<[^>]+>/g, '').trim();
    const intermissions = parseIntermissionText(intermissionText);

    // Skip header rows
    if (title.toLowerCase().includes('show') && runtimeText.toLowerCase().includes('time')) continue;

    if (title && (runtime || intermissions != null)) {
      results.push({ title, runtime, intermissions, broadwayComUrl });
    }
  }

  return results;
}

/**
 * Scrape the centralized Broadway.com run-times page.
 * Returns runtime data for all currently running shows (1 HTTP request).
 *
 * @returns {Promise<Array<{title: string, runtime: string|null, intermissions: number|null, broadwayComUrl: string|null}>>}
 */
async function scrapeCurrentRuntimes() {
  console.log('📋 Scraping Broadway.com centralized run-times page...');

  const result = await fetchPage(RUNTIMES_URL);
  const entries = result.format === 'markdown'
    ? parseRuntimesTable(result.content)
    : parseRuntimesTableHTML(result.content);

  console.log(`  Found ${entries.length} shows with runtime data`);
  return entries;
}

// ---------------------------------------------------------------------------
// Scraping: Individual show pages (for closed shows)
// ---------------------------------------------------------------------------

/**
 * Parse runtime from an individual Broadway.com show page.
 *
 * The page typically contains a "Run Time" section with text like
 * "2 hours and 30 minutes with one intermission".
 *
 * @param {string} content - Page content (markdown or HTML)
 * @param {string} format - 'markdown' or 'html'
 * @returns {{runtime: string|null, intermissions: number|null}}
 */
function parseShowPageRuntime(content, format) {
  let text = content;

  // Extract text content from HTML if needed
  if (format === 'html') {
    text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }

  // Look for runtime patterns in the page text
  // Pattern: "Run Time: 2 hours and 30 minutes" or "Running Time: ..."
  const runtimeSection = text.match(/(?:run(?:ning)?\s*time)[:\s]*([^.\n]+)/i);
  if (!runtimeSection) {
    return { runtime: null, intermissions: null };
  }

  const section = runtimeSection[1].trim();

  // Check if intermission info is in the same line
  let runtime = null;
  let intermissions = null;

  // "2 hours and 30 minutes with one intermission"
  const combinedMatch = section.match(/(.+?)\s+with\s+(.*intermission.*)/i);
  if (combinedMatch) {
    runtime = parseRuntimeText(combinedMatch[1]);
    intermissions = parseIntermissionText(combinedMatch[2]);
  } else if (section.match(/intermission/i)) {
    // "No intermission" might appear in the runtime section
    const parts = section.split(/,\s*/);
    if (parts.length >= 2) {
      runtime = parseRuntimeText(parts[0]);
      intermissions = parseIntermissionText(parts[1]);
    } else {
      runtime = parseRuntimeText(section.replace(/\s*(?:with\s+)?(?:no|one|two|three)\s+intermissions?/i, ''));
      intermissions = parseIntermissionText(section);
    }
  } else {
    runtime = parseRuntimeText(section);
  }

  return { runtime, intermissions };
}

/**
 * Scrape runtime for a single show from its Broadway.com page.
 * Uses Google SERP to discover the URL if not provided.
 *
 * @param {string} showTitle - The show title to search for
 * @param {string} [broadwayComUrl] - Direct URL if known
 * @returns {Promise<{runtime: string|null, intermissions: number|null}>}
 */
async function scrapeShowRuntime(showTitle, broadwayComUrl) {
  let url = broadwayComUrl;

  // If no URL provided, construct a likely one from the title
  if (!url) {
    const slug = showTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .trim();
    url = `https://www.broadway.com/shows/${slug}/`;
  }

  try {
    const result = await fetchPage(url);
    return parseShowPageRuntime(result.content, result.format);
  } catch (error) {
    console.warn(`  ⚠️  Failed to scrape runtime for "${showTitle}": ${error.message}`);
    return { runtime: null, intermissions: null };
  }
}

/**
 * Match scraped runtime entries to shows.json and return enrichment map.
 *
 * @param {Array} runtimeEntries - From scrapeCurrentRuntimes()
 * @param {Object[]} [shows] - Shows array (loaded from shows.json if not provided)
 * @returns {Object<string, {runtime: string, intermissions: number}>} Map of showId → runtime data
 */
function matchRuntimesToShows(runtimeEntries, shows) {
  if (!shows) shows = loadShows();
  const enrichments = {};
  let matched = 0;
  let unmatched = 0;

  for (const entry of runtimeEntries) {
    const match = matchTitleToShow(entry.title, shows);
    if (match) {
      const showId = match.show.id;
      enrichments[showId] = {
        runtime: entry.runtime,
        intermissions: entry.intermissions,
      };
      matched++;
    } else {
      console.log(`  ❓ Unmatched: "${entry.title}"`);
      unmatched++;
    }
  }

  console.log(`  Matched: ${matched}, Unmatched: ${unmatched}`);
  return enrichments;
}

module.exports = {
  parseRuntimeText,
  parseIntermissionText,
  parseRuntimesTable,
  parseRuntimesTableHTML,
  parseShowPageRuntime,
  scrapeCurrentRuntimes,
  scrapeShowRuntime,
  matchRuntimesToShows,
  RUNTIMES_URL,
};
