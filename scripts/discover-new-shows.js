#!/usr/bin/env node
/**
 * Broadway New Show Discovery
 *
 * Discovers new Broadway shows using TodayTix API (primary) with
 * Broadway.org scraping as fallback.
 *
 * Usage: node scripts/discover-new-shows.js [--dry-run] [--include-off-broadway] [--include-west-end]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { JSDOM } = require('jsdom');
const { fetchPage, cleanup } = require('./lib/scraper');
const { parseShortDate } = require('./lib/show-score-status');
const { checkKnownShow, detectPlayFromTitle } = require('./lib/known-shows');
const { slugify, checkForDuplicate } = require('./lib/deduplication');
const { batchLookupIBDBDates, checkIBDBForPriorProductions } = require('./lib/ibdb-dates');
const { getTheaterAddress } = require('./lib/venue-addresses');
const { splitCombinedCredits } = require('./lib/credit-splitting');
const { scrapeCurrentRuntimes, matchRuntimesToShows, batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');
const { isLondonMarket, isOffWestEndVenue } = require('./lib/venue-classification');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'new-shows-pending.json');

const dryRun = process.argv.includes('--dry-run');
const includeOffBroadway = process.argv.includes('--include-off-broadway');
const includeWestEnd = process.argv.includes('--include-west-end');
const consumeShowScoreCandidates = process.argv.includes('--consume-show-score-candidates');
const verbose = process.argv.includes('--verbose');

const CANDIDATES_PATH = path.join(__dirname, '..', 'data', 'show-score-candidates.json');
const URLS_PATH = path.join(__dirname, '..', 'data', 'show-score-urls.json');

// Broadway.org shows page
const BROADWAY_ORG_URL = 'https://www.broadway.org/shows/';

// Non-theater content patterns — shared across all markets (Broadway, OB, West End)
const NON_THEATER_PATTERNS = [
  'comedy club', 'comedy night', 'stand-up', 'standup',
  'magic show:', 'magick', 'bubble show', // NOT 'magic' alone (false-positive: Magic Mike, The Magic Show, Magic/Bird)
  'orchestra', 'symphony', 'symphonic', 'philharmonic', 'chamber music',
  'quartet', 'quintet', 'ensemble',
  'the metropolitan opera', // Met Opera productions (Turandot, La Boheme, etc.)
  'royal opera', 'opera house', // London opera
  'selected shorts', 'book club', 'in conversation with',
  'nt live:', 'london\'s west end:',
  'dance company', 'dance +', 'ballet',
  'lottery', 'accessible lottery',
  'meet the music', 'lyrics & lyricists',
  'uptown showdown', 'amateur night',
  'flamenco festival', 'circus',
  'in concert', 'concert performance',
  'company xiv', // burlesque/cabaret company
  'rakugo', // Japanese storytelling
  'museum of', 'exhibit', 'exhibition', // museums/exhibits, not shows
  'immersive experience', // non-theatrical experiences
  'game show', 'gameshow', 'punishment game', // game shows (BATSU etc.)
  'jazz at lincoln center', // jazz concerts, not theater
];

// West End-specific additional patterns — shared by TodayTix London, OLT, and ShowScore candidate processing
const WE_EXTRA_PATTERNS = [
  'dining experience', 'candlelight', 'by candlelight',
  'discovering dinosaurs', 'prehistoric planet',
  'classic penguins', // comedy fringe acts
];
// Solo performer names (no show title) — likely concerts not theater
const WE_SOLO_PERFORMER_PATTERN = /^[A-Z][a-z]+ [A-Z][a-z]+$/; // "FirstName LastName" only

// Known non-show titles that TodayTix lists but aren't theatrical productions
const EXCLUDED_TITLES = [
  'the museum of broadway',
  'batsu!', // restaurant game show at Kogame
  'jeremy pelt and endea owens', // Jazz at Lincoln Center concert
  'caribbean crossroads', // Jazz at Lincoln Center concert
  'lindy west: adult braces', // Symphony Space author reading
  'dave eggers: contrapposto', // Symphony Space author reading
  'percival everett: james', // Symphony Space author reading
  'abby jimenez: the night we met', // Symphony Space author reading
  'caro claire burke: yesteryear', // Symphony Space author reading
  'the pelicot trial', // One-night event at church
  'turandot', // Met Opera
  'madama butterfly', // Met Opera
  'la boheme', // Met Opera (also matches "La Bohème" after normalization)
];

// Venues that categorically do not host theater
const NON_THEATER_VENUES = [
  'kogame',           // restaurant (BATSU game show)
  'appel room',       // Jazz at Lincoln Center
  'rose theater',     // Jazz at Lincoln Center (review feedback: shortened for robustness)
];

// Check if a show is a one-night event (startDate === endDate)
// Only applied to TodayTix ingestion, not IBDB historical data
function isOneNightShow(show) {
  if (!show.startDate || !show.endDate) return false;
  return show.startDate === show.endDate;
}

function isNonTheaterContent(show) {
  const title = (show.displayName || show.name || '').toLowerCase();
  if (EXCLUDED_TITLES.some(excluded => title.includes(excluded))) return true;
  if (NON_THEATER_PATTERNS.some(pattern => title.includes(pattern))) return true;
  const subcatNames = (show.subcategories || []).map(sc => sc.name);
  if (subcatNames.includes('Classical')) return true; // Opera

  // Gate 2: Venue blocklist — categorically non-theater venues
  const venue = (typeof show.venue === 'string' ? show.venue : show.venue?.name || '').toLowerCase();
  if (NON_THEATER_VENUES.some(v => venue.includes(v))) return true;

  // Gate 4: Synopsis keywords — catches shows with clean titles but non-theater descriptions
  const description = (show.description || '').toLowerCase();
  const SYNOPSIS_KEYWORDS = ['game show', 'punishment game', 'jazz at lincoln center'];
  if (SYNOPSIS_KEYWORDS.some(kw => description.includes(kw))) return true;

  return false;
}

// TodayTix API - public, no auth required, no Cloudflare
function fetchTodayTixPage(offset = 0, limit = 100) {
  return new Promise((resolve, reject) => {
    const url = `https://api.todaytix.com/api/v2/shows?location=1&limit=${limit}&offset=${offset}`;
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix API HTTP ${response.statusCode}`));
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse TodayTix API response')); }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchShowsFromTodayTix() {
  console.log('Fetching Broadway shows from TodayTix API...');
  const allShows = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await fetchTodayTixPage(offset, limit);
    if (!response.data || response.data.length === 0) break;
    allShows.push(...response.data);
    if (allShows.length >= (response.pagination?.total || 0)) break;
    offset += limit;
  }

  // Filter by subcategories: Broadway always, Off-Broadway when flag is set
  // Gate 1: One-night shows are filtered at TodayTix ingestion (not IBDB historical)
  const broadwayShows = allShows.filter(s =>
    s.subcategories?.some(sc => sc.name === 'Broadway') && !isNonTheaterContent(s) && !isOneNightShow(s)
  );
  const offBroadwayShows = includeOffBroadway ? allShows.filter(s => {
    if (!s.subcategories?.some(sc => sc.name === 'Off Broadway')) return false;
    if (s.subcategories?.some(sc => sc.name === 'Broadway')) return false; // exclude shows tagged as both
    return !isNonTheaterContent(s) && !isOneNightShow(s);
  }) : [];

  // Log filtered shows for CI visibility
  const filteredByContent = allShows.filter(s => isNonTheaterContent(s));
  const filteredByOneNight = allShows.filter(s => !isNonTheaterContent(s) && isOneNightShow(s));
  if (filteredByContent.length > 0) {
    console.log(`  Filtered ${filteredByContent.length} non-theater content: ${filteredByContent.slice(0, 5).map(s => s.displayName || s.name).join(', ')}${filteredByContent.length > 5 ? '...' : ''}`);
  }
  if (filteredByOneNight.length > 0) {
    console.log(`  Filtered ${filteredByOneNight.length} one-night events: ${filteredByOneNight.map(s => s.displayName || s.name).join(', ')}`);
  }

  // Deduplicate by displayName (API sometimes has duplicate listings)
  const seen = new Set();
  const showsList = [];
  for (const show of broadwayShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;
    seen.add(title);

    showsList.push({
      title,
      venue: (typeof show.venue === 'string' ? show.venue : show.venue?.name) || 'TBA',
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: show.startDate || null,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      description: show.description || '',
      todayTixCategory: show.category?.name || null,
    });
  }

  for (const show of offBroadwayShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;
    seen.add(title);

    showsList.push({
      title,
      venue: (typeof show.venue === 'string' ? show.venue : show.venue?.name) || 'TBA',
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: show.startDate || null,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      category: 'off-broadway',
      description: show.description || '',
      todayTixCategory: show.category?.name || null,
    });
  }

  console.log(`TodayTix API: ${allShows.length} total NYC shows, ${broadwayShows.length} Broadway-tagged, ${offBroadwayShows.length} Off-Broadway-tagged, ${showsList.length} unique`);
  return showsList;
}

// TodayTix London API - location=2 for London West End
function fetchTodayTixLondonPage(offset = 0, limit = 100) {
  return new Promise((resolve, reject) => {
    const url = `https://api.todaytix.com/api/v2/shows?location=2&limit=${limit}&offset=${offset}`;
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix London API HTTP ${response.statusCode}`));
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse TodayTix London API response')); }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchShowsFromTodayTixLondon() {
  console.log('Fetching West End shows from TodayTix London API...');
  const allShows = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await fetchTodayTixLondonPage(offset, limit);
    if (!response.data || response.data.length === 0) break;
    allShows.push(...response.data);
    if (allShows.length >= (response.pagination?.total || 0)) break;
    offset += limit;
  }

  // Filter to West End shows
  // TodayTix tags shows as "West End" OR "Off West End" — many legitimate WE productions
  // (Starlight Express, Into the Woods, Witness for the Prosecution) only have "Off West End".
  // For "Off West End" shows, require either:
  //   1. Top-level category is Plays or Musicals, OR
  //   2. Category is "Immersive Experiences" but has theater subcategories (Drama, Classic, Comedy)
  //      — catches Witness for the Prosecution which TodayTix miscategorizes as immersive
  const WE_THEATER_CATEGORIES = new Set(['Plays', 'Musicals']);
  const WE_THEATER_SUBCATEGORIES = new Set(['Drama', 'Classic', 'Comedy']);
  const westEndShows = allShows.filter(s => {
    const subcatNames = (s.subcategories || []).map(sc => sc.name);
    const isWestEnd = subcatNames.includes('West End') || subcatNames.includes('Broadway');
    const isOffWestEnd = subcatNames.includes('Off West End') && !isWestEnd;

    if (!isWestEnd && !isOffWestEnd) return false;

    // Off West End shows need category-level filtering to exclude noise
    if (isOffWestEnd) {
      const isTheaterCategory = WE_THEATER_CATEGORIES.has(s.category?.name);
      const hasTheaterSubcats = subcatNames.some(sc => WE_THEATER_SUBCATEGORIES.has(sc));
      if (!isTheaterCategory && !hasTheaterSubcats) return false;
    }

    return !isNonTheaterContent(s) && !isOneNightShow(s);
  });

  const seen = new Set();
  const showsList = [];
  for (const show of westEndShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;

    const titleLower = title.toLowerCase();
    if (WE_EXTRA_PATTERNS.some(p => titleLower.includes(p))) continue;
    // Skip likely solo concerts (just a person's name)
    if (WE_SOLO_PERFORMER_PATTERN.test(title) && !titleLower.includes('musical') && !titleLower.includes('play')) continue;

    seen.add(title);
    showsList.push({
      title,
      venue: (typeof show.venue === 'string' ? show.venue : show.venue?.name) || 'TBA',
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: show.startDate || null,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      category: isOffWestEndVenue(
        (typeof show.venue === 'string' ? show.venue : show.venue?.name) || 'TBA'
      ) ? 'off-west-end' : 'west-end',
      description: show.description || '',
      todayTixCategory: show.category?.name || null,
    });
  }

  console.log(`TodayTix London API: ${allShows.length} total London shows, ${westEndShows.length} West End-tagged, ${showsList.length} unique`);
  return showsList;
}

// ── Official London Theatre (SOLT) — supplementary WE discovery source ──

const OLT_URL = 'https://officiallondontheatre.com/theatre-tickets/';

async function fetchShowsFromOfficialLondonTheatre() {
  console.log('Fetching West End shows from Official London Theatre (SOLT)...');

  const result = await fetchPage(OLT_URL, { renderJs: false });
  const html = result.content;

  if (html.length < 3000) {
    console.log(`  OLT: content suspiciously short (${html.length} bytes), skipping`);
    return [];
  }

  // Parse JSON-LD TheaterEvent blocks (each is a standalone <script type="application/ld+json">)
  const dom = new JSDOM(html);
  const ldScripts = dom.window.document.querySelectorAll('script[type="application/ld+json"]');
  const shows = [];
  const seen = new Set();

  for (const script of ldScripts) {
    try {
      const data = JSON.parse(script.textContent);
      // Only accept objects where @type is exactly "TheaterEvent" (string, not array)
      if (typeof data['@type'] !== 'string' || data['@type'] !== 'TheaterEvent') continue;
      // Skip any with subEvent nesting (season containers)
      if (data.subEvent) continue;

      const title = (data.name || '').trim()
        .replace(/&#8217;|&#8216;|[\u2018\u2019]/g, "'")  // Curly quotes → straight
        .replace(/&#8220;|&#8221;|[\u201C\u201D]/g, '"')  // Curly double quotes → straight
        .replace(/&#8211;|[\u2013]/g, '–').replace(/&#8212;|[\u2014]/g, '—')
        .replace(/&#038;/g, '&').replace(/&amp;/g, '&');
      if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;

      // Apply shared filters
      const titleLower = title.toLowerCase();
      if (NON_THEATER_PATTERNS.some(p => titleLower.includes(p))) continue;
      if (WE_EXTRA_PATTERNS.some(p => titleLower.includes(p))) continue;
      if (WE_SOLO_PERFORMER_PATTERN.test(title) && !titleLower.includes('musical') && !titleLower.includes('play')) continue;

      const venue = (typeof data.location === 'object' ? data.location.name : data.location) || 'TBA';
      const endDate = data.endDate === 'null' || data.endDate === null ? null : data.endDate || null;

      seen.add(titleLower);
      shows.push({
        title,
        venue,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        openingDate: data.startDate || null,
        closingDate: endDate,
        category: 'west-end',
        description: (data.description || '').substring(0, 500),
      });
    } catch (e) {
      // Skip malformed JSON-LD blocks
    }
  }

  // Guards
  if (shows.length > 100) {
    console.log(`  ⚠️  OLT returned ${shows.length} shows (expected ~75). Possible data issue — capping at 100.`);
    shows.length = 100;
  }
  if (shows.length < 5 && shows.length > 0) {
    console.log(`  ⚠️  OLT returned only ${shows.length} shows (expected ~75). Possible partial fetch — discarding.`);
    return [];
  }

  console.log(`  OLT: ${ldScripts.length} JSON-LD blocks, ${shows.length} TheaterEvent shows parsed`);
  return shows;
}

// ── Cross-source divergence logging ──

function logWESourceDivergence(todayTixShows, oltShows) {
  if (todayTixShows.length === 0 || oltShows.length === 0) return; // Can't compare

  const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/^(the|a|an) /, '').trim();
  const ttTitles = new Set(todayTixShows.map(s => normalize(s.title)));
  const oltTitles = new Set(oltShows.map(s => normalize(s.title)));

  const oltOnly = [...oltTitles].filter(t => !ttTitles.has(t));
  const ttOnly = [...ttTitles].filter(t => !oltTitles.has(t));
  const overlap = [...oltTitles].filter(t => ttTitles.has(t)).length;

  console.log(`  WE source overlap: ${overlap} shared, ${oltOnly.length} OLT-only, ${ttOnly.length} TodayTix-only`);
  if (oltOnly.length > 0) {
    const display = oltOnly.slice(0, 10);
    console.log(`  OLT-only shows: ${display.join(', ')}${oltOnly.length > 10 ? ` ...+${oltOnly.length - 10} more` : ''}`);
  }
  if (ttOnly.length > 0) {
    const display = ttOnly.slice(0, 10);
    console.log(`  TodayTix-only shows: ${display.join(', ')}${ttOnly.length > 10 ? ` ...+${ttOnly.length - 10} more` : ''}`);
  }
}

// ── TodayTix search for ShowScore candidate validation ──

function searchTodayTixByTitle(title, location = 1) {
  const query = encodeURIComponent(title);
  const url = `https://api.todaytix.com/api/v2/shows?query=${query}&location=${location}`;
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        resolve(null);
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.data || json.data.length === 0) { resolve(null); return; }

          // Normalize for matching
          const normTitle = title.toLowerCase()
            .replace(/['']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

          // Exact match first
          const exact = json.data.find(s => {
            const n = (s.displayName || s.name || '').toLowerCase()
              .replace(/['']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            return n === normTitle;
          });
          if (exact) { resolve(exact); return; }

          // Fuzzy match with containment check to prevent venue-based false matches
          // (e.g., searching "Beetlejuice" and getting "Mary Poppins" at same venue)
          const ourWords = normTitle.split(' ').filter(w => w.length > 2);
          for (const show of json.data) {
            const apiName = (show.displayName || show.name || '').toLowerCase()
              .replace(/['']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            const ourInTheirs = ourWords.filter(w => apiName.includes(w)).length;
            const ourRatio = ourWords.length > 0 ? ourInTheirs / ourWords.length : 0;
            if (ourRatio < 0.6) continue;

            // If all our words match AND we have >1 significant word, accept
            // (our title is contained in theirs, e.g., "Beetlejuice" → "Beetlejuice The Musical")
            // Single-word titles need exact match to avoid "Chicago" → "Chicago Fire"
            if (ourRatio >= 1.0 && ourWords.length > 1) {
              resolve(show);
              return;
            }
            // Single significant word: only match if API name has <=3 significant
            // words (prevents "Chicago" → "Chicago Fire" but allows "Cats" → "Cats The Musical")
            if (ourRatio >= 1.0 && ourWords.length === 1) {
              const theirWords = apiName.split(' ').filter(w => w.length > 2);
              const unmatched = theirWords.filter(w => !normTitle.includes(w));
              // Allow common suffixes (the, musical, show) but reject titles with
              // unrelated content words
              const theatreFluff = new Set(['the', 'musical', 'show', 'play', 'new', 'disneys', 'disney']);
              const realUnmatched = unmatched.filter(w => !theatreFluff.has(w));
              if (realUnmatched.length === 0) {
                resolve(show);
                return;
              }
              continue;
            }

            // Partial forward match: also require reverse containment to prevent
            // short-word overlap false positives
            const theirWords = apiName.split(' ').filter(w => w.length > 2);
            const theirsInOurs = theirWords.filter(w => normTitle.includes(w)).length;
            const theirRatio = theirWords.length > 0 ? theirsInOurs / theirWords.length : 0;
            if (theirRatio >= 0.4) {
              resolve(show);
              return;
            }
          }
          resolve(null);
        } catch { resolve(null); }
      });
      response.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

/**
 * Fetch a ShowScore page and extract status/dates from the info-top-line element.
 * Returns { ssStatus, openingDate, closingDate, venue, runtime } or null on failure.
 *
 * Status line formats:
 *   "Opens Mar 08"    → previews, openingDate = current year Mar 08
 *   "Open run"        → open
 *   "Ends Mar 28"     → open, closingDate = current year Mar 28
 *   "Ends May 2026"   → open, closingDate = 2026-05-31 (approx)
 *   "Closed"          → closed
 */
async function fetchShowScoreStatus(showScoreUrl) {
  try {
    const result = await fetchPage(showScoreUrl);
    if (!result || !result.content) return null;

    const dom = new JSDOM(result.content);
    const doc = dom.window.document;

    // Extract info-top-line content
    const topLine = doc.querySelector('.show-page-v2__info-top-line');
    if (!topLine) return null;

    // First text node contains the status
    const statusText = topLine.childNodes[0]?.textContent?.trim() || '';
    if (!statusText) return null;

    // Extract venue from the link in info-top-line
    const venueLink = topLine.querySelector('a');
    const venueFull = venueLink?.textContent?.trim() || '';
    // Strip "NYC: " or "London: " prefix
    const venue = venueFull.replace(/^(NYC|London|Chicago|LA):\s*/i, '').trim() || 'TBA';

    // Extract runtime from second segment (between delimiters)
    const delimiters = topLine.querySelectorAll('.show-page-v2__info-top-line-delimiter');
    let runtime = null;
    if (delimiters.length >= 1) {
      const afterFirst = delimiters[0].nextSibling;
      if (afterFirst && afterFirst.nodeType === 3) { // text node
        const rtText = afterFirst.textContent.trim();
        if (/^\d+h\s*\d*m?$/.test(rtText)) runtime = rtText;
      }
    }

    let ssStatus = null;
    let openingDate = null;
    let closingDate = null;

    if (statusText.startsWith('Opens ')) {
      ssStatus = 'previews';
      openingDate = parseShortDate(statusText.replace('Opens ', ''));
    } else if (statusText === 'Open run') {
      ssStatus = 'open';
    } else if (statusText.startsWith('Ends ')) {
      ssStatus = 'open';
      closingDate = parseShortDate(statusText.replace('Ends ', ''));
    } else if (statusText === 'Closed') {
      ssStatus = 'closed';
    }

    return { ssStatus, openingDate, closingDate, venue, runtime };
  } catch (e) {
    console.warn(`  [SS] Failed to fetch ShowScore status for ${showScoreUrl}: ${e.message}`);
    return null;
  }
}

/**
 * Load and validate ShowScore candidates, converting them into the same shape
 * as TodayTix-discovered shows for the dedup pipeline.
 *
 * Tiered validation:
 *   Tier 1: Found on TodayTix → full metadata + all filters
 *   Tier 2: Not on TodayTix → ShowScore page scrape for status/dates
 *   Tier 3: ShowScore fetch fails → title-based filter only, null dates
 */
async function consumeShowScoreCandidatesFile() {
  let candidatesData;
  try {
    candidatesData = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('No ShowScore candidates file found, skipping');
    } else {
      console.warn(`Warning: could not parse ${CANDIDATES_PATH}: ${e.message}`);
    }
    return [];
  }

  const allCandidates = candidatesData.candidates || [];
  if (allCandidates.length === 0) {
    console.log('ShowScore candidates file is empty');
    return [];
  }

  // Only consume OB and WE candidates (Broadway is well-covered by TodayTix)
  const candidates = allCandidates.filter(c =>
    c.category === 'off-broadway' || isLondonMarket(c.category)
  );

  if (candidates.length === 0) {
    console.log('No OB/WE ShowScore candidates to process');
    return [];
  }

  console.log(`Processing ${candidates.length} ShowScore candidates (${allCandidates.length - candidates.length} Broadway skipped)...`);

  const validated = [];
  let ttConfirmed = 0;
  let ttMissing = 0;
  let filteredNonTheater = 0;
  let filteredOneNight = 0;

  for (const candidate of candidates) {
    const titleLower = candidate.title.toLowerCase();

    // Gate 1: Title-based non-theater filter (always applied)
    if (NON_THEATER_PATTERNS.some(pattern => titleLower.includes(pattern))) {
      filteredNonTheater++;
      if (verbose) console.log(`  [FILTERED] "${candidate.title}" — non-theater pattern`);
      continue;
    }
    if (EXCLUDED_TITLES.some(excluded => titleLower.includes(excluded))) {
      filteredNonTheater++;
      if (verbose) console.log(`  [FILTERED] "${candidate.title}" — excluded title`);
      continue;
    }
    // WE extra patterns
    if (isLondonMarket(candidate.category) && WE_EXTRA_PATTERNS.some(p => titleLower.includes(p))) {
      filteredNonTheater++;
      if (verbose) console.log(`  [FILTERED] "${candidate.title}" — WE extra pattern`);
      continue;
    }

    // Gate 2: Try TodayTix search for enrichment (optional, not required)
    const location = isLondonMarket(candidate.category) ? 2 : 1;
    let ttShow = null;
    try {
      ttShow = await searchTodayTixByTitle(candidate.title, location);
      await new Promise(r => setTimeout(r, 300)); // Rate limit
    } catch { /* TodayTix search failed — proceed without */ }

    if (ttShow) {
      // Full TodayTix validation: all gates apply
      if (isNonTheaterContent(ttShow)) {
        filteredNonTheater++;
        if (verbose) console.log(`  [FILTERED] "${candidate.title}" — TT non-theater content`);
        continue;
      }
      if (isOneNightShow(ttShow)) {
        filteredOneNight++;
        if (verbose) console.log(`  [FILTERED] "${candidate.title}" — one-night event`);
        continue;
      }

      // Category cross-validation: ShowScore category should match TodayTix subcategories
      const subcatNames = (ttShow.subcategories || []).map(sc => sc.name);
      let categoryMatch = false;
      if (candidate.category === 'off-broadway') {
        categoryMatch = subcatNames.includes('Off Broadway') ||
          (subcatNames.includes('Broadway') && !subcatNames.includes('Off Broadway')); // Some OB shows tagged as Broadway on TT
      } else if (isLondonMarket(candidate.category)) {
        categoryMatch = subcatNames.includes('West End') || subcatNames.includes('Off West End');
      }
      if (!categoryMatch) {
        if (verbose) console.log(`  [SKIP] "${candidate.title}" — category mismatch (SS: ${candidate.category}, TT: ${subcatNames.join(',')})`);
        continue;
      }

      ttConfirmed++;
      const title = (ttShow.displayName || ttShow.name || candidate.title).trim();

      // For WE/OB shows, TodayTix startDate is first preview, NOT press night.
      // Scrape Show Score for the actual press night ("Opens Mar 09") date.
      let openingDate = ttShow.startDate || null;
      let previewsStartDate = null;
      if (isLondonMarket(candidate.category) || candidate.category === 'off-broadway') {
        let ssData = null;
        try {
          ssData = await fetchShowScoreStatus(candidate.showScoreUrl);
          await new Promise(r => setTimeout(r, 500));
        } catch { /* ShowScore fetch failed */ }
        if (ssData?.openingDate) {
          // Show Score "Opens X" = press night = true opening date
          previewsStartDate = ttShow.startDate || null;
          openingDate = ssData.openingDate;
          console.log(`    Date correction: TT startDate ${previewsStartDate} → previewsStart, SS "Opens" ${openingDate} → openingDate`);
        }
      }

      validated.push({
        title,
        venue: (typeof ttShow.venue === 'string' ? ttShow.venue : ttShow.venue?.name) || 'TBA',
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        openingDate,
        previewsStartDate,
        closingDate: ttShow.endDate === 'null' ? null : ttShow.endDate || null,
        category: candidate.category,
        description: ttShow.description || '',
        todayTixCategory: ttShow.category?.name || null,
        _showScoreUrl: candidate.showScoreUrl,
        _source: 'showScore+todayTix',
      });
      console.log(`  [TT+SS] "${candidate.title}" → confirmed on TodayTix`);
    } else {
      // Not on TodayTix — scrape ShowScore page for status/dates.
      // ShowScore itself validates it's a real show (they curate listings).
      ttMissing++;

      let ssData = null;
      try {
        ssData = await fetchShowScoreStatus(candidate.showScoreUrl);
        await new Promise(r => setTimeout(r, 500)); // Rate limit
      } catch { /* ShowScore fetch failed — proceed with nulls */ }

      // Skip closed shows from ShowScore
      if (ssData?.ssStatus === 'closed') {
        if (verbose) console.log(`  [SKIP] "${candidate.title}" — ShowScore says Closed`);
        continue;
      }

      const venue = ssData?.venue || 'TBA';
      const openingDate = ssData?.openingDate || null;
      const closingDate = ssData?.closingDate || null;
      const source = ssData ? 'showScore+scraped' : 'showScore';

      validated.push({
        title: candidate.title,
        venue,
        slug: candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        openingDate,
        closingDate,
        category: candidate.category,
        description: '',
        todayTixCategory: null,
        _showScoreUrl: candidate.showScoreUrl,
        _showScoreStatus: ssData?.ssStatus || null,
        _source: source,
      });
      const dateInfo = openingDate ? ` (opens ${openingDate})` : ssData?.ssStatus ? ` (${ssData.ssStatus})` : '';
      console.log(`  [SS] "${candidate.title}" → not on TodayTix, adding from ShowScore${dateInfo}`);
    }
  }

  console.log(`ShowScore candidates: ${validated.length} validated (${ttConfirmed} TT-confirmed, ${ttMissing} SS-only), ${filteredNonTheater} non-theater, ${filteredOneNight} one-night`);
  return validated;
}

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  if (!data._meta) data._meta = {};
  data._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function fetchShowsFromBroadwayOrg() {
  console.log(`Fetching Broadway.org shows page...`);

  // Use shared scraper with automatic fallback
  const result = await fetchPage(BROADWAY_ORG_URL);

  console.log(`Received ${result.format} content from ${result.source}`);
  console.log('Parsing show data...');

  // Parse HTML with JSDOM
  const dom = new JSDOM(result.content);
  const document = dom.window.document;

  const showsList = [];

  // Try finding h4 headings (show titles)
  const h4s = Array.from(document.querySelectorAll('h4'));
  console.log(`Found ${h4s.length} h4 headings`);

  if (h4s.length > 0) {
    h4s.forEach(h4 => {
      const title = h4.textContent.trim();
      if (!title || title.length < 3) return;

      // Find container
      let container = h4.closest('div');
      if (container && container.parentElement) {
        container = container.parentElement;
      }

      const text = container?.textContent || '';
      const venueLink = container?.querySelector('a[href*="/broadway-theatres/"]');
      const venue = venueLink?.textContent?.trim() || 'TBA';

      // Extract dates from text
      const beginsMatch = text.match(/Begins:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
      const throughMatch = text.match(/Through:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);

      if (!showsList.find(s => s.title === title)) {
        showsList.push({
          title,
          venue,
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          openingDate: beginsMatch ? beginsMatch[1] : null,
          closingDate: throughMatch ? throughMatch[1] : null
        });
      }
    });
  } else {
    // Fallback: try to find show links
    const showLinks = Array.from(document.querySelectorAll('a[href^="/shows/"]'));
    console.log(`Found ${showLinks.length} show links`);

    for (const link of showLinks) {
      const href = link.getAttribute('href');
      if (!href || href === '/shows/') continue;

      const slug = href.replace('/shows/', '');
      const h4 = link.querySelector('h4');
      if (!h4) continue;

      const title = h4.textContent.trim();
      if (!title || title.length < 3) continue;

      let container = link.closest('div');
      if (container && container.parentElement) {
        container = container.parentElement;
      }

      const venueLink = container?.querySelector('a[href*="/broadway-theatres/"]');
      const venue = venueLink?.textContent?.trim() || 'TBA';
      const text = container?.textContent || '';

      const beginsMatch = text.match(/Begins:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
      const throughMatch = text.match(/Through:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);

      if (!showsList.find(s => s.title === title)) {
        showsList.push({
          title,
          venue,
          slug,
          openingDate: beginsMatch ? beginsMatch[1] : null,
          closingDate: throughMatch ? throughMatch[1] : null
        });
      }
    }
  }

  console.log(`Extracted ${showsList.length} shows from Broadway.org`);
  return showsList;
}

async function discoverShows() {
  console.log('='.repeat(60));
  console.log(includeWestEnd ? 'BROADWAY + WEST END SHOW DISCOVERY' : 'BROADWAY SHOW DISCOVERY');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();

  console.log(`Existing shows in database: ${data.shows.length}`);
  console.log('');

  // Primary: TodayTix API (public JSON, no Cloudflare)
  // Fallback: Broadway.org scraping (often blocked by Cloudflare)
  let discoveredShows;
  try {
    discoveredShows = await fetchShowsFromTodayTix();
    console.log(`Found ${discoveredShows.length} shows via TodayTix API`);
  } catch (e) {
    console.log(`TodayTix API failed (${e.message}), falling back to Broadway.org...`);
    discoveredShows = [];
  }

  if (discoveredShows.length === 0) {
    try {
      discoveredShows = await fetchShowsFromBroadwayOrg();
      console.log(`Found ${discoveredShows.length} shows on Broadway.org`);
      if (discoveredShows.length === 0) {
        console.error('ERROR: Both TodayTix API and Broadway.org returned 0 shows.');
        process.exitCode = 1;
      }
    } catch (e) {
      console.error('ERROR: Both sources failed. TodayTix API and Broadway.org:', e.message);
      process.exitCode = 1;
      return { newShows: [], count: 0 };
    }
  }
  console.log('');

  // West End discovery via TodayTix London API + Official London Theatre (SOLT)
  if (includeWestEnd) {
    // Fetch both sources in parallel
    const [todayTixResult, oltResult] = await Promise.allSettled([
      fetchShowsFromTodayTixLondon(),
      fetchShowsFromOfficialLondonTheatre()
    ]);

    const todayTixWEShows = todayTixResult.status === 'fulfilled' ? todayTixResult.value : [];
    const oltShows = oltResult.status === 'fulfilled' ? oltResult.value : [];

    if (todayTixResult.status === 'rejected') {
      console.log(`⚠️  TodayTix London API failed (${todayTixResult.reason?.message}), continuing with OLT`);
    } else {
      console.log(`Found ${todayTixWEShows.length} West End shows via TodayTix London API`);
      if (todayTixWEShows.length > 0 && todayTixWEShows.length < 20) {
        console.log(`⚠️  WARNING: TodayTix London returned unusually few shows (${todayTixWEShows.length}). Expected 50+.`);
      }
    }

    if (oltResult.status === 'rejected') {
      console.log(`⚠️  OLT fetch failed (${oltResult.reason?.message}), continuing with TodayTix only`);
    } else {
      console.log(`Found ${oltShows.length} West End shows via Official London Theatre`);
    }

    if (todayTixWEShows.length === 0 && oltShows.length === 0) {
      console.log(`⚠️  CRITICAL: Both West End sources returned 0 shows — check API/scraper health`);
    }

    // Cross-source divergence logging (diagnostic)
    logWESourceDivergence(todayTixWEShows, oltShows);

    // TodayTix first (richer metadata with todayTixCategory), OLT second — dedup pipeline handles overlap
    discoveredShows.push(...todayTixWEShows, ...oltShows);
    console.log('');
  }

  // ShowScore candidates: validated OB/WE shows from ShowScore listings
  // that aren't in our DB yet. Joins the same dedup pipeline as TodayTix shows.
  const consumedCandidateUrls = []; // ShowScore URLs for newly added shows
  const processedCandidateUrls = new Set(); // ALL processed URLs (for pruning)
  if (consumeShowScoreCandidates) {
    console.log('');
    console.log('🔍 Processing ShowScore candidates...');
    try {
      // Load all candidates to track which ones we processed
      try {
        const candidatesData = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
        for (const c of (candidatesData.candidates || [])) {
          if (c.category === 'off-broadway' || isLondonMarket(c.category)) {
            processedCandidateUrls.add(c.showScoreUrl);
          }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`Warning: could not parse ${CANDIDATES_PATH}: ${e.message}`);
      }

      const ssValidated = await consumeShowScoreCandidatesFile();
      if (ssValidated.length > 0) {
        // Track ShowScore URLs for post-save assignment
        for (const s of ssValidated) {
          if (s._showScoreUrl) consumedCandidateUrls.push({ title: s.title, url: s._showScoreUrl });
        }
        discoveredShows.push(...ssValidated);
        console.log(`Added ${ssValidated.length} ShowScore candidates to discovery pipeline`);
      }
    } catch (e) {
      console.log(`⚠️  ShowScore candidate processing failed (continuing without): ${e.message}`);
    }
    console.log('');
  }

  // Find new shows not in our database using improved duplicate detection
  const newShows = [];
  const skippedDuplicates = [];
  const existingSlugs = new Set(data.shows.map(s => s.slug));
  const existingIds = new Set(data.shows.map(s => s.id));

  // Build todaytixId index for fast dedup
  const existingTodaytixIds = new Map();
  for (const s of data.shows) {
    if (s.todaytixId) existingTodaytixIds.set(s.todaytixId, s);
  }

  for (const show of discoveredShows) {
    // Step 0: TodayTix ID dedup — most reliable, catches name mismatches
    if (show.todaytixId && existingTodaytixIds.has(show.todaytixId)) {
      const existing = existingTodaytixIds.get(show.todaytixId);
      skippedDuplicates.push({
        title: show.title,
        reason: `Same TodayTix ID (${show.todaytixId}) as existing show`,
        existingId: existing.id
      });
      continue;
    }

    // Use the new comprehensive duplicate check
    const duplicateCheck = checkForDuplicate(show, data.shows);

    if (duplicateCheck.isDuplicate) {
      skippedDuplicates.push({
        title: show.title,
        reason: duplicateCheck.reason,
        existingId: duplicateCheck.existingShow?.id
      });
      continue;
    }

    // Intra-batch dedup: also check against shows already accepted in this batch
    // This catches cases where TodayTix and ShowScore discover the same show
    const batchDuplicateCheck = checkForDuplicate(show, newShows);
    if (batchDuplicateCheck.isDuplicate) {
      skippedDuplicates.push({
        title: show.title,
        reason: `Duplicate within discovery batch: ${batchDuplicateCheck.reason}`,
        existingId: batchDuplicateCheck.existingShow?.id || batchDuplicateCheck.existingShow?.title
      });
      continue;
    }

    // Convert date strings to ISO format
    let openingDate = null;
    if (show.openingDate) {
      const parsed = new Date(show.openingDate);
      if (!isNaN(parsed.getTime())) {
        openingDate = parsed.toISOString().split('T')[0];
      }
    }

    let closingDate = null;
    if (show.closingDate) {
      const parsed = new Date(show.closingDate);
      if (!isNaN(parsed.getTime())) {
        closingDate = parsed.toISOString().split('T')[0];
      }
    }

    let previewsStartDate = null;
    if (show.previewsStartDate) {
      const parsed = new Date(show.previewsStartDate);
      if (!isNaN(parsed.getTime())) {
        previewsStartDate = parsed.toISOString().split('T')[0];
      }
    }

    // Use opening year for ID if available, otherwise current year
    const idYear = openingDate ? openingDate.split('-')[0] : new Date().getFullYear();
    const baseSlug = slugify(show.title);

    // Market-aware slug and ID generation
    const slug = show.category === 'west-end' ? `${baseSlug}-west-end`
               : show.category === 'off-west-end' ? `${baseSlug}-off-west-end`
               : show.category === 'off-broadway' ? `${baseSlug}-off-broadway`
               : baseSlug;
    const showId = show.category === 'west-end' ? `${baseSlug}-west-end-${idYear}`
                 : show.category === 'off-west-end' ? `${baseSlug}-off-west-end-${idYear}`
                 : show.category === 'off-broadway' ? `${baseSlug}-off-broadway-${idYear}`
                 : `${baseSlug}-${idYear}`;

    // Guard: skip if generated ID or slug collides with existing DB or batch
    if (existingIds.has(showId)) {
      skippedDuplicates.push({ title: show.title, reason: `ID collision: ${showId} already exists`, existingId: showId });
      continue;
    }
    if (existingSlugs.has(slug)) {
      skippedDuplicates.push({ title: show.title, reason: `Slug collision: ${slug} already exists`, existingId: slug });
      continue;
    }

    // Track to prevent intra-batch slug/ID collisions
    existingIds.add(showId);
    existingSlugs.add(slug);

    newShows.push({
      ...show,
      slug: slug,
      id: showId,
      openingDate,
      previewsStartDate,
      closingDate,
    });
  }

  // IBDB date enrichment: get accurate preview/opening/closing dates
  // Skip off-Broadway and London shows — IBDB only covers Broadway
  const broadwayNewShows = newShows.filter(s => s.category !== 'off-broadway' && !isLondonMarket(s.category));
  const offBroadwayNewShows = newShows.filter(s => s.category === 'off-broadway');
  const westEndNewShows = newShows.filter(s => isLondonMarket(s.category));
  if (offBroadwayNewShows.length > 0) {
    console.log(`⏭️  Skipping IBDB enrichment for ${offBroadwayNewShows.length} off-Broadway shows (IBDB is Broadway-only)`);
  }
  if (westEndNewShows.length > 0) {
    console.log(`⏭️  Skipping IBDB enrichment for ${westEndNewShows.length} West End shows (IBDB is Broadway-only)`);
  }
  if (broadwayNewShows.length > 0) {
    console.log('');
    console.log('🔎 Enriching dates from IBDB...');
    try {
      const lookupList = broadwayNewShows.map(s => ({
        title: s.title,
        openingYear: s.openingDate ? parseInt(s.openingDate.split('-')[0]) : new Date().getFullYear(),
        venue: s.venue
      }));

      const ibdbResults = await batchLookupIBDBDates(lookupList);

      for (const show of broadwayNewShows) {
        const ibdb = ibdbResults.get(show.title);
        if (!ibdb || !ibdb.found) {
          // IBDB lookup failed: treat Broadway.org "Begins:" as previewsStartDate
          // since it's often the preview start, not the true opening
          if (show.openingDate) {
            show.previewsStartDate = show.openingDate;
            show.openingDate = null;
            console.log(`  ℹ️  "${show.title}": No IBDB data, treating Begins date as previewsStartDate`);
          }
          continue;
        }

        // IBDB opening date is authoritative - overwrite Broadway.org "Begins:"
        if (ibdb.openingDate) {
          show.openingDate = ibdb.openingDate;
        }

        // Fill in preview start date
        if (ibdb.previewsStartDate) {
          show.previewsStartDate = ibdb.previewsStartDate;
        }

        // Fill in closing date if available
        if (ibdb.closingDate && !show.closingDate) {
          show.closingDate = ibdb.closingDate;
        }

        // Store IBDB URL for reference
        if (ibdb.ibdbUrl) {
          show.ibdbUrl = ibdb.ibdbUrl;
        }

        // Populate creative team if IBDB returned it
        if (ibdb.creativeTeam && ibdb.creativeTeam.length > 0) {
          const { result } = splitCombinedCredits(ibdb.creativeTeam);
          show.creativeTeam = result;
        }

        // Use IBDB show type classification if available
        if (ibdb.showType) {
          show.ibdbShowType = ibdb.showType;
        }
      }
    } catch (e) {
      console.log(`⚠️  IBDB enrichment failed (continuing without): ${e.message}`);
    }
    console.log('');
  }

  // Log skipped duplicates for debugging
  if (skippedDuplicates.length > 0) {
    console.log(`⏭️  Skipped ${skippedDuplicates.length} duplicate(s):`);
    for (const skip of skippedDuplicates) {
      console.log(`   - "${skip.title}" (${skip.reason}) → existing: ${skip.existingId}`);
    }
    console.log('');
  }

  if (newShows.length === 0) {
    console.log('✅ No new shows discovered - database is up to date');
    return { newShows: [], count: 0 };
  }

  console.log(`🎭 Found ${newShows.length} NEW show(s):`);
  console.log('-'.repeat(40));

  // Build title index from existing shows for cross-reference revival detection
  // Use full normalized title (no subtitle stripping) to avoid false positives
  // e.g. "Seagull: True Story" should NOT match "The Seagull"
  const normalizeTitle = (t) => t.toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9' ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const existingTitleMap = new Map(); // normalized title → { type, id, category }
  for (const s of data.shows) {
    const norm = normalizeTitle(s.title);
    if (norm.length < 4) continue; // skip very short titles to avoid false matches (art, bug, etc.)
    if (!existingTitleMap.has(norm)) {
      existingTitleMap.set(norm, { type: s.type, id: s.id, category: s.category, title: s.title });
    }
  }

  // Analyze shows for revival detection
  const revivalDetection = newShows.map(show => {
    const knownCheck = checkKnownShow(show.title);
    const isPlay = detectPlayFromTitle(show.title);

    let detectedType = 'play'; // default to play (safer — musicals are more obvious)
    let isRevival = false;
    let confidence = 'low';

    if (knownCheck.isKnown) {
      // Known classic - likely a revival, preserve original type (play vs musical)
      detectedType = knownCheck.type || 'play';
      isRevival = true;
      confidence = 'high';
    } else {
      // Cross-reference against existing shows in shows.json
      // Try full normalized title first, then base title (before colon/parens) for 5+ char bases
      const norm = normalizeTitle(show.title);
      let match = existingTitleMap.get(norm);
      if (!match || match.id === show.id) {
        // Try base title (before colon, dash, or parens) — only if 5+ chars to avoid false positives
        const base = show.title.replace(/\s*[:(\-–—].*/g, '').trim();
        const normBase = normalizeTitle(base);
        if (normBase.length >= 5 && normBase !== norm) {
          match = existingTitleMap.get(normBase);
        }
      }
      if (match && match.id !== show.id) {
        isRevival = true;
        detectedType = match.type || detectedType;
        confidence = 'high';
        console.log(`  📋 Revival detected via cross-reference: "${show.title}" matches existing "${match.title}" (${match.id})`);
      }
    }

    // Type detection (independent of revival status)
    if (show.todayTixCategory) {
      // TodayTix category is reliable for OB/WE (no IBDB available)
      if (show.todayTixCategory === 'Musicals') {
        detectedType = 'musical';
        if (confidence === 'low') confidence = 'high';
      } else if (show.todayTixCategory === 'Plays') {
        detectedType = 'play';
        if (confidence === 'low') confidence = 'high';
      } else if (['Dance', 'Cabaret', 'Immersive Experiences', 'Opera', 'Circus and Magic', 'Concerts'].includes(show.todayTixCategory)) {
        // Non-musical/play categories → 'special' (avoids misclassifying ballet as musical, etc.)
        detectedType = 'special';
        if (confidence === 'low') confidence = 'high';
      }
    } else if (show.ibdbShowType) {
      // IBDB classification is authoritative (from the production page itself)
      detectedType = show.ibdbShowType;
      confidence = 'high';
    } else if (/[-–—:]\s*the\s+musical\b|:\s*a\s+(new\s+)?musical\b/i.test(show.title)) {
      // Title suffix like "Dog Man - The Musical" or "Show: A New Musical"
      // Avoids false positives like "The Musical Comedy Murders of 1940"
      detectedType = 'musical';
      confidence = 'medium';
    } else if (isPlay) {
      detectedType = 'play';
      confidence = 'medium';
    }

    return { show, detectedType, isRevival, confidence };
  });

  // Stage 3: IBDB revival detection for shows not yet identified as revivals
  // Only for OB/WE shows where known-shows and cross-reference didn't find a match
  const undetected = revivalDetection.filter(d => !d.isRevival && d.detectedType !== 'special');
  if (undetected.length > 0 && !dryRun) {
    console.log(`\n🔍 Stage 3: Checking IBDB for prior productions of ${undetected.length} undetected show(s)...`);
    const RATE_LIMIT_MS = 1500;
    for (let i = 0; i < undetected.length; i++) {
      const det = undetected[i];
      const showYear = det.show.openingDate ? parseInt(det.show.openingDate.split('-')[0]) :
                       det.show.previewsStartDate ? parseInt(det.show.previewsStartDate.split('-')[0]) : null;
      const result = await checkIBDBForPriorProductions(det.show.title, { currentYear: showYear, showCategory: det.show.category || 'off-broadway' });
      if (result.isRevival) {
        det.isRevival = true;
        if (result.confidence === 'high') det.confidence = 'high';
        console.log(`  🔄 IBDB revival confirmed: "${det.show.title}" (${result.priorProductionCount} prior productions)`);
      }
      // Mark as checked so nightly runs don't re-query
      det.show._ibdbRevivalChecked = true;
      if (i < undetected.length - 1) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      }
    }
    console.log('');
  }

  for (const { show, detectedType, isRevival, confidence } of revivalDetection) {
    const typeLabel = isRevival ? '🔄 REVIVAL' : detectedType === 'play' ? '🎭 PLAY' : '🎵 MUSICAL';
    const confidenceLabel = confidence === 'high' ? '✓' : confidence === 'medium' ? '~' : '?';
    console.log(`  ${confidenceLabel} ${show.title} → ${typeLabel} (${show.venue})`);
  }
  console.log('');

  // --- Runtime + age enrichment from Broadway.com ---
  let runtimeEnrichments = {};
  if (!dryRun && newShows.length > 0) {
    try {
      console.log('⏱️  Looking up runtimes + age recommendations from Broadway.com...');
      const runtimeEntries = await scrapeCurrentRuntimes();
      const allShows = [...data.shows, ...newShows];
      runtimeEnrichments = matchRuntimesToShows(runtimeEntries, allShows);
      // Also scrape individual pages for age recommendations
      await batchScrapeAgeRecommendations(runtimeEntries, allShows, runtimeEnrichments);
    } catch (e) {
      console.log(`⚠️  Runtime/age lookup failed (continuing without): ${e.message}`);
    }
    console.log('');
  }

  if (!dryRun) {
    // Add new shows to database
    for (let i = 0; i < newShows.length; i++) {
      const show = newShows[i];
      const detection = revivalDetection[i];

      // Determine status based on opening date
      let openingDate;
      let status;

      // ShowScore status is more reliable than TodayTix dates for OB/WE shows.
      // "Opens Mar 08" = real opening date. "Open run" = confirmed open.
      const ssStatus = show._showScoreStatus;

      if (ssStatus === 'open' || ssStatus === 'previews') {
        // ShowScore has authoritative status — use it directly
        if (ssStatus === 'open') {
          status = 'open';
          openingDate = show.openingDate || null;
        } else {
          // "Opens Mar 08" — the date IS the opening date (not preview date)
          status = 'previews';
          openingDate = show.openingDate; // ShowScore "Opens" date = press night
        }
      } else if (show.openingDate) {
        openingDate = show.openingDate;
        const openingDateObj = new Date(openingDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (openingDateObj > today) {
          status = 'upcoming';
        } else if (show.category === 'off-broadway' && !show.ibdbUrl) {
          // OB shows without IBDB-confirmed dates: TodayTix startDate is the first
          // performance (previews), not press night. Default to 'previews' to avoid
          // prematurely marking shows as 'open' and collecting wrong-production reviews.
          // (Lesson from March 2026 audit: 10 OB shows had preview dates as opening dates.)
          status = 'previews';
          show.previewsStartDate = show.openingDate;
          show.openingDate = null;
          openingDate = null;
        } else {
          status = 'open';
        }
      } else if (show.previewsStartDate) {
        // No opening date but have preview date - show is in previews
        openingDate = null;
        status = 'previews';
      } else {
        // No opening date or preview date — show is announced but not yet scheduled
        openingDate = null;
        status = 'announced';
      }

      // Build tags based on detection
      const tags = (status === 'previews' || status === 'upcoming' || status === 'announced') ? ['upcoming'] : [];
      if (detection.isRevival) {
        tags.push('revival');
      } else if (detection.confidence === 'low') {
        tags.push('new'); // Flag for manual verification
      }

      const showEntry = {
        id: show.id,
        title: show.title,
        slug: show.slug,
        venue: show.venue,
        openingDate: openingDate || null,
        closingDate: show.closingDate || null,
        status: status,
        type: (detection.detectedType || 'play').toLowerCase(), // Auto-detected with revival logic
        isRevival: detection.isRevival || false,
        runtime: (runtimeEnrichments[show.id] && runtimeEnrichments[show.id].runtime) || null,
        intermissions: runtimeEnrichments[show.id] != null ? runtimeEnrichments[show.id].intermissions : null,
        images: {},
        synopsis: show.description ? show.description.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().substring(0, 500) : '',
        ageRecommendation: (runtimeEnrichments[show.id] && runtimeEnrichments[show.id].ageRecommendation) || null,
        previewsStartDate: show.previewsStartDate || null,
        tags: tags,
        theaterAddress: getTheaterAddress(show.venue) || null,
        ticketLinks: [],
        cast: [],
        creativeTeam: show.creativeTeam || [],
      };

      // Persist TodayTix category for future type detection (backfill on re-runs)
      if (show.todayTixCategory) {
        showEntry.todayTixCategory = show.todayTixCategory;
      }

      // Cache IBDB revival check to prevent re-querying on future runs
      if (show._ibdbRevivalChecked) {
        showEntry.ibdbRevivalChecked = true;
      }

      // Set category for non-Broadway shows
      if (show.category === 'off-broadway') {
        showEntry.category = 'off-broadway';
      } else if (show.category === 'west-end') {
        showEntry.category = 'west-end';
      } else if (show.category === 'off-west-end') {
        showEntry.category = 'off-west-end';
      }

      data.shows.push(showEntry);
    }

    saveShows(data);
    console.log(`✅ Added ${newShows.length} shows to shows.json`);

    // Show detection summary
    const revivalsDetected = revivalDetection.filter(d => d.isRevival).length;
    const playsDetected = revivalDetection.filter(d => d.detectedType === 'play' && !d.isRevival).length;
    const needsReview = revivalDetection.filter(d => d.confidence === 'low').length;

    console.log('');
    console.log('📊 Detection Summary:');
    if (revivalsDetected > 0) console.log(`   🔄 ${revivalsDetected} revival(s) auto-detected`);
    if (playsDetected > 0) console.log(`   🎭 ${playsDetected} play(s) auto-detected`);
    if (needsReview > 0) console.log(`   ⚠️  ${needsReview} show(s) need manual type verification`);
    console.log('');

    // Save pending shows for review (strip internal fields)
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      discoveredAt: new Date().toISOString(),
      shows: newShows.map(s => {
        const { _showScoreUrl, _source, ...clean } = s;
        return clean;
      }),
    }, null, 2));
    console.log(`📋 Saved pending shows to ${OUTPUT_FILE}`);

    // Post-save: assign ShowScore URLs + prune consumed candidates
    if (consumeShowScoreCandidates && consumedCandidateUrls.length > 0) {
      try {
        // Assign ShowScore URLs to newly created shows
        const urlData = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
        if (!urlData.shows) urlData.shows = {};
        let urlsAssigned = 0;
        for (const { title, url } of consumedCandidateUrls) {
          // Find the newly created show by matching title
          const addedShow = newShows.find(s => s.title === title);
          if (addedShow && !urlData.shows[addedShow.id]) {
            urlData.shows[addedShow.id] = url;
            urlsAssigned++;
          }
        }
        if (urlsAssigned > 0) {
          urlData._meta = urlData._meta || {};
          urlData._meta.lastUpdated = new Date().toISOString().split('T')[0];
          fs.writeFileSync(URLS_PATH, JSON.stringify(urlData, null, 2) + '\n');
          console.log(`Assigned ${urlsAssigned} ShowScore URLs to new shows`);
        }
      } catch (e) {
        console.log(`⚠️  ShowScore URL assignment failed (non-fatal): ${e.message}`);
      }
    }

    // Prune ALL processed candidates (added, filtered, or deduped) from candidates file
    if (consumeShowScoreCandidates && processedCandidateUrls.size > 0) {
      try {
        const candidatesData = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
        const before = (candidatesData.candidates || []).length;
        candidatesData.candidates = (candidatesData.candidates || []).filter(c =>
          !processedCandidateUrls.has(c.showScoreUrl)
        );
        const pruned = before - candidatesData.candidates.length;
        if (pruned > 0) {
          candidatesData._meta = candidatesData._meta || {};
          candidatesData._meta.lastUpdated = new Date().toISOString();
          candidatesData._meta.totalCandidates = candidatesData.candidates.length;
          fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidatesData, null, 2) + '\n');
          console.log(`Pruned ${pruned} processed candidates from show-score-candidates.json`);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`Warning: could not parse ${CANDIDATES_PATH}: ${e.message}`);
      }
    }
  }

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `new_shows_count=${newShows.length}\n`);
    fs.appendFileSync(outputFile, `new_shows=${newShows.map(s => s.title).join(', ')}\n`);
    fs.appendFileSync(outputFile, `new_slugs=${newShows.map(s => s.slug).join(',')}\n`);
    // WE-specific output for downstream triggers (includes off-west-end)
    const weNewShows = newShows.filter(s => isLondonMarket(s.category));
    fs.appendFileSync(outputFile, `we_new_count=${weNewShows.length}\n`);
  }

  return { newShows, count: newShows.length };
}

discoverShows()
  .catch(e => {
    console.error('Discovery failed:', e);
    process.exit(1);
  })
  .finally(() => {
    // Clean up scraper resources
    cleanup().catch(console.error);
  });
