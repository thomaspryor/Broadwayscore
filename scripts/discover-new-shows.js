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
const { chromium } = require('playwright');

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

async function fetchShowsFromBroadwayOrg() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log(`Navigating to ${BROADWAY_ORG_URL}...`);
  await page.goto(BROADWAY_ORG_URL, { waitUntil: 'networkidle', timeout: 30000 });

  console.log('Waiting for show content to render...');
  // Just wait for JavaScript to render
  await page.waitForTimeout(5000);

  console.log('Extracting show data from rendered DOM...');
  const shows = await page.evaluate(() => {
    const showsList = [];

    // Look for all links that go to /shows/[slug]
    const showLinks = Array.from(document.querySelectorAll('a[href^="/shows/"]'));

    for (const link of showLinks) {
      const href = link.getAttribute('href');
      if (!href || href === '/shows/') continue;

      const slug = href.replace('/shows/', '');

      // Find h4 within or near this link
      const h4 = link.querySelector('h4') || link.closest('div')?.querySelector('h4');
      if (!h4) continue;

      const title = h4.textContent.trim();
      if (!title || title.length < 3) continue;

      // Find parent container for dates and venue
      let container = link.closest('div');
      if (container) {
        container = container.parentElement || container;
      }

      const venue = container?.querySelector('a[href*="/broadway-theatres/"]')?.textContent?.trim() || 'TBA';
      const text = container?.textContent || '';

      const beginsMatch = text.match(/Begins:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
      const throughMatch = text.match(/Through:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);

      // Avoid duplicates
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

    return showsList;
  });

  await browser.close();
  console.log(`Extracted ${shows.length} shows from Broadway.org`);

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

        newShows.push({
          ...show,
          slug: slug,
          id: `${slug}-${new Date().getFullYear()}`,
          openingDate,
          closingDate,
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
