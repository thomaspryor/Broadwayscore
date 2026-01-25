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
  const existingSlugs = new Set(data.shows.map(s => s.slug));
  const existingTitles = new Set(data.shows.map(s => s.title.toLowerCase()));

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

  // Find new shows not in our database
  const newShows = [];
  for (const show of allDiscoveredShows) {
    const slug = show.slug;
    const titleLower = show.title.toLowerCase();

    if (!existingSlugs.has(slug) && !existingTitles.has(titleLower)) {
      // Check if it's a variation of an existing show
      const isVariation = Array.from(existingTitles).some(t =>
        titleLower.includes(t) || t.includes(titleLower)
      );

      if (!isVariation) {
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

        // Extract year from season (use first year)
        const year = show.season.split('-')[0];

        newShows.push({
          ...show,
          id: `${slug}-${year}`,
          openingDate,
          closingDate,
        });
      }
    }
  }

  if (newShows.length === 0) {
    console.log('✅ No new historical shows discovered');
    return { newShows: [], count: 0 };
  }

  console.log(`🎭 Found ${newShows.length} NEW historical show(s):`);
  console.log('-'.repeat(40));
  for (const show of newShows) {
    console.log(`  - ${show.title} (${show.season}, ${show.venue})`);
  }
  console.log('');

  if (!dryRun) {
    // Add new shows to database
    for (const show of newShows) {
      data.shows.push({
        id: show.id,
        title: show.title,
        slug: show.slug,
        venue: show.venue,
        openingDate: show.openingDate || new Date().toISOString().split('T')[0],
        closingDate: show.closingDate,
        status: 'closed',
        type: 'musical', // Default, needs manual verification
        runtime: null,
        intermissions: null,
        images: {},
        synopsis: '',
        ageRecommendation: null,
        previewsStartDate: null,
        tags: ['historical'],
        ticketLinks: [],
        cast: [],
        creativeTeam: [],
      });
    }

    saveShows(data);
    console.log(`✅ Added ${newShows.length} historical shows to shows.json`);

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
