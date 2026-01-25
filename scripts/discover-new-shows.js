#!/usr/bin/env node
/**
 * Broadway New Show Discovery
 *
 * Discovers new Broadway shows by checking Broadway.org listings
 * and adds them to shows.json with basic metadata.
 *
 * Uses ScrapingBee for reliable scraping (API key in env).
 *
 * Usage: node scripts/discover-new-shows.js [--dry-run]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'new-shows-pending.json');
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

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

async function fetchWithScrapingBee(url) {
  if (!SCRAPINGBEE_KEY) {
    console.log('⚠️  SCRAPINGBEE_API_KEY not set');
    return null;
  }

  const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false`;

  return new Promise((resolve, reject) => {
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

function parseShowsFromBroadwayOrg(html) {
  const shows = [];

  // Look for show cards in the HTML
  // Broadway.org uses various patterns, this covers common ones
  const showPatterns = [
    // Show card with title and venue
    /<article[^>]*class="[^"]*show[^"]*"[^>]*>[\s\S]*?<h[23][^>]*>([^<]+)<\/h[23]>[\s\S]*?(?:venue|theater)[^>]*>([^<]*)</gi,
    // Alternative pattern
    /<div[^>]*class="[^"]*show-card[^"]*"[^>]*>[\s\S]*?<[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<[\s\S]*?<[^>]*class="[^"]*venue[^"]*"[^>]*>([^<]+)</gi,
  ];

  // Simple extraction - look for show titles followed by venue info
  const titleMatches = html.matchAll(/<h[23][^>]*class="[^"]*(?:title|name)[^"]*"[^>]*>([^<]+)<\/h[23]>/gi);
  for (const match of titleMatches) {
    const title = match[1].trim();
    if (title && title.length > 2 && title.length < 100) {
      shows.push({
        title: title,
        venue: 'TBA',
        status: 'open',
      });
    }
  }

  // Also check for JSON-LD structured data
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      if (Array.isArray(jsonLd)) {
        for (const item of jsonLd) {
          if (item['@type'] === 'Event' || item['@type'] === 'TheaterEvent') {
            shows.push({
              title: item.name,
              venue: item.location?.name || 'TBA',
              status: 'open',
            });
          }
        }
      }
    } catch (e) {
      // JSON-LD parsing failed, continue with regex results
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
  let html;
  try {
    html = await fetchWithScrapingBee(BROADWAY_ORG_URL);
    if (!html) {
      console.log('Could not fetch Broadway.org (no API key?)');
      console.log('');
      console.log('To enable discovery, set SCRAPINGBEE_API_KEY environment variable.');
      return { newShows: [], count: 0 };
    }
    console.log(`Fetched ${html.length} bytes`);
  } catch (e) {
    console.error('Error fetching Broadway.org:', e.message);
    return { newShows: [], count: 0 };
  }

  // Parse shows
  const discoveredShows = parseShowsFromBroadwayOrg(html);
  console.log(`Found ${discoveredShows.length} shows on Broadway.org`);
  console.log('');

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
      data.shows.push({
        id: show.id,
        title: show.title,
        slug: show.slug,
        venue: show.venue,
        openingDate: new Date().toISOString().split('T')[0], // Placeholder
        closingDate: null,
        status: 'open',
        type: 'musical', // Default, needs manual verification
        runtime: null,
        intermissions: null,
        images: {},
        synopsis: '',
        ageRecommendation: null,
        tags: ['new'],
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
