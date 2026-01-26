#!/usr/bin/env node
/**
 * Broadway New Show Discovery
 *
 * Discovers new Broadway shows by checking Broadway.org listings
 * and adds them to shows.json with basic metadata.
 *
 * Uses Playwright to scrape JavaScript-rendered content.
 *
 * Usage: node scripts/discover-new-shows.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
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
  console.log('BROADWAY SHOW DISCOVERY');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();

  console.log(`Existing shows in database: ${data.shows.length}`);
  console.log('');

  // Fetch shows from Broadway.org using Playwright
  let discoveredShows;
  try {
    discoveredShows = await fetchShowsFromBroadwayOrg();
    console.log(`Found ${discoveredShows.length} shows on Broadway.org`);
    console.log('');
  } catch (e) {
    console.error('Error fetching Broadway.org:', e.message);
    console.log('');
    return { newShows: [], count: 0 };
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

    newShows.push({
      ...show,
      slug: slug,
      id: `${slug}-${idYear}`,
      openingDate,
      closingDate,
    });
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

discoverShows()
  .catch(e => {
    console.error('Discovery failed:', e);
    process.exit(1);
  })
  .finally(() => {
    // Clean up scraper resources
    cleanup().catch(console.error);
  });
