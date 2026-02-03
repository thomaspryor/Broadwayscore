#!/usr/bin/env node
/**
 * Historical Broadway Show Discovery
 *
 * Discovers closed Broadway shows from past seasons by scraping IBDB season pages
 * and adds them to shows.json with "closed" status.
 *
 * Data source: https://www.ibdb.com/season/{numericId}
 *   - Season ID = startYear - 727 (e.g., 2024-2025 → 1297)
 *   - Provides: title, type (Musical/Play/Special), Original/Revival, opening date, theater
 *   - IBDB production URLs used for direct date enrichment (no Google SERP needed)
 *
 * Usage: node scripts/discover-historical-shows.js --seasons=2024-2025,2023-2024 [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const https = require('https');
const { slugify, checkForDuplicate } = require('./lib/deduplication');
const { validateVenue } = require('./lib/broadway-theaters');
const { isTourProduction } = require('./lib/tour-detection');
const { getSeasonForDate, validateSeason } = require('./lib/broadway-seasons');
const { extractDatesFromIBDBPage } = require('./lib/ibdb-dates');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'historical-shows-pending.json');

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

// IBDB season IDs are NOT sequential — they have gaps (COVID years, etc.)
// This mapping is extracted from the season dropdown on any IBDB season page.
// To update: scrape any /season/ page and parse <option value="/season/{id}">{season}</option>
const IBDB_SEASON_IDS = {
  '2025-2026': 1298,
  '2024-2025': 1297,
  '2023-2024': 1296,
  '2022-2023': 1295,
  '2021-2022': 1291,
  '2020-2021': 1290,
  '2019-2020': 1289,
  '2018-2019': 1288,
  '2017-2018': 1287,
  '2016-2017': 1286,
  '2015-2016': 1285,
  '2014-2015': 1284,
  '2013-2014': 1283,
  '2012-2013': 1282,
  '2011-2012': 1281,
  '2010-2011': 1280,
  '2009-2010': 1278,
  '2008-2009': 1277,
  '2007-2008': 1276,
  '2006-2007': 1275,
  '2005-2006': 1274,
  '2004-2005': 1273,
  '2003-2004': 1272,
  '2002-2003': 1271,
  '2001-2002': 1270,
  '2000-2001': 1268,
  '1999-2000': 1101,
  '1998-1999': 1100,
  '1997-1998': 1099,
  '1996-1997': 1098,
  '1995-1996': 1097,
  '1994-1995': 1096,
  '1993-1994': 1095,
  '1992-1993': 1094,
  '1991-1992': 1093,
  '1990-1991': 1092,
  '1989-1990': 1091,
  '1988-1989': 1090,
  '1987-1988': 1089,
  '1986-1987': 1088,
  '1985-1986': 1087,
  '1984-1985': 1086,
  '1983-1984': 1085,
  '1982-1983': 1084,
  '1981-1982': 1083,
  '1980-1981': 1082,
};

const dryRun = process.argv.includes('--dry-run');

// Parse season argument
const seasonsArg = process.argv.find(arg => arg.startsWith('--seasons='));
const seasons = seasonsArg ? seasonsArg.split('=')[1].split(',') : [];

if (seasons.length === 0) {
  console.error('Error: Must specify at least one season with --seasons=YYYY-YYYY');
  console.error('   Example: --seasons=2024-2025,2023-2024');
  process.exit(1);
}

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse IBDB date string like "Jun 5, 2024" or "November 12, 2024" → "2024-06-05"
 */
function parseIBDBDateString(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();
  const parsed = new Date(cleaned);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split('T')[0];
}

/**
 * Fetch IBDB season page HTML via ScrapingBee premium proxy
 */
function fetchIBDBSeasonPage(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_API_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY not set'));
      return;
    }

    const apiUrl = new URL('https://app.scrapingbee.com/api/v1');
    apiUrl.searchParams.set('api_key', SCRAPINGBEE_API_KEY);
    apiUrl.searchParams.set('url', url);
    apiUrl.searchParams.set('premium_proxy', 'true');

    const req = https.get(apiUrl.toString(), (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`ScrapingBee returned ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/**
 * Map IBDB type text to our schema
 * "Musical, Original" → { type: 'musical', isRevival: false }
 * "Play, Revival" → { type: 'play', isRevival: true }
 * "Special, Original" → null (skip)
 */
function parseIBDBType(typeText) {
  if (!typeText) return null;
  const cleaned = typeText.trim();

  // Skip specials (concerts, benefits, one-person shows)
  if (cleaned.toLowerCase().startsWith('special')) return null;

  const isRevival = cleaned.toLowerCase().includes('revival');

  if (cleaned.toLowerCase().startsWith('musical')) {
    return { type: 'musical', isRevival };
  }
  if (cleaned.toLowerCase().startsWith('play')) {
    return { type: 'play', isRevival };
  }

  // Unknown type — include but mark as musical (safe default)
  return { type: 'musical', isRevival: false };
}

/**
 * Fetch and parse IBDB season page to discover shows
 *
 * IBDB season URL: https://www.ibdb.com/season/{numericId}
 * Season IDs are looked up from IBDB_SEASON_IDS (not computed — they have gaps)
 *
 * HTML structure:
 * <div class="row seasons-list">
 *   <div class="col s4"><a href="/broadway-production/...">Title</a></div>
 *   <div class="col s2">Musical, Original</div>
 *   <div class="col s2">Jun 5, 2024</div>
 *   <div class="col s3">Palace Theatre</div>
 * </div>
 */
async function fetchShowsFromIBDB(season) {
  const seasonId = IBDB_SEASON_IDS[season];
  if (!seasonId) {
    console.error(`  Error: Unknown IBDB season ID for "${season}". Add it to IBDB_SEASON_IDS.`);
    return [];
  }
  const url = `https://www.ibdb.com/season/${seasonId}`;

  console.log(`Fetching season ${season} from IBDB (ID: ${seasonId})...`);

  try {
    const html = await fetchIBDBSeasonPage(url);
    console.log(`  Received ${html.length} chars of HTML`);

    const dom = new JSDOM(html);
    const document = dom.window.document;

    const showsList = [];

    // IBDB season pages have two sections:
    //   <h1>Productions Opening During the Season</h1> — shows that debuted (we want these)
    //   <h1>Productions Closing During the Season</h1> — shows that closed (skip)
    //
    // Each show is a row: <div class="row seasons-list">
    //   <div class="col s4"><a href="/broadway-production/...">Title</a></div>
    //   <div class="col s2">Musical, Original</div>
    //   <div class="col s2">Jun 5, 2024</div>
    //   <div class="col s3">Palace Theatre</div>
    // </div>

    const allRows = Array.from(document.querySelectorAll('.row.seasons-list'));
    console.log(`  Found ${allRows.length} total show rows`);

    // Find the "Closing" section <h1> to know where to stop
    const allH1s = Array.from(document.querySelectorAll('h1'));
    let closingH1 = null;
    for (const h1 of allH1s) {
      if ((h1.textContent || '').includes('Closing')) {
        closingH1 = h1;
        break;
      }
    }

    // Process rows, stopping at the Closing section
    for (const row of allRows) {
      // If we've reached the closing section, stop
      if (closingH1) {
        const pos = row.compareDocumentPosition(closingH1);
        // If closingH1 precedes this row (bit 2 set), this row is in the Closing section
        if (pos & 2) { // Node.DOCUMENT_POSITION_PRECEDING
          continue;
        }
      }

      const link = row.querySelector('a[href*="/broadway-production/"]');
      if (!link) continue;

      const href = link.getAttribute('href');
      const ibdbUrl = `https://www.ibdb.com${href}`;
      const title = link.textContent.trim();

      if (!title || title.length < 2) continue;

      // Extract type, date, theater from child div.col elements
      // cols[0] = s4 (title/link), cols[1] = s2 (type), cols[2] = s2 (date), cols[3] = s3 (theater)
      const cols = Array.from(row.querySelectorAll('.col'));
      let ibdbTypeText = null;
      let dateText = null;
      let venue = null;

      if (cols.length >= 4) {
        ibdbTypeText = cols[1].textContent.trim();
        dateText = cols[2].textContent.trim();
        venue = cols[3].textContent.trim();
      } else if (cols.length >= 3) {
        ibdbTypeText = cols[1].textContent.trim();
        dateText = cols[2].textContent.trim();
      } else if (cols.length >= 2) {
        ibdbTypeText = cols[1].textContent.trim();
      }

      const parsedType = parseIBDBType(ibdbTypeText);
      if (parsedType === null) {
        // Special type — skip
        console.log(`  [SKIP] "${title}" — Special (not Musical/Play)`);
        continue;
      }

      const openingDate = parseIBDBDateString(dateText);

      showsList.push({
        title,
        ibdbUrl,
        openingDate,
        venue: venue || 'TBA',
        type: parsedType.type,
        isRevival: parsedType.isRevival,
        ibdbTypeText: ibdbTypeText || 'unknown',
        season
      });
    }

    console.log(`  Extracted ${showsList.length} shows from ${season} (excluding Specials)`);
    return showsList;
  } catch (e) {
    console.error(`  Error fetching season ${season} from IBDB: ${e.message}`);
    return [];
  }
}

/**
 * Enrich shows with dates and creative team from individual IBDB production pages.
 * Uses the IBDB URLs we already have from the season page (no SERP search needed).
 */
async function enrichFromIBDB(shows) {
  console.log(`Enriching ${shows.length} shows from IBDB production pages...`);

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    if (!show.ibdbUrl) continue;

    console.log(`  [${i + 1}/${shows.length}] "${show.title}"...`);

    try {
      const result = await extractDatesFromIBDBPage(show.ibdbUrl);

      if (result) {
        // IBDB opening date is authoritative
        if (result.openingDate) {
          show.openingDate = result.openingDate;
        }

        // Preview start date (not available on season page)
        if (result.previewsStartDate) {
          show.previewsStartDate = result.previewsStartDate;
        }

        // Closing date
        if (result.closingDate) {
          show.closingDate = result.closingDate;
        }

        // Creative team (director, choreographer, etc.)
        if (result.creativeTeam && result.creativeTeam.length > 0) {
          show.creativeTeam = result.creativeTeam;
        }
      }
    } catch (e) {
      console.log(`    Warning: IBDB enrichment failed for "${show.title}": ${e.message}`);
    }

    // Rate limit: 1.5s between IBDB requests
    if (i < shows.length - 1) {
      await sleep(1500);
    }
  }
}

async function discoverHistoricalShows() {
  console.log('='.repeat(60));
  console.log('BROADWAY HISTORICAL SHOW DISCOVERY (IBDB)');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Seasons: ${seasons.join(', ')}`);
  console.log('');

  const data = loadShows();
  console.log(`Existing shows in database: ${data.shows.length}`);
  console.log('');

  // Fetch shows from each season via IBDB
  const allDiscoveredShows = [];
  for (const season of seasons) {
    const validation = validateSeason(season);
    if (!validation.isValid) {
      console.error(`Invalid season format: ${season} — ${validation.reason}`);
      continue;
    }

    const seasonShows = await fetchShowsFromIBDB(season);
    allDiscoveredShows.push(...seasonShows);

    // Rate limit between seasons
    if (seasons.indexOf(season) < seasons.length - 1) {
      await sleep(2000);
    }
  }

  console.log('');
  console.log(`Total shows discovered: ${allDiscoveredShows.length}`);
  console.log('');

  // Filter: dedup, venue validation, tour detection
  const newShows = [];
  const skippedDuplicates = [];
  const skippedTours = [];
  const skippedInvalidVenue = [];

  for (const show of allDiscoveredShows) {
    // Build slug and ID with year suffix to prevent collisions
    const openingYear = show.openingDate ? show.openingDate.split('-')[0] : show.season.split('-')[0];
    const baseSlug = slugify(show.title);
    const id = `${baseSlug}-${openingYear}`;
    // Fix: slug = id ensures unique slugs for multi-production shows
    show.slug = id;
    show.id = id;

    // STEP 1: Tour detection
    const tourCheck = isTourProduction(show);
    if (tourCheck.isTour) {
      skippedTours.push({
        title: show.title, season: show.season,
        reason: tourCheck.reason, type: tourCheck.type
      });
      continue;
    }

    // STEP 2: Venue validation
    const venueValidation = validateVenue(show.venue);
    if (!venueValidation.isValid && show.venue && show.venue !== 'TBA') {
      skippedInvalidVenue.push({
        title: show.title, season: show.season,
        venue: show.venue, reason: venueValidation.reason
      });
      continue;
    }
    if (venueValidation.isValid) {
      show.venue = venueValidation.canonical;
    }

    // STEP 3: Season validation
    if (show.openingDate) {
      try {
        const computedSeason = getSeasonForDate(show.openingDate);
        if (computedSeason !== show.season) {
          console.log(`  Warning: Season mismatch for "${show.title}": listed as ${show.season}, date suggests ${computedSeason}`);
        }
      } catch (e) {
        // Date parsing issue — will be handled later
      }
    }

    // STEP 4: Duplicate check
    const duplicateCheck = checkForDuplicate(show, data.shows);
    if (duplicateCheck.isDuplicate) {
      skippedDuplicates.push({
        title: show.title, season: show.season,
        reason: duplicateCheck.reason, existingId: duplicateCheck.existingShow?.id
      });
      continue;
    }

    newShows.push(show);
  }

  // IBDB date enrichment: get preview dates, closing dates, creative team
  if (newShows.length > 0 && !dryRun) {
    console.log('');
    try {
      await enrichFromIBDB(newShows);
    } catch (e) {
      console.log(`Warning: IBDB enrichment failed (continuing without): ${e.message}`);
    }
    console.log('');
  }

  // Log skipped shows
  if (skippedTours.length > 0) {
    console.log(`Rejected ${skippedTours.length} tour/non-Broadway production(s):`);
    for (const skip of skippedTours) {
      console.log(`   - "${skip.title}" [${skip.season}] (${skip.type}: ${skip.reason})`);
    }
    console.log('');
  }

  if (skippedInvalidVenue.length > 0) {
    console.log(`Skipped ${skippedInvalidVenue.length} show(s) with unrecognized venues:`);
    for (const skip of skippedInvalidVenue) {
      console.log(`   - "${skip.title}" at "${skip.venue}" [${skip.season}]`);
    }
    console.log('');
  }

  if (skippedDuplicates.length > 0) {
    console.log(`Skipped ${skippedDuplicates.length} duplicate(s):`);
    for (const skip of skippedDuplicates) {
      console.log(`   - "${skip.title}" [${skip.season}] (${skip.reason}) -> existing: ${skip.existingId}`);
    }
    console.log('');
  }

  if (newShows.length === 0) {
    console.log('No new historical shows discovered');
    return { newShows: [], count: 0 };
  }

  console.log(`Found ${newShows.length} NEW historical show(s):`);
  console.log('-'.repeat(40));

  for (const show of newShows) {
    const typeLabel = show.isRevival
      ? (show.type === 'play' ? 'PLAY REVIVAL' : 'MUSICAL REVIVAL')
      : (show.type === 'play' ? 'PLAY' : 'MUSICAL');
    console.log(`  ${show.id} — ${show.title} (${typeLabel}) [${show.venue}]`);
  }
  console.log('');

  if (!dryRun) {
    // Add new shows to database
    for (const show of newShows) {
      const tags = ['historical'];
      if (show.isRevival) tags.push('revival');

      // Find existing productions for revival linking
      let originalProductionId = null;
      let productionNumber = 1;

      if (show.isRevival) {
        const baseSlug = slugify(show.title);
        const existingProductions = data.shows.filter(s => {
          const sBase = (s.slug || s.id).replace(/-\d{4}$/, '');
          return sBase === baseSlug && s.id !== show.id;
        }).sort((a, b) => (a.openingDate || '').localeCompare(b.openingDate || ''));

        if (existingProductions.length > 0) {
          originalProductionId = existingProductions[0].id;
          productionNumber = existingProductions.length + 1;
        }
      }

      data.shows.push({
        id: show.id,
        title: show.title,
        slug: show.slug,
        venue: show.venue,
        openingDate: show.openingDate || null,
        closingDate: show.closingDate || null,
        status: 'closed',
        type: show.type,
        runtime: null,
        intermissions: null,
        images: {},
        synopsis: '',
        ageRecommendation: null,
        previewsStartDate: show.previewsStartDate || null,
        tags,
        ticketLinks: [],
        cast: [],
        creativeTeam: show.creativeTeam || [],
        isRevival: show.isRevival,
        originalProductionId,
        productionNumber,
        season: show.season,
      });
    }

    saveShows(data);
    console.log(`Added ${newShows.length} historical shows to shows.json`);

    // Summary
    const revivals = newShows.filter(s => s.isRevival).length;
    const plays = newShows.filter(s => s.type === 'play' && !s.isRevival).length;
    const musicals = newShows.filter(s => s.type === 'musical' && !s.isRevival).length;

    console.log('');
    console.log('Detection Summary:');
    if (musicals > 0) console.log(`   ${musicals} original musical(s)`);
    if (plays > 0) console.log(`   ${plays} original play(s)`);
    if (revivals > 0) console.log(`   ${revivals} revival(s)`);
    console.log('');

    // Save pending shows for review
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      discoveredAt: new Date().toISOString(),
      seasons,
      shows: newShows.map(s => ({
        id: s.id, title: s.title, slug: s.slug, venue: s.venue,
        openingDate: s.openingDate, closingDate: s.closingDate,
        type: s.type, isRevival: s.isRevival, season: s.season,
        ibdbUrl: s.ibdbUrl
      })),
    }, null, 2));
    console.log(`Saved pending shows to ${OUTPUT_FILE}`);
  }

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `historical_shows_count=${newShows.length}\n`);
    fs.appendFileSync(outputFile, `historical_shows=${newShows.map(s => s.title).join(', ')}\n`);
    fs.appendFileSync(outputFile, `historical_slugs=${newShows.map(s => s.slug).join(',')}\n`);
  }

  return { newShows, count: newShows.length };
}

discoverHistoricalShows()
  .catch(e => {
    console.error('Discovery failed:', e);
    process.exit(1);
  });
