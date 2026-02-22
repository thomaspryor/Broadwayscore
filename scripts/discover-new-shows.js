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
const { checkKnownShow, detectPlayFromTitle } = require('./lib/known-shows');
const { slugify, checkForDuplicate } = require('./lib/deduplication');
const { batchLookupIBDBDates } = require('./lib/ibdb-dates');
const { getTheaterAddress } = require('./lib/venue-addresses');
const { splitCombinedCredits } = require('./lib/credit-splitting');
const { scrapeCurrentRuntimes, matchRuntimesToShows, batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'new-shows-pending.json');

const dryRun = process.argv.includes('--dry-run');
const includeOffBroadway = process.argv.includes('--include-off-broadway');
const includeWestEnd = process.argv.includes('--include-west-end');

// Broadway.org shows page
const BROADWAY_ORG_URL = 'https://www.broadway.org/shows/';

// Non-theater content patterns — shared across all markets (Broadway, OB, West End)
const NON_THEATER_PATTERNS = [
  'comedy club', 'comedy night', 'stand-up', 'standup',
  'magic', 'magick', 'bubble show',
  'orchestra', 'symphony', 'symphonic', 'philharmonic', 'chamber music',
  'quartet', 'quintet', 'ensemble',
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
];

// Known non-show titles that TodayTix lists but aren't theatrical productions
const EXCLUDED_TITLES = [
  'the museum of broadway',
];

function isNonTheaterContent(show) {
  const title = (show.displayName || show.name || '').toLowerCase();
  if (EXCLUDED_TITLES.some(excluded => title.includes(excluded))) return true;
  if (NON_THEATER_PATTERNS.some(pattern => title.includes(pattern))) return true;
  const subcatNames = (show.subcategories || []).map(sc => sc.name);
  if (subcatNames.includes('Classical')) return true; // Opera
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
  const broadwayShows = allShows.filter(s =>
    s.subcategories?.some(sc => sc.name === 'Broadway') && !isNonTheaterContent(s)
  );
  const offBroadwayShows = includeOffBroadway ? allShows.filter(s => {
    if (!s.subcategories?.some(sc => sc.name === 'Off Broadway')) return false;
    if (s.subcategories?.some(sc => sc.name === 'Broadway')) return false; // exclude shows tagged as both
    return !isNonTheaterContent(s);
  }) : [];

  // Deduplicate by displayName (API sometimes has duplicate listings)
  const seen = new Set();
  const showsList = [];
  for (const show of broadwayShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;
    seen.add(title);

    showsList.push({
      title,
      venue: show.venue?.name || 'TBA',
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: show.startDate || null,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
    });
  }

  for (const show of offBroadwayShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;
    seen.add(title);

    showsList.push({
      title,
      venue: show.venue?.name || 'TBA',
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: show.startDate || null,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      category: 'off-broadway',
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

  // Filter to West End shows (subcategory "West End"), reusing shared non-theater filter
  const westEndShows = allShows.filter(s => {
    if (!s.subcategories?.some(sc =>
      sc.name === 'West End' || sc.name === 'Broadway' // TodayTix sometimes uses "Broadway" for WE musicals
    )) return false;
    return !isNonTheaterContent(s);
  });

  // West End-specific additional filters
  const WE_EXTRA_PATTERNS = [
    'dining experience', 'candlelight', 'by candlelight',
    'discovering dinosaurs', 'prehistoric planet',
    'classic penguins', // comedy fringe acts
  ];
  // Solo performer names (no show title) — likely concerts not theater
  const soloPerformerPattern = /^[A-Z][a-z]+ [A-Z][a-z]+$/; // "FirstName LastName" only

  const seen = new Set();
  const showsList = [];
  for (const show of westEndShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;

    const titleLower = title.toLowerCase();
    if (WE_EXTRA_PATTERNS.some(p => titleLower.includes(p))) continue;
    // Skip likely solo concerts (just a person's name)
    if (soloPerformerPattern.test(title) && !titleLower.includes('musical') && !titleLower.includes('play')) continue;

    seen.add(title);
    showsList.push({
      title,
      venue: show.venue?.name || 'TBA',
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: show.startDate || null,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      category: 'west-end',
    });
  }

  console.log(`TodayTix London API: ${allShows.length} total London shows, ${westEndShows.length} West End-tagged, ${showsList.length} unique`);
  return showsList;
}

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
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

  // West End discovery via TodayTix London API
  if (includeWestEnd) {
    try {
      const westEndShows = await fetchShowsFromTodayTixLondon();
      console.log(`Found ${westEndShows.length} West End shows via TodayTix London API`);
      discoveredShows.push(...westEndShows);
    } catch (e) {
      console.log(`⚠️  TodayTix London API failed (${e.message}), skipping West End discovery`);
    }
    console.log('');
  }

  // Find new shows not in our database using improved duplicate detection
  const newShows = [];
  const skippedDuplicates = [];

  for (const show of discoveredShows) {
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

    // Use opening year for ID if available, otherwise current year
    const idYear = openingDate ? openingDate.split('-')[0] : new Date().getFullYear();
    const slug = slugify(show.title);

    // West End shows get a "-west-end-YEAR" suffix to distinguish from Broadway productions
    const showId = show.category === 'west-end'
      ? `${slug}-west-end-${idYear}`
      : `${slug}-${idYear}`;

    newShows.push({
      ...show,
      slug: slug,
      id: showId,
      openingDate,
      closingDate,
    });
  }

  // IBDB date enrichment: get accurate preview/opening/closing dates
  // Skip off-Broadway and West End shows — IBDB only covers Broadway
  const broadwayNewShows = newShows.filter(s => s.category !== 'off-broadway' && s.category !== 'west-end');
  const offBroadwayNewShows = newShows.filter(s => s.category === 'off-broadway');
  const westEndNewShows = newShows.filter(s => s.category === 'west-end');
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
    } else if (show.ibdbShowType) {
      // IBDB classification is authoritative (from the production page itself)
      detectedType = show.ibdbShowType;
      confidence = 'high';
    } else if (isPlay) {
      detectedType = 'play';
      confidence = 'medium';
    }

    return { show, detectedType, isRevival, confidence };
  });

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

      if (show.openingDate) {
        // Show has an opening date (from IBDB or Broadway.org)
        openingDate = show.openingDate;
        const openingDateObj = new Date(openingDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // If opening date is in the future, mark as upcoming (not yet in previews)
        // Shows get promoted to 'previews' when preview performances actually begin
        status = openingDateObj > today ? 'upcoming' : 'open';
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
        type: detection.detectedType, // Auto-detected with revival logic
        runtime: (runtimeEnrichments[show.id] && runtimeEnrichments[show.id].runtime) || null,
        intermissions: runtimeEnrichments[show.id] != null ? runtimeEnrichments[show.id].intermissions : null,
        images: {},
        synopsis: '',
        ageRecommendation: (runtimeEnrichments[show.id] && runtimeEnrichments[show.id].ageRecommendation) || null,
        previewsStartDate: show.previewsStartDate || null,
        tags: tags,
        theaterAddress: getTheaterAddress(show.venue) || null,
        ticketLinks: [],
        cast: [],
        creativeTeam: show.creativeTeam || [],
      };

      // Set category for non-Broadway shows
      if (show.category === 'off-broadway') {
        showEntry.category = 'off-broadway';
      } else if (show.category === 'west-end') {
        showEntry.category = 'west-end';
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

    // Save pending shows for review
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      discoveredAt: new Date().toISOString(),
      shows: newShows,
    }, null, 2));
    console.log(`📋 Saved pending shows to ${OUTPUT_FILE}`);
  }

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `new_shows_count=${newShows.length}\n`);
    fs.appendFileSync(outputFile, `new_shows=${newShows.map(s => s.title).join(', ')}\n`);
    fs.appendFileSync(outputFile, `new_slugs=${newShows.map(s => s.slug).join(',')}\n`);
    // WE-specific output for downstream triggers
    const weNewShows = newShows.filter(s => s.category === 'west-end');
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
