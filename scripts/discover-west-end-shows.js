#!/usr/bin/env node
/**
 * West End Show Discovery
 *
 * Discovers currently-running West End shows using TodayTix London API.
 * Adds new shows to shows.json with category: 'west-end'.
 *
 * Usage: node scripts/discover-west-end-shows.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const dryRun = process.argv.includes('--dry-run');

// Hardcoded IDs for manually-added test shows — prevents duplicates
const EXISTING_TEST_SHOWS = {
  'hadestown': 'hadestown-west-end-2024',
  'oh mary': 'oh-mary-west-end-2025',
  'oh, mary!': 'oh-mary-west-end-2025',
  'oh mary!': 'oh-mary-west-end-2025',
};

function slugify(title) {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // Strip diacritics (é→e, ü→u)
    .toLowerCase()
    .replace(/[''\u2019]/g, '')  // Remove apostrophes
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function fetchTodayTixPage(offset = 0, limit = 100) {
  return new Promise((resolve, reject) => {
    const url = `https://api.todaytix.com/api/v2/shows?location=2&limit=${limit}&offset=${offset}`;
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

async function fetchWestEndShows() {
  console.log('Fetching West End shows from TodayTix London API...');
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

  // Filter to West End subcategory
  const westEndShows = allShows.filter(s =>
    s.subcategories?.some(sc => sc.name === 'West End')
  );

  // Filter out non-theatre content (opera, ballet, concerts, solo shows, immersive dining)
  const nonTheatrePatterns = [
    'royal ballet and opera', 'english national opera',
    'ballet', 'opera',
    'musicals by candlelight',
    'dining experience', 'immersive dining',
    'prehistoric planet', 'discovering dinosaurs',
  ];
  // Shows that match nonTheatrePatterns but ARE legitimate theatre (allowlist)
  const allowlist = [
    'the phantom of the opera',
    'la boheme',           // if a theatrical staging ever appears
  ];
  // Solo artist names (no show title, just performer concerts)
  const soloArtistPatterns = [
    'sierra boggess', 'megan hilty', 'jamie muscato',
  ];
  // Known Off West End venues — not in the official 40 West End theatres
  const offWestEndVenues = [
    'charing cross theatre',
    // London Hippodrome kept as borderline — TodayTix tags it WE
  ];

  const theatreShows = westEndShows.filter(s => {
    const title = (s.displayName || s.name || '').toLowerCase();
    const venue = (s.venue?.name || '').toLowerCase();
    // Check allowlist first — overrides nonTheatrePatterns
    if (allowlist.some(a => title.includes(a))) return true;
    for (const pattern of nonTheatrePatterns) {
      if (title.includes(pattern)) return false;
    }
    for (const pattern of soloArtistPatterns) {
      if (title === pattern) return false;
    }
    // Filter Off West End venues
    if (offWestEndVenues.some(v => venue.includes(v))) return false;
    return true;
  });

  console.log(`Filtered: ${westEndShows.length} West End-tagged → ${theatreShows.length} theatre shows (removed ${westEndShows.length - theatreShows.length} non-theatre)`);

  // Deduplicate by displayName
  const seen = new Set();
  const showsList = [];

  for (const show of theatreShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());

    // Determine type from TodayTix category
    const categoryName = show.category?.name || '';
    const type = categoryName === 'Musicals' ? 'musical' : 'play';

    // Parse dates
    let openingDate = null;
    if (show.startDate) {
      const parsed = new Date(show.startDate);
      if (!isNaN(parsed.getTime())) {
        openingDate = parsed.toISOString().split('T')[0];
      }
    }

    let closingDate = null;
    if (show.endDate && show.endDate !== 'null') {
      const parsed = new Date(show.endDate);
      if (!isNaN(parsed.getTime())) {
        closingDate = parsed.toISOString().split('T')[0];
      }
    }

    // Filter one-off events: skip shows with < 7 day run (concerts, specials)
    if (openingDate && closingDate) {
      const runDays = Math.ceil((new Date(closingDate) - new Date(openingDate)) / (1000 * 60 * 60 * 24));
      if (runDays < 7) {
        console.log(`  Skipping "${title}" — ${runDays}-day run (one-off event)`);
        continue;
      }
    }

    // Determine year for ID — use startDate year, fallback to current year
    const year = openingDate ? openingDate.split('-')[0] : String(new Date().getFullYear());

    const slug = slugify(title);
    const id = `${slug}-west-end-${year}`;

    // Build TodayTix URL
    const todayTixUrl = show.slug
      ? `https://www.todaytix.com/london/shows/${show.id}-${show.slug}`
      : null;

    showsList.push({
      title,
      id,
      slug: `${slug}-west-end`,
      venue: show.venue?.name || 'TBA',
      openingDate,
      closingDate,
      type,
      todayTixId: show.id,
      todayTixUrl,
      subcategories: (show.subcategories || []).map(sc => sc.name),
    });
  }

  console.log(`TodayTix API: ${allShows.length} total London shows, ${westEndShows.length} West End-tagged, ${showsList.length} unique`);
  return showsList;
}

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function isTestShowDuplicate(title) {
  const normalized = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  for (const [key, existingId] of Object.entries(EXISTING_TEST_SHOWS)) {
    if (normalized === key || normalized.startsWith(key + ' ')) {
      return existingId;
    }
  }
  return null;
}

async function main() {
  console.log('='.repeat(60));
  console.log('WEST END SHOW DISCOVERY');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();
  const existingIds = new Set(data.shows.map(s => s.id));
  const existingWE = data.shows.filter(s => s.category === 'west-end');
  console.log(`Existing shows: ${data.shows.length} total, ${existingWE.length} West End`);
  console.log('');

  let discoveredShows;
  try {
    discoveredShows = await fetchWestEndShows();
  } catch (e) {
    console.error(`ERROR: TodayTix API failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (discoveredShows.length === 0) {
    console.error('ERROR: No West End shows found from TodayTix API.');
    process.exitCode = 1;
    return;
  }

  // Find new shows
  const newShows = [];
  const skipped = [];

  for (const show of discoveredShows) {
    // Check hardcoded test show IDs first
    const testShowId = isTestShowDuplicate(show.title);
    if (testShowId) {
      skipped.push({ title: show.title, reason: `test show duplicate (${testShowId})` });
      continue;
    }

    // Check if ID already exists
    if (existingIds.has(show.id)) {
      skipped.push({ title: show.title, reason: `ID exists: ${show.id}` });
      continue;
    }

    // Check for title match among existing WE shows (different year/ID)
    const titleLower = show.title.toLowerCase();
    const titleMatch = existingWE.find(s => s.title.toLowerCase() === titleLower);
    if (titleMatch) {
      skipped.push({ title: show.title, reason: `title match: ${titleMatch.id}` });
      continue;
    }

    newShows.push(show);
  }

  // Report
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} duplicate(s):`);
    for (const s of skipped) {
      console.log(`  - "${s.title}" (${s.reason})`);
    }
    console.log('');
  }

  if (newShows.length === 0) {
    console.log('No new West End shows to add.');
    return;
  }

  console.log(`Found ${newShows.length} NEW West End show(s):`);
  console.log('-'.repeat(50));
  for (const show of newShows) {
    console.log(`  ${show.title} (${show.type}) @ ${show.venue} [${show.id}]`);
  }
  console.log('');

  if (dryRun) {
    console.log('DRY RUN — no changes written.');
    return;
  }

  // Determine show status based on dates
  const now = new Date();

  // Add new shows to shows.json
  let added = 0;
  for (const show of newShows) {
    // Determine status
    let status = 'open';
    if (show.closingDate) {
      const closing = new Date(show.closingDate);
      if (closing < now) status = 'closed';
    }

    const entry = {
      id: show.id,
      title: show.title,
      slug: show.slug,
      venue: show.venue,
      openingDate: show.openingDate,
      closingDate: show.closingDate,
      status,
      type: show.type,
      category: 'west-end',
      tags: [show.type, 'west-end'],
      ticketLinks: show.todayTixUrl ? [{
        platform: 'TodayTix',
        url: show.todayTixUrl,
      }] : [],
    };

    data.shows.push(entry);
    added++;
  }

  saveShows(data);
  console.log(`Added ${added} West End shows to shows.json`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
