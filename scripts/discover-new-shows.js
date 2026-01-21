#!/usr/bin/env node
/**
 * Broadway New Show Discovery
 * Run with: node scripts/discover-new-shows.js
 *
 * This script discovers new Broadway shows by checking TodayTix listings
 * and adds them to shows.json with basic metadata.
 *
 * When run in GitHub Actions, it outputs discovered shows for downstream processing.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'new-shows-pending.json');

// TodayTix API endpoints for Broadway shows
const TODAYTIX_API = 'https://api.todaytix.com/api/v2/shows?fieldset=summary&limit=100&location=35';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    };

    https.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return fetchJSON(response.headers.location).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}`));
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractShowData(todaytixShow) {
  // Extract relevant data from TodayTix API response
  return {
    todaytixId: todaytixShow.id,
    title: todaytixShow.displayName || todaytixShow.name,
    slug: slugify(todaytixShow.displayName || todaytixShow.name),
    venue: todaytixShow.venue?.name || 'TBA',
    type: todaytixShow.category?.name === 'Musicals' ? 'musical' : 'play',
    status: 'open',
    images: {
      hero: todaytixShow.images?.productMedia?.hero?.file?.url
        ? `https:${todaytixShow.images.productMedia.hero.file.url}`
        : null,
      thumbnail: todaytixShow.images?.productMedia?.appSquare?.file?.url
        ? `https:${todaytixShow.images.productMedia.appSquare.file.url}`
        : null,
    },
    synopsis: todaytixShow.tagLine || '',
    ticketLinks: [{
      platform: 'TodayTix',
      url: `https://www.todaytix.com/nyc/shows/${todaytixShow.id}`,
      priceFrom: todaytixShow.lowPrice || null,
    }],
  };
}

async function discoverNewShows() {
  console.log('Broadway New Show Discovery');
  console.log('============================\n');

  // Load current shows.json
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  const existingSlugs = new Set(showsData.shows.map(s => s.slug));
  const existingTitles = new Set(showsData.shows.map(s => s.title.toLowerCase()));

  console.log(`Currently tracking ${showsData.shows.length} shows\n`);
  console.log('Fetching current Broadway listings from TodayTix...\n');

  let todaytixShows = [];

  try {
    const response = await fetchJSON(TODAYTIX_API);
    todaytixShows = response.data || [];
    console.log(`Found ${todaytixShows.length} shows on TodayTix\n`);
  } catch (err) {
    console.error(`Error fetching TodayTix: ${err.message}`);

    // Fallback: try scraping the webpage instead
    console.log('Trying alternative discovery method...');
    // For now, we'll just exit gracefully
    return { newShows: [], existingCount: showsData.shows.length };
  }

  // Find new shows not in our database
  const newShows = [];

  for (const ttShow of todaytixShows) {
    const title = ttShow.displayName || ttShow.name;
    const slug = slugify(title);

    // Skip if we already have this show (by slug or title)
    if (existingSlugs.has(slug) || existingTitles.has(title.toLowerCase())) {
      continue;
    }

    // Skip non-Broadway shows (TodayTix includes off-broadway)
    const venue = ttShow.venue?.name || '';
    const isLikelyBroadway =
      venue.includes('Theatre') ||
      venue.includes('Theater') ||
      ttShow.category?.name === 'Broadway' ||
      ttShow.tags?.some(t => t.toLowerCase().includes('broadway'));

    if (!isLikelyBroadway) {
      continue;
    }

    const showData = extractShowData(ttShow);
    newShows.push(showData);

    console.log(`NEW: ${showData.title}`);
    console.log(`     Venue: ${showData.venue}`);
    console.log(`     Type: ${showData.type}`);
    console.log(`     TodayTix ID: ${showData.todaytixId}\n`);
  }

  console.log('============================');
  console.log(`Found ${newShows.length} new shows\n`);

  if (newShows.length === 0) {
    console.log('No new shows to add.');
    return { newShows: [], existingCount: showsData.shows.length };
  }

  // Add new shows to shows.json
  console.log('Adding new shows to shows.json...\n');

  let nextId = Math.max(...showsData.shows.map(s => s.id)) + 1;

  for (const newShow of newShows) {
    const fullShow = {
      id: nextId++,
      title: newShow.title,
      slug: newShow.slug,
      venue: newShow.venue,
      openingDate: null, // To be filled in manually or by data agent
      closingDate: null,
      status: 'open',
      type: newShow.type,
      runtime: null,
      intermissions: null,
      images: newShow.images,
      synopsis: newShow.synopsis,
      ageRecommendation: null,
      tags: [],
      ticketLinks: newShow.ticketLinks,
      cast: [],
      creativeTeam: [],
      officialUrl: null,
      trailerUrl: null,
      theaterAddress: null,
      _needsReviewData: true, // Flag for data agent
      _todaytixId: newShow.todaytixId,
    };

    showsData.shows.push(fullShow);
    console.log(`  Added: ${newShow.title} (ID: ${fullShow.id})`);
  }

  // Update metadata
  showsData._meta.lastUpdated = new Date().toISOString().split('T')[0];
  showsData._meta.showCount = showsData.shows.length;

  // Write updated shows.json
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(showsData, null, 2));
  console.log('\nshows.json updated successfully!');

  // Write pending shows list for data agent
  const pendingData = {
    discoveredAt: new Date().toISOString(),
    shows: newShows.map(s => ({
      slug: s.slug,
      title: s.title,
      todaytixId: s.todaytixId,
      needsReviewData: true,
    })),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(pendingData, null, 2));
  console.log(`\nPending shows written to: ${OUTPUT_FILE}`);

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const outputLines = [
      `new_shows_count=${newShows.length}`,
      `new_shows=${newShows.map(s => s.title).join(', ')}`,
      `new_slugs=${newShows.map(s => s.slug).join(',')}`,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, outputLines.join('\n') + '\n');
  }

  return { newShows, existingCount: showsData.shows.length - newShows.length };
}

// Also export for use as module
module.exports = { discoverNewShows };

// Run if called directly
if (require.main === module) {
  discoverNewShows()
    .then(result => {
      console.log('\n============================');
      console.log('Discovery Summary:');
      console.log(`  Previously tracked: ${result.existingCount}`);
      console.log(`  New shows found: ${result.newShows.length}`);
      if (result.newShows.length > 0) {
        console.log('\nNew shows need review data:');
        result.newShows.forEach(s => console.log(`  - ${s.title}`));
      }
    })
    .catch(console.error);
}
