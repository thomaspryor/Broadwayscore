#!/usr/bin/env node
/**
 * Historical Broadway Show Discovery
 *
 * Discovers closed Broadway shows from past seasons by scraping Broadway.org
 * and adds them to shows.json with "closed" status.
 *
 * Works backwards through seasons, starting from most recent.
 *
 * Usage: node scripts/discover-historical-shows.js --seasons=2024-2025,2023-2024 [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { fetchPage, cleanup } = require('./lib/scraper');
const { checkKnownShow, detectPlayFromTitle } = require('./lib/known-shows');
const { slugify, checkForDuplicate } = require('./lib/deduplication');
const { isOfficialBroadwayTheater, getCanonicalVenueName, validateVenue } = require('./lib/broadway-theaters');
const { isTourProduction, validateBroadwayProduction } = require('./lib/tour-detection');
const { getSeasonForDate, validateSeason } = require('./lib/broadway-seasons');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'historical-shows-pending.json');

const dryRun = process.argv.includes('--dry-run');

// Parse season argument
const seasonsArg = process.argv.find(arg => arg.startsWith('--seasons='));
const seasons = seasonsArg ? seasonsArg.split('=')[1].split(',') : [];

if (seasons.length === 0) {
  console.error('❌ Error: Must specify at least one season with --seasons=YYYY-YYYY');
  console.error('   Example: --seasons=2024-2025,2023-2024');
  process.exit(1);
}

// Broadway.org archive by season
// Example: https://www.broadway.org/shows/archive/season/2024-2025/
function getBroadwayOrgSeasonUrl(season) {
  return `https://www.broadway.org/shows/archive/season/${season}/`;
}

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function fetchShowsFromSeason(season) {
  const url = getBroadwayOrgSeasonUrl(season);
  console.log(`Fetching season ${season}...`);

  try {
    const result = await fetchPage(url);
    console.log(`  Received ${result.format} content from ${result.source}`);

    // Parse HTML with JSDOM
    const dom = new JSDOM(result.content);
    const document = dom.window.document;

    const showsList = [];

    // Find show titles (h4 headings or links)
    const h4s = Array.from(document.querySelectorAll('h4'));
    console.log(`  Found ${h4s.length} h4 headings`);

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
        const openedMatch = text.match(/Opened:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
        const closedMatch = text.match(/Closed:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);

        // For historical shows, we expect a closing date
        if (!showsList.find(s => s.title === title)) {
          showsList.push({
            title,
            venue,
            slug: slugify(title),
            openingDate: openedMatch ? openedMatch[1] : null,
            closingDate: closedMatch ? closedMatch[1] : null,
            season
          });
        }
      });
    } else {
      // Fallback: try to find show links
      const showLinks = Array.from(document.querySelectorAll('a[href^="/shows/"]'));
      console.log(`  Found ${showLinks.length} show links`);

      for (const link of showLinks) {
        const href = link.getAttribute('href');
        if (!href || href === '/shows/') continue;

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

        const openedMatch = text.match(/Opened:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
        const closedMatch = text.match(/Closed:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);

        if (!showsList.find(s => s.title === title)) {
          showsList.push({
            title,
            venue,
            slug: slugify(title),
            openingDate: openedMatch ? openedMatch[1] : null,
            closingDate: closedMatch ? closedMatch[1] : null,
            season
          });
        }
      }
    }

    console.log(`  Extracted ${showsList.length} shows from ${season}`);
    return showsList;
  } catch (e) {
    console.error(`  ⚠️  Error fetching ${season}: ${e.message}`);
    return [];
  }
}

async function discoverHistoricalShows() {
  console.log('='.repeat(60));
  console.log('BROADWAY HISTORICAL SHOW DISCOVERY');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Seasons: ${seasons.join(', ')}`);
  console.log('');

  const data = loadShows();

  console.log(`Existing shows in database: ${data.shows.length}`);
  console.log('');

  // Fetch shows from each season
  const allDiscoveredShows = [];
  for (const season of seasons) {
    const seasonShows = await fetchShowsFromSeason(season);
    allDiscoveredShows.push(...seasonShows);
  }

  console.log('');
  console.log(`Total shows discovered: ${allDiscoveredShows.length}`);
  console.log('');

  // Find new shows not in our database using improved duplicate detection
  const newShows = [];
  const skippedDuplicates = [];
  const skippedTours = [];
  const skippedInvalidVenue = [];

  for (const show of allDiscoveredShows) {
    // STEP 1: Tour detection - reject non-Broadway productions
    const tourCheck = isTourProduction(show);
    if (tourCheck.isTour) {
      skippedTours.push({
        title: show.title,
        season: show.season,
        reason: tourCheck.reason,
        type: tourCheck.type
      });
      continue;
    }

    // STEP 2: Venue validation - normalize and validate
    const venueValidation = validateVenue(show.venue);
    if (!venueValidation.isValid && show.venue && show.venue !== 'TBA') {
      skippedInvalidVenue.push({
        title: show.title,
        season: show.season,
        venue: show.venue,
        reason: venueValidation.reason
      });
      continue;
    }

    // Normalize venue name to canonical form
    if (venueValidation.isValid) {
      show.venue = venueValidation.canonical;
    }

    // STEP 3: Season validation
    if (show.openingDate) {
      try {
        const computedSeason = getSeasonForDate(show.openingDate);
        if (computedSeason !== show.season) {
          console.log(`  ⚠️  Season mismatch for "${show.title}": listed as ${show.season}, date suggests ${computedSeason}`);
        }
      } catch (e) {
        // Date parsing issue - will be handled later
      }
    }

    // STEP 4: Duplicate check
    const duplicateCheck = checkForDuplicate(show, data.shows);

    if (duplicateCheck.isDuplicate) {
      skippedDuplicates.push({
        title: show.title,
        season: show.season,
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

    // Use opening year if available, otherwise extract from season
    const idYear = openingDate ? openingDate.split('-')[0] : show.season.split('-')[0];
    const slug = show.slug;

    newShows.push({
      ...show,
      id: `${slug}-${idYear}`,
      openingDate,
      closingDate,
    });
  }

  // Log skipped tours
  if (skippedTours.length > 0) {
    console.log(`🚫 Rejected ${skippedTours.length} tour/non-Broadway production(s):`);
    for (const skip of skippedTours) {
      console.log(`   - "${skip.title}" [${skip.season}] (${skip.type}: ${skip.reason})`);
    }
    console.log('');
  }

  // Log skipped invalid venues
  if (skippedInvalidVenue.length > 0) {
    console.log(`⚠️  Skipped ${skippedInvalidVenue.length} show(s) with unrecognized venues:`);
    for (const skip of skippedInvalidVenue) {
      console.log(`   - "${skip.title}" at "${skip.venue}" [${skip.season}]`);
    }
    console.log('');
  }

  // Log skipped duplicates for debugging
  if (skippedDuplicates.length > 0) {
    console.log(`⏭️  Skipped ${skippedDuplicates.length} duplicate(s):`);
    for (const skip of skippedDuplicates) {
      console.log(`   - "${skip.title}" [${skip.season}] (${skip.reason}) → existing: ${skip.existingId}`);
    }
    console.log('');
  }

  if (newShows.length === 0) {
    console.log('✅ No new historical shows discovered');
    return { newShows: [], count: 0 };
  }

  console.log(`🎭 Found ${newShows.length} NEW historical show(s):`);
  console.log('-'.repeat(40));

  // Analyze shows for revival detection
  const revivalDetection = newShows.map(show => {
    const knownCheck = checkKnownShow(show.title);
    const isPlay = detectPlayFromTitle(show.title);

    let detectedType = 'musical'; // default
    let isRevival = false;
    let confidence = 'low';

    if (knownCheck.isKnown) {
      // Known classic - likely a revival
      detectedType = knownCheck.type === 'play' ? 'revival' : 'revival';
      isRevival = true;
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
    console.log(`  ${confidenceLabel} ${show.title} (${show.season}) → ${typeLabel}`);
  }
  console.log('');

  if (!dryRun) {
    // Add new shows to database
    for (let i = 0; i < newShows.length; i++) {
      const show = newShows[i];
      const detection = revivalDetection[i];

      // Build tags based on detection
      const tags = ['historical'];
      if (detection.isRevival) {
        tags.push('revival');
      }

      // Find existing productions of this show for revival linking
      let originalProductionId = null;
      let productionNumber = 1;

      if (detection.isRevival) {
        // Look for existing productions with similar title
        const existingProductions = data.shows.filter(s => {
          const sBase = s.slug.replace(/-\d{4}$/, '');
          const newBase = show.slug.replace(/-\d{4}$/, '');
          return sBase === newBase && s.id !== show.id;
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
        openingDate: show.openingDate || new Date().toISOString().split('T')[0],
        closingDate: show.closingDate,
        status: 'closed',
        type: detection.detectedType === 'revival' ? (detection.isPlay ? 'play' : 'musical') : detection.detectedType,
        runtime: null,
        intermissions: null,
        images: {},
        synopsis: '',
        ageRecommendation: null,
        previewsStartDate: null,
        tags: tags,
        ticketLinks: [],
        cast: [],
        creativeTeam: [],
        // Revival metadata
        isRevival: detection.isRevival,
        originalProductionId: originalProductionId,
        productionNumber: productionNumber,
        // Season tracking
        season: show.season,
      });
    }

    saveShows(data);
    console.log(`✅ Added ${newShows.length} historical shows to shows.json`);

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
      seasons: seasons,
      shows: newShows,
    }, null, 2));
    console.log(`📋 Saved pending shows to ${OUTPUT_FILE}`);
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
  })
  .finally(() => {
    cleanup().catch(console.error);
  });
