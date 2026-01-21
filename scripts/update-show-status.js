#!/usr/bin/env node
/**
 * Broadway Show Status Updater
 * Run with: node scripts/update-show-status.js
 *
 * This script checks for show status changes (closing dates, new openings)
 * and updates shows.json accordingly.
 *
 * Sources:
 * - TodayTix API (for closing dates and ticket availability)
 * - Playbill (for announcements)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

// TodayTix show IDs mapped to our slugs
const TODAYTIX_SHOWS = {
  'two-strangers': 45002,
  'maybe-happy-ending': 41018,
  'the-outsiders': 34093,
  'hells-kitchen': 37579,
  'operation-mincemeat': 42680,
  'oh-mary': 38371,
  'the-great-gatsby': 38749,
  'bug': 44892,
  'wicked': 1,
  'hamilton': 384,
  'the-lion-king': 42,
  'chicago': 22,
  'moulin-rouge': 15911,
  'aladdin': 105,
  'hadestown': 14748,
  'mj': 23379,
  'six': 20737,
  'book-of-mormon': 127,
  'and-juliet': 25598,
  'harry-potter': 1377,
  'mamma-mia': 42850,
  'stranger-things': 40958,
};

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    };

    https.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return fetchPage(response.headers.location).then(resolve).catch(reject);
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(data));
      response.on('error', reject);
    }).on('error', reject);
  });
}

function extractClosingDate(html) {
  // Look for closing date patterns in TodayTix pages
  // Pattern: "Final performance" or "Closes" or "through [date]"
  const patterns = [
    /final\s+performance[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /closes?\s+(?:on\s+)?([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /through\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /closing\s+(?:date)?[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /ends?\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        const date = new Date(match[1]);
        if (!isNaN(date.getTime())) {
          return date.toISOString().split('T')[0];
        }
      } catch (e) {
        // Continue to next pattern
      }
    }
  }

  return null;
}

function extractShowStatus(html) {
  // Check if show is sold out or no longer available
  if (/sold\s+out/i.test(html) || /no\s+longer\s+available/i.test(html) || /tickets\s+not\s+available/i.test(html)) {
    return 'closed';
  }

  // Check for preview status
  if (/in\s+previews/i.test(html) || /previews\s+begin/i.test(html)) {
    return 'previews';
  }

  // Check if actively selling tickets
  if (/buy\s+tickets/i.test(html) || /get\s+tickets/i.test(html) || /from\s+\$/i.test(html)) {
    return 'open';
  }

  return null;
}

async function checkShowStatus(slug, todaytixId) {
  const url = `https://www.todaytix.com/nyc/shows/${todaytixId}`;
  console.log(`  Checking ${slug}...`);

  try {
    const html = await fetchPage(url);
    const closingDate = extractClosingDate(html);
    const status = extractShowStatus(html);

    return {
      slug,
      closingDate,
      status,
      url,
    };
  } catch (err) {
    console.log(`    Error: ${err.message}`);
    return { slug, error: err.message };
  }
}

async function main() {
  console.log('Broadway Show Status Updater');
  console.log('============================\n');

  // Load current shows.json
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  const shows = showsData.shows;
  const updates = [];

  console.log('Checking show statuses from TodayTix...\n');

  for (const [slug, todaytixId] of Object.entries(TODAYTIX_SHOWS)) {
    const result = await checkShowStatus(slug, todaytixId);

    // Find matching show in our data
    const show = shows.find(s => s.slug === slug);
    if (!show) {
      console.log(`    Warning: Show ${slug} not found in shows.json`);
      continue;
    }

    // Check for updates
    let hasUpdate = false;
    const update = { slug, changes: [] };

    // Check closing date changes
    if (result.closingDate && result.closingDate !== show.closingDate) {
      update.changes.push({
        field: 'closingDate',
        old: show.closingDate,
        new: result.closingDate,
      });
      hasUpdate = true;
    }

    // Check status changes
    if (result.status && result.status !== show.status) {
      // Auto-close shows past their closing date
      const today = new Date().toISOString().split('T')[0];
      if (show.closingDate && show.closingDate < today && show.status === 'open') {
        update.changes.push({
          field: 'status',
          old: show.status,
          new: 'closed',
        });
        hasUpdate = true;
      } else if (result.status !== show.status) {
        update.changes.push({
          field: 'status',
          old: show.status,
          new: result.status,
        });
        hasUpdate = true;
      }
    }

    if (hasUpdate) {
      updates.push(update);
      console.log(`    Found updates for ${slug}:`);
      update.changes.forEach(c => console.log(`      ${c.field}: ${c.old} -> ${c.new}`));
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  // Auto-close any shows past their closing date
  console.log('\nChecking for shows past closing date...');
  const today = new Date().toISOString().split('T')[0];

  shows.forEach(show => {
    if (show.status === 'open' && show.closingDate && show.closingDate < today) {
      const existingUpdate = updates.find(u => u.slug === show.slug);
      if (existingUpdate) {
        if (!existingUpdate.changes.find(c => c.field === 'status')) {
          existingUpdate.changes.push({
            field: 'status',
            old: 'open',
            new: 'closed',
          });
        }
      } else {
        updates.push({
          slug: show.slug,
          changes: [{
            field: 'status',
            old: 'open',
            new: 'closed',
          }],
        });
      }
      console.log(`  ${show.title} closed on ${show.closingDate}`);
    }
  });

  console.log('\n============================');
  console.log(`Found ${updates.length} shows with updates\n`);

  if (updates.length === 0) {
    console.log('No updates needed. All shows are current.');
    return;
  }

  // Apply updates
  console.log('Applying updates to shows.json...\n');

  updates.forEach(update => {
    const showIndex = shows.findIndex(s => s.slug === update.slug);
    if (showIndex !== -1) {
      update.changes.forEach(change => {
        shows[showIndex][change.field] = change.new;
        console.log(`  Updated ${update.slug}.${change.field} = ${change.new}`);
      });
    }
  });

  // Update lastUpdated timestamp
  showsData._meta.lastUpdated = today;

  // Write back to file
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(showsData, null, 2));
  console.log('\nshows.json updated successfully!');

  // Generate summary
  console.log('\n============================');
  console.log('Summary of Changes:');
  console.log('============================');
  updates.forEach(u => {
    console.log(`\n${u.slug}:`);
    u.changes.forEach(c => console.log(`  - ${c.field}: ${c.old || 'null'} → ${c.new}`));
  });
}

// Also check for shows that should be marked as open (based on opening date)
function checkOpeningDates(shows) {
  const today = new Date().toISOString().split('T')[0];
  const updates = [];

  shows.forEach(show => {
    if (show.status === 'previews' && show.openingDate && show.openingDate <= today) {
      updates.push({
        slug: show.slug,
        changes: [{
          field: 'status',
          old: 'previews',
          new: 'open',
        }],
      });
    }
  });

  return updates;
}

main().catch(console.error);
