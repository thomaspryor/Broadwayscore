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

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[!?'\":\-–—,\.]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Normalize a title for comparison - strips subtitles, articles, punctuation
 * to catch variations like "All Out: Comedy About Ambition" vs "All Out"
 */
function normalizeTitle(title) {
  return title
    .toLowerCase()
    // Remove common subtitles/suffixes
    .replace(/:\s*.+$/, '')           // Remove everything after colon
    .replace(/\s*-\s*.+$/, '')        // Remove everything after dash
    .replace(/\s*\(.+\)$/, '')        // Remove parenthetical at end
    .replace(/\s+on\s+broadway$/i, '') // Remove "on Broadway"
    .replace(/\s+the\s+musical$/i, '') // Remove "The Musical"
    .replace(/\s+a\s+new\s+musical$/i, '') // Remove "A New Musical"
    // Remove articles at start
    .replace(/^(the|a|an)\s+/i, '')
    // Clean up
    .replace(/[!?'":\-–—,\.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a show might be a duplicate of an existing show
 * Returns { isDuplicate: boolean, reason: string, existingShow: object|null }
 */
function checkForDuplicate(newShow, existingShows) {
  const newSlug = slugify(newShow.title);
  const newTitleLower = newShow.title.toLowerCase().trim();
  const newTitleNormalized = normalizeTitle(newShow.title);
  const newVenue = newShow.venue?.toLowerCase().trim();

  for (const existing of existingShows) {
    const existingTitleLower = existing.title.toLowerCase().trim();
    const existingTitleNormalized = normalizeTitle(existing.title);
    const existingVenue = existing.venue?.toLowerCase().trim();

    // Check 1: Exact title match
    if (newTitleLower === existingTitleLower) {
      return {
        isDuplicate: true,
        reason: `Exact title match: "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 2: Exact slug match
    if (newSlug === existing.slug) {
      return {
        isDuplicate: true,
        reason: `Exact slug match: ${existing.slug}`,
        existingShow: existing
      };
    }

    // Check 3: Normalized title match (catches "Show: Subtitle" vs "Show")
    if (newTitleNormalized === existingTitleNormalized && newTitleNormalized.length > 3) {
      return {
        isDuplicate: true,
        reason: `Normalized title match: "${newTitleNormalized}" matches "${existing.title}"`,
        existingShow: existing
      };
    }

    // Check 4: Slug is contained within existing slug or vice versa
    if (newSlug.length > 5 && existing.slug.length > 5) {
      if (existing.slug.startsWith(newSlug) || newSlug.startsWith(existing.slug)) {
        return {
          isDuplicate: true,
          reason: `Slug prefix match: "${newSlug}" vs "${existing.slug}"`,
          existingShow: existing
        };
      }
    }

    // Check 5: Same venue + normalized title starts the same (first 10 chars)
    if (newVenue && existingVenue && newVenue === existingVenue) {
      if (newTitleNormalized.substring(0, 10) === existingTitleNormalized.substring(0, 10) &&
          newTitleNormalized.length > 5) {
        return {
          isDuplicate: true,
          reason: `Same venue "${newVenue}" + similar title start`,
          existingShow: existing
        };
      }
    }

    // Check 6: One title contains the other (for shorter titles > 5 chars)
    if (existingTitleNormalized.length > 5 && newTitleNormalized.length > 5) {
      if (newTitleNormalized.includes(existingTitleNormalized) ||
          existingTitleNormalized.includes(newTitleNormalized)) {
        return {
          isDuplicate: true,
          reason: `Title containment: "${newTitleNormalized}" vs "${existingTitleNormalized}"`,
          existingShow: existing
        };
      }
    }
  }

  return { isDuplicate: false, reason: null, existingShow: null };
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

  for (const show of allDiscoveredShows) {
    // Use the new comprehensive duplicate check
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

      data.shows.push({
        id: show.id,
        title: show.title,
        slug: show.slug,
        venue: show.venue,
        openingDate: show.openingDate || new Date().toISOString().split('T')[0],
        closingDate: show.closingDate,
        status: 'closed',
        type: detection.detectedType, // Auto-detected with revival logic
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
