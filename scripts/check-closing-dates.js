#!/usr/bin/env node
/**
 * check-closing-dates.js
 *
 * Weekly check for Broadway closing date changes:
 * 1. Finds NEW closing dates for shows without one
 * 2. Detects EXTENSIONS (closing date pushed later) - common marketing tactic
 * 3. Flags discrepancies for review
 *
 * Usage: node scripts/check-closing-dates.js [--dry-run]
 *
 * Requires: SCRAPINGBEE_API_KEY environment variable
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const BROADWAY_ORG_URL = 'https://www.broadway.org/shows/';

const dryRun = process.argv.includes('--dry-run');
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function fetchWithScrapingBee(url) {
  if (!SCRAPINGBEE_KEY) {
    console.log('⚠️  SCRAPINGBEE_API_KEY not set, skipping web scrape');
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
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function parseClosingDate(text) {
  // Try to parse various date formats
  // "Closes February 8, 2026", "Closing Date: Feb 8, 2026", "through February 8"
  const patterns = [
    /(?:closes?|closing|through|ends?|final)[:\s]+(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:closes?|closing|through|ends?|final)[:\s]+(\w+\s+\d{1,2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const dateStr = match[1];
      // Add current year if not present
      const hasYear = /\d{4}/.test(dateStr);
      const fullDateStr = hasYear ? dateStr : `${dateStr}, ${new Date().getFullYear()}`;

      try {
        const date = new Date(fullDateStr);
        if (!isNaN(date.getTime())) {
          // If date is in the past, assume next year
          if (date < new Date() && !hasYear) {
            date.setFullYear(date.getFullYear() + 1);
          }
          return date.toISOString().split('T')[0];
        }
      } catch (e) {
        // Continue to next pattern
      }
    }
  }
  return null;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[!?'":,\-–—]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

async function checkClosingDates() {
  console.log('='.repeat(60));
  console.log('BROADWAY CLOSING DATE CHECK');
  console.log('='.repeat(60));
  console.log(`Date: ${new Date().toISOString().split('T')[0]}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();
  const openShows = data.shows.filter(s => s.status === 'open');
  const showsWithoutClosingDate = openShows.filter(s => !s.closingDate);
  const showsWithClosingDate = openShows.filter(s => s.closingDate);

  console.log(`Open shows: ${openShows.length}`);
  console.log(`Without closing date: ${showsWithoutClosingDate.length}`);
  console.log(`With closing date: ${showsWithClosingDate.length}`);
  console.log('');

  // Create lookup map for ALL open shows (to check for extensions too)
  const showLookup = {};
  for (const show of openShows) {
    const normalized = normalizeTitle(show.title);
    showLookup[normalized] = show;
  }

  if (showsWithoutClosingDate.length > 0) {
    console.log('Shows needing closing dates:');
    for (const show of showsWithoutClosingDate) {
      console.log(`  - ${show.title}`);
    }
    console.log('');
  }

  if (showsWithClosingDate.length > 0) {
    console.log('Shows to check for extensions:');
    for (const show of showsWithClosingDate) {
      console.log(`  - ${show.title} (current: ${show.closingDate})`);
    }
    console.log('');
  }

  // Try to fetch Broadway.org
  console.log('Fetching Broadway.org for closing date announcements...');

  try {
    const html = await fetchWithScrapingBee(BROADWAY_ORG_URL);

    if (!html) {
      console.log('Could not fetch Broadway.org');
      return;
    }

    console.log(`Fetched ${html.length} bytes`);

    // Parse for show listings and closing dates
    // Broadway.org format: <div class="show-card">...<span class="closing-date">Closes Feb 8</span>...
    const newDates = [];      // Shows that didn't have a date
    const extensions = [];    // Shows where the date moved later (extended!)

    // Simple regex to find show names with closing info
    // This is a simplified approach - a proper HTML parser would be better
    const showBlocks = html.match(/<article[^>]*class="[^"]*show[^"]*"[^>]*>[\s\S]*?<\/article>/gi) || [];

    for (const block of showBlocks) {
      // Extract title
      const titleMatch = block.match(/<h[23][^>]*>([^<]+)<\/h[23]>/i);
      if (!titleMatch) continue;

      const title = titleMatch[1].trim();
      const normalized = normalizeTitle(title);

      // Check if this is one of our open shows
      const show = showLookup[normalized];
      if (!show) continue;

      // Look for closing date in this block
      const scrapedDate = parseClosingDate(block);
      if (scrapedDate) {
        if (!show.closingDate) {
          // New closing date
          newDates.push({
            id: show.id,
            title: show.title,
            closingDate: scrapedDate,
            type: 'new',
          });
        } else if (scrapedDate > show.closingDate) {
          // Extension! The date moved later
          extensions.push({
            id: show.id,
            title: show.title,
            oldDate: show.closingDate,
            closingDate: scrapedDate,
            type: 'extension',
          });
        }
      }
    }

    // Also try a broader search for closing announcements
    const closingMatches = html.matchAll(/([A-Z][^<]{2,50}?)(?:<[^>]+>)*\s*(?:closes?|closing)[:\s]+(\w+\s+\d{1,2},?\s*\d{0,4})/gi);
    for (const match of closingMatches) {
      const title = match[1].replace(/<[^>]+>/g, '').trim();
      const normalized = normalizeTitle(title);
      const show = showLookup[normalized];

      if (show && !newDates.find(u => u.id === show.id) && !extensions.find(u => u.id === show.id)) {
        const scrapedDate = parseClosingDate(match[0]);
        if (scrapedDate) {
          if (!show.closingDate) {
            newDates.push({
              id: show.id,
              title: show.title,
              closingDate: scrapedDate,
              type: 'new',
            });
          } else if (scrapedDate > show.closingDate) {
            extensions.push({
              id: show.id,
              title: show.title,
              oldDate: show.closingDate,
              closingDate: scrapedDate,
              type: 'extension',
            });
          }
        }
      }
    }

    // Report and apply new closing dates
    if (newDates.length > 0) {
      console.log('');
      console.log('NEW CLOSING DATES:');
      console.log('-'.repeat(40));
      for (const update of newDates) {
        console.log(`  📅 ${update.title}: ${update.closingDate}`);

        if (!dryRun) {
          const show = data.shows.find(s => s.id === update.id);
          if (show) {
            show.closingDate = update.closingDate;
          }
        }
      }
    }

    // Report and apply extensions
    if (extensions.length > 0) {
      console.log('');
      console.log('🎉 EXTENSIONS DETECTED (closing date pushed later):');
      console.log('-'.repeat(40));
      for (const update of extensions) {
        console.log(`  📅 ${update.title}: ${update.oldDate} → ${update.closingDate}`);

        if (!dryRun) {
          const show = data.shows.find(s => s.id === update.id);
          if (show) {
            show.closingDate = update.closingDate;
          }
        }
      }
    }

    const totalUpdates = newDates.length + extensions.length;
    if (totalUpdates > 0) {
      if (!dryRun) {
        saveShows(data);
        console.log('');
        console.log(`✅ Updated ${totalUpdates} shows (${newDates.length} new, ${extensions.length} extensions)`);
      }
    } else {
      console.log('');
      console.log('No closing date changes found in scrape.');
      console.log('(This may require manual checking of Broadway news sources)');
    }

  } catch (error) {
    console.error('Error fetching data:', error.message);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('TIP: For shows without announced closing dates, check:');
  console.log('  - https://www.broadway.org/shows/');
  console.log('  - https://playbill.com/article/broadway-grosses');
  console.log('  - https://www.broadwayworld.com/');
  console.log('='.repeat(60));
}

// Run
checkClosingDates();
