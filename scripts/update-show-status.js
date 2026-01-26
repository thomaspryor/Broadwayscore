#!/usr/bin/env node
/**
 * Broadway Show Status Updater
 *
 * Conservative status updates:
 * 1. Only marks shows as closed if closing date passed 7+ days ago
 *    (grace period allows time to catch extensions)
 * 2. Checks for previews → open transitions based on opening date
 * 3. Does NOT make assumptions from ticket availability
 *
 * This is intentionally conservative to avoid false positives.
 * Closing dates should be discovered via check-closing-dates.js
 *
 * Usage: node scripts/update-show-status.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const dryRun = process.argv.includes('--dry-run');

// Grace period in days - don't auto-close until this many days after closing date
// This gives time for the check-closing-dates script to catch extensions
const CLOSING_GRACE_PERIOD_DAYS = 7;

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function isDatePassed(dateStr) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date < today;
}

function isDatePassedByDays(dateStr, days) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  const threshold = new Date();
  threshold.setHours(0, 0, 0, 0);
  threshold.setDate(threshold.getDate() - days);
  date.setHours(0, 0, 0, 0);
  return date < threshold;
}

function isDateReached(dateStr) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date <= today;
}

function updateShowStatuses() {
  console.log('='.repeat(60));
  console.log('BROADWAY SHOW STATUS UPDATER');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();
  const updates = [];

  for (const show of data.shows) {
    const changes = {};

    // Check 1: Close shows whose closing date has passed (with grace period)
    // Grace period gives check-closing-dates.js time to catch extensions
    if (show.status === 'open' && show.closingDate && isDatePassedByDays(show.closingDate, CLOSING_GRACE_PERIOD_DAYS)) {
      changes.status = { from: 'open', to: 'closed' };
      changes.note = `Closing date ${show.closingDate} passed ${CLOSING_GRACE_PERIOD_DAYS}+ days ago`;
      if (!dryRun) {
        show.status = 'closed';
      }
    }

    // Flag shows approaching closing (but don't change status)
    if (show.status === 'open' && show.closingDate && isDatePassed(show.closingDate) && !isDatePassedByDays(show.closingDate, CLOSING_GRACE_PERIOD_DAYS)) {
      console.log(`  ⚠️  ${show.title}: closing date ${show.closingDate} passed - in grace period (check for extension)`);
    }

    // Check 2: Move previews to open if opening date has passed
    if (show.status === 'previews' && show.openingDate && isDateReached(show.openingDate)) {
      changes.status = { from: 'previews', to: 'open' };
      if (!dryRun) {
        show.status = 'open';
      }
    }

    // Check 3: Flag shows that might need attention (but don't change them)
    if (show.status === 'open' && !show.closingDate) {
      // These are open-ended runs - no action needed
    }

    if (Object.keys(changes).length > 0) {
      updates.push({
        id: show.id,
        title: show.title,
        changes: changes,
      });
    }
  }

  // Report results
  if (updates.length === 0) {
    console.log('✅ All show statuses are up to date');
    console.log('');
    console.log('No changes needed.');
  } else {
    console.log(`Found ${updates.length} status update(s):`);
    console.log('-'.repeat(40));

    for (const update of updates) {
      console.log(`\n${update.title}:`);
      for (const [field, change] of Object.entries(update.changes)) {
        console.log(`  ${field}: ${change.from} → ${change.to}`);
      }
    }

    if (!dryRun) {
      saveShows(data);
      console.log('');
      console.log('✅ shows.json updated successfully');
    }
  }

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const openShows = data.shows.filter(s => s.status === 'open');
  const closedShows = data.shows.filter(s => s.status === 'closed');
  const previewShows = data.shows.filter(s => s.status === 'previews');

  console.log(`Open: ${openShows.length}`);
  console.log(`Closed: ${closedShows.length}`);
  console.log(`Previews: ${previewShows.length}`);
  console.log(`Updates applied: ${updates.length}`);

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT && updates.length > 0) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `updates_count=${updates.length}\n`);
    fs.appendFileSync(outputFile, `updated_shows=${updates.map(u => u.title).join(', ')}\n`);
  }

  return updates;
}

updateShowStatuses();
