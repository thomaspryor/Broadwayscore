#!/usr/bin/env node
/**
 * Show Status Updater (Broadway, Off-Broadway, West End)
 *
 * Conservative status updates:
 * 1. Only marks shows as closed if closing date passed 7+ days ago
 *    (grace period allows time to catch extensions)
 * 2. Checks for previews → open transitions based on opening date
 * 3. Refreshes West End closing dates from TodayTix API (catches extensions)
 * 4. Does NOT make assumptions from ticket availability
 *
 * This is intentionally conservative to avoid false positives.
 * Closing dates should be discovered via check-closing-dates.js
 *
 * Usage: node scripts/update-show-status.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

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

// ── TodayTix API for West End date refresh ──

function fetchTodayTixPage(location, offset = 0, limit = 100) {
  const url = `https://api.todaytix.com/api/v2/shows?location=${location}&limit=${limit}&offset=${offset}`;
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix API HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('TodayTix JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function fetchAllTodayTixShows(location) {
  const allShows = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const result = await fetchTodayTixPage(location, offset, limit);
    const shows = result.data || [];
    allShows.push(...shows);
    if (shows.length < limit) break;
    offset += limit;
  }
  return allShows;
}

/**
 * Refresh closing dates for West End (and optionally Broadway/OB) shows
 * from TodayTix API. Detects extensions when TodayTix endDate > our closingDate.
 */
async function refreshTodayTixDates(data, updates) {
  console.log('\n--- TodayTix Date Refresh ---');

  // Build a map of our open/previews shows by todaytixId and by normalized title
  const activeShows = data.shows.filter(s =>
    (s.status === 'open' || s.status === 'previews') &&
    (s.category === 'west-end' || s.category === 'broadway' || s.category === 'off-broadway')
  );

  const byTodayTixId = {};
  const byTitle = {};
  for (const show of activeShows) {
    if (show.todaytixId) byTodayTixId[show.todaytixId] = show;
    const normTitle = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normTitle) byTitle[normTitle] = show;
  }

  // Fetch from TodayTix: location=2 (London) for WE, location=1 (NYC) for Broadway/OB
  const locations = [
    { id: 2, label: 'London (West End)', categories: new Set(['west-end']) },
    { id: 1, label: 'NYC (Broadway/OB)', categories: new Set(['broadway', 'off-broadway']) },
  ];

  let dateUpdates = 0;

  for (const loc of locations) {
    try {
      const ttShows = await fetchAllTodayTixShows(loc.id);
      console.log(`  TodayTix ${loc.label}: ${ttShows.length} shows`);

      for (const ttShow of ttShows) {
        const ttEndDate = ttShow.endDate === 'null' ? null : ttShow.endDate || null;
        if (!ttEndDate) continue; // Open-ended run, skip

        // Match by todaytixId first, then by title
        const normTtTitle = (ttShow.displayName || ttShow.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const match = byTodayTixId[ttShow.id] || byTitle[normTtTitle];
        if (!match) continue;
        if (!loc.categories.has(match.category)) continue;

        // Compare dates: only update if TodayTix date is LATER (extension)
        if (match.closingDate && ttEndDate > match.closingDate) {
          const oldDate = match.closingDate;
          console.log(`  📅 ${match.title}: closing date extended ${oldDate} → ${ttEndDate}`);
          if (!dryRun) {
            match.closingDate = ttEndDate;
          }
          updates.push({
            id: match.id,
            title: match.title,
            changes: {
              closingDate: { from: oldDate, to: ttEndDate },
              note: `Extension detected via TodayTix (${loc.label})`
            }
          });
          dateUpdates++;
        }

        // Also set closingDate if we had none and TodayTix has one
        if (!match.closingDate && ttEndDate) {
          console.log(`  📅 ${match.title}: closing date added ${ttEndDate} (was unknown)`);
          if (!dryRun) {
            match.closingDate = ttEndDate;
          }
          updates.push({
            id: match.id,
            title: match.title,
            changes: {
              closingDate: { from: 'none', to: ttEndDate },
              note: `Closing date discovered via TodayTix (${loc.label})`
            }
          });
          dateUpdates++;
        }
      }
    } catch (err) {
      console.error(`  ⚠️  TodayTix ${loc.label} fetch failed (non-fatal): ${err.message}`);
    }
  }

  console.log(`  TodayTix date updates: ${dateUpdates}`);
  return dateUpdates;
}

async function updateShowStatuses() {
  console.log('='.repeat(60));
  console.log('SHOW STATUS UPDATER');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();
  const updates = [];

  // Refresh closing dates from TodayTix BEFORE status checks
  // so extensions are detected before the closing-grace-period logic runs
  await refreshTodayTixDates(data, updates);

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
        if (typeof change === 'string') {
          console.log(`  ${field}: ${change}`);
        } else {
          console.log(`  ${field}: ${change.from} → ${change.to}`);
        }
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
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `updates_count=${updates.length}\n`);
    fs.appendFileSync(outputFile, `updated_shows=${updates.map(u => u.title).join(', ')}\n`);

    // Separate output for shows transitioning previews→open (for downstream triggers)
    const openedShows = updates.filter(u => u.changes.status?.from === 'previews' && u.changes.status?.to === 'open');
    fs.appendFileSync(outputFile, `opened_count=${openedShows.length}\n`);
    fs.appendFileSync(outputFile, `opened_slugs=${openedShows.map(u => u.id).join(',')}\n`);

    // TodayTix date refresh results
    const dateUpdates = updates.filter(u => u.changes.closingDate);
    fs.appendFileSync(outputFile, `date_updates_count=${dateUpdates.length}\n`);
  }

  return updates;
}

updateShowStatuses().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
