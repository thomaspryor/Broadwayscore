#!/usr/bin/env node
/**
 * check-show-freshness.js
 *
 * Daily freshness check for Broadway show data:
 * 1. Marks shows as "closed" if their closingDate has passed
 * 2. Reports shows that need status review
 * 3. Can be run via GitHub Actions daily
 *
 * Usage: node scripts/check-show-freshness.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const dryRun = process.argv.includes('--dry-run');

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function isDatePassed(dateStr) {
  if (!dateStr) return false;
  const closeDate = new Date(dateStr);
  const today = new Date();
  // Compare dates only (not time)
  today.setHours(0, 0, 0, 0);
  closeDate.setHours(0, 0, 0, 0);
  return closeDate < today;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const closeDate = new Date(dateStr);
  const today = new Date();
  const diffTime = closeDate.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function checkFreshness() {
  console.log('='.repeat(60));
  console.log('BROADWAY SHOW FRESHNESS CHECK');
  console.log('='.repeat(60));
  console.log(`Date: ${new Date().toISOString().split('T')[0]}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log('');

  const data = loadShows();
  const openShows = data.shows.filter(s => s.status === 'open');

  const results = {
    autoClosedShows: [],
    closingSoon: [],
    noClosingDate: [],
    unchanged: [],
  };

  for (const show of openShows) {
    // Check if closing date has passed
    if (show.closingDate && isDatePassed(show.closingDate)) {
      results.autoClosedShows.push({
        id: show.id,
        title: show.title,
        closingDate: show.closingDate,
      });

      if (!dryRun) {
        show.status = 'closed';
      }
    }
    // Check if closing within 14 days
    else if (show.closingDate) {
      const days = daysUntil(show.closingDate);
      if (days !== null && days <= 14 && days > 0) {
        results.closingSoon.push({
          id: show.id,
          title: show.title,
          closingDate: show.closingDate,
          daysLeft: days,
        });
      } else {
        results.unchanged.push(show.id);
      }
    }
    // No closing date
    else {
      results.noClosingDate.push({
        id: show.id,
        title: show.title,
      });
    }
  }

  // Report results
  if (results.autoClosedShows.length > 0) {
    console.log('AUTO-CLOSED (closing date passed):');
    console.log('-'.repeat(40));
    for (const show of results.autoClosedShows) {
      console.log(`  - ${show.title} (closed ${show.closingDate})`);
    }
    console.log('');
  }

  if (results.closingSoon.length > 0) {
    console.log('CLOSING SOON (within 14 days):');
    console.log('-'.repeat(40));
    for (const show of results.closingSoon) {
      console.log(`  - ${show.title}: ${show.daysLeft} days (${show.closingDate})`);
    }
    console.log('');
  }

  if (results.noClosingDate.length > 0) {
    console.log('NO CLOSING DATE (open-ended runs):');
    console.log('-'.repeat(40));
    for (const show of results.noClosingDate) {
      console.log(`  - ${show.title}`);
    }
    console.log('');
  }

  // Save if changes made
  if (!dryRun && results.autoClosedShows.length > 0) {
    saveShows(data);
    console.log(`Saved ${results.autoClosedShows.length} status updates to shows.json`);
  }

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total open shows: ${openShows.length}`);
  console.log(`Auto-closed: ${results.autoClosedShows.length}`);
  console.log(`Closing soon: ${results.closingSoon.length}`);
  console.log(`No closing date: ${results.noClosingDate.length}`);
  console.log(`Unchanged: ${results.unchanged.length}`);

  // Exit with error if changes were made (useful for CI to trigger commits)
  if (results.autoClosedShows.length > 0 && !dryRun) {
    // Output for GitHub Actions
    console.log('');
    console.log('::set-output name=changes_made::true');
    console.log(`::set-output name=closed_count::${results.autoClosedShows.length}`);
    console.log(`::set-output name=closed_shows::${results.autoClosedShows.map(s => s.title).join(', ')}`);
  }

  return results;
}

// Run
checkFreshness();
