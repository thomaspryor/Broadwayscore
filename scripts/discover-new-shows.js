#!/usr/bin/env node
/**
 * Broadway New Show Discovery
 *
 * Discovers new Broadway shows by checking Broadway.org listings
 * and adds them to shows.json with basic metadata.
 *
 * Uses Bright Data (primary) with ScrapingBee/Playwright fallbacks.
 *
 * Usage: node scripts/discover-new-shows.js [--dry-run]
 *
 * Environment variables:
 *   BRIGHTDATA_TOKEN - Bright Data API token (primary)
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key (fallback)
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'new-shows-pending.json');

const dryRun = process.argv.includes('--dry-run');

// Broadway.org shows page
const BROADWAY_ORG_URL = 'https://www.broadway.org/shows/';

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
    .replace(/[!?'":\-–—,\.]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// Scraping is now handled by shared lib/scraper.js module

function parseShowsFromBroadwayOrg(html) {
  const shows = [];

  // Broadway.org 2026 structure: Each show is in a container with h4 title and date info
  // Pattern: <h4>Show Title</h4> ... "Begins: Mar 27, 2026" or "Through: Jun 7, 2026"

  // Extract show cards - they contain h4 headings with show titles
  const showCardPattern = /<div[^>]*>\s*<a[^>]*href="\/shows\/([^"]+)"[^>]*><\/a>\s*<div[^>]*>\s*<a[^>]*>\s*<h4[^>]*>([^<]+)<\/h4>/gi;

  let match;
  while ((match = showCardPattern.exec(html)) !== null) {
    const slug = match[1];
    const title = match[2].trim();

    // Find the context after this title to extract dates and venue
    const contextStart = match.index;
    const contextEnd = Math.min(html.length, contextStart + 2000);
    const context = html.substring(contextStart, contextEnd);

    // Extract venue (theater name)
    let venue = 'TBA';
    const venueMatch = context.match(/(?:href="\/broadway-theatres\/[^"]*"[^>]*>\s*<div[^>]*>\s*(?:<img[^>]*>)?\s*<div[^>]*>|<div[^>]*>\s*)([^<]+?)\s*(?:Theatre|Theater)/i);
    if (venueMatch) {
      venue = venueMatch[1].trim() + (venueMatch[0].includes('Theatre') ? ' Theatre' : ' Theater');
    }

    // Extract opening date (Begins: Date)
    let openingDate = null;
    const beginsMatch = context.match(/Begins:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/i);
    if (beginsMatch) {
      const parsedDate = new Date(beginsMatch[1]);
      if (!isNaN(parsedDate.getTime())) {
        openingDate = parsedDate.toISOString().split('T')[0];
      }
    }

    // Extract closing date (Through: Date)
    let closingDate = null;
    const throughMatch = context.match(/Through:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/i);
    if (throughMatch) {
      const parsedDate = new Date(throughMatch[1]);
      if (!isNaN(parsedDate.getTime())) {
        closingDate = parsedDate.toISOString().split('T')[0];
      }
    }

    if (title && title.length > 2 && title.length < 150) {
      shows.push({
        title: title,
        venue: venue,
        openingDate: openingDate,
        closingDate: closingDate,
        slug: slug,
      });
    }
  }

  return shows;
}

async function discoverShows() {
  console.log('='.repeat(60));
  console.log('BROADWAY SHOW DISCOVERY');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();
  const existingSlugs = new Set(data.shows.map(s => s.slug));
  const existingTitles = new Set(data.shows.map(s => s.title.toLowerCase()));

  console.log(`Existing shows in database: ${data.shows.length}`);
  console.log('');

  // Fetch Broadway.org
  console.log('Fetching Broadway.org...');
  let content, format;
  try {
    const result = await fetchPage(BROADWAY_ORG_URL, { renderJs: false });
    content = result.content;
    format = result.format;
    console.log(`Fetched ${content.length} bytes (${format} from ${result.source})`);
  } catch (e) {
    console.error('Error fetching Broadway.org:', e.message);
    console.log('');
    console.log('To enable discovery, set BRIGHTDATA_TOKEN or SCRAPINGBEE_API_KEY.');
    await cleanup();
    return { newShows: [], count: 0 };
  }

  // Parse shows (works with both HTML and markdown)
  const discoveredShows = parseShowsFromBroadwayOrg(content);
  console.log(`Found ${discoveredShows.length} shows on Broadway.org`);
  console.log('');

  // Cleanup resources
  await cleanup();

  // Find new shows not in our database
  const newShows = [];
  for (const show of discoveredShows) {
    const slug = slugify(show.title);
    const titleLower = show.title.toLowerCase();

    if (!existingSlugs.has(slug) && !existingTitles.has(titleLower)) {
      // Check if it's a variation of an existing show
      const isVariation = Array.from(existingTitles).some(t =>
        titleLower.includes(t) || t.includes(titleLower)
      );

      if (!isVariation) {
        newShows.push({
          ...show,
          slug: slug,
          id: `${slug}-${new Date().getFullYear()}`,
        });
      }
    }
  }

  if (newShows.length === 0) {
    console.log('✅ No new shows discovered - database is up to date');
    return { newShows: [], count: 0 };
  }

  console.log(`🎭 Found ${newShows.length} NEW show(s):`);
  console.log('-'.repeat(40));
  for (const show of newShows) {
    console.log(`  - ${show.title} (${show.venue})`);
  }
  console.log('');

  if (!dryRun) {
    // Add new shows to database
    for (const show of newShows) {
      // Determine status based on opening date
      let openingDate;
      let status;

      if (show.openingDate) {
        // Show has an opening date from Broadway.org
        openingDate = show.openingDate;
        const openingDateObj = new Date(openingDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // If opening date is in the future, mark as previews
        status = openingDateObj > today ? 'previews' : 'open';
      } else {
        // No opening date found - show is already running
        // Use placeholder date (will need manual update)
        openingDate = new Date().toISOString().split('T')[0];
        status = 'open';
      }

      data.shows.push({
        id: show.id,
        title: show.title,
        slug: show.slug,
        venue: show.venue,
        openingDate: openingDate,
        closingDate: show.closingDate || null,
        status: status,
        type: 'musical', // Default, needs manual verification
        runtime: null,
        intermissions: null,
        images: {},
        synopsis: '',
        ageRecommendation: null,
        previewsStartDate: show.previewsStartDate || null,
        tags: status === 'previews' ? ['upcoming'] : ['new'],
        ticketLinks: [],
        cast: [],
        creativeTeam: [],
      });
    }

    saveShows(data);
    console.log(`✅ Added ${newShows.length} shows to shows.json`);

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
  }

  return { newShows, count: newShows.length };
}

discoverShows().catch(e => {
  console.error('Discovery failed:', e);
  process.exit(1);
});
