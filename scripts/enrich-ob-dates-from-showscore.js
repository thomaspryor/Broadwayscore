#!/usr/bin/env node
/**
 * enrich-ob-dates-from-showscore.js — One-time enrichment of OB show dates/statuses from ShowScore
 *
 * Checks ShowScore pages for OB shows and corrects:
 * - "previews" shows that ShowScore says are "Open run" → status: open
 * - "previews" shows where ShowScore has "Opens MMM DD" → set real opening date
 * - "open" shows that ShowScore says are "Closed" → status: closed
 *
 * Usage: node scripts/enrich-ob-dates-from-showscore.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { fetchPage, cleanup } = require('./lib/scraper');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const URLS_PATH = path.join(__dirname, '..', 'data', 'show-score-urls.json');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'show-score');
const dryRun = process.argv.includes('--dry-run');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseShortDate(text) {
  const match = text.match(/([A-Za-z]+)\s+(\d+)/);
  if (!match) return null;
  const monthStr = match[1].toLowerCase().slice(0, 3);
  const num = parseInt(match[2]);
  const month = MONTHS[monthStr];
  if (month === undefined) return null;
  const currentYear = new Date().getFullYear();
  if (num > 31) {
    const lastDay = new Date(num, month + 1, 0).getDate();
    return `${num}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  }
  let year = currentYear;
  const now = new Date();
  const candidate = new Date(year, month, num);
  if (candidate < new Date(now.getFullYear(), now.getMonth() - 3, 1)) {
    year++;
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(num).padStart(2, '0')}`;
}

function extractStatusFromHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const topLine = doc.querySelector('.show-page-v2__info-top-line');
  if (!topLine) return null;

  const statusText = topLine.childNodes[0]?.textContent?.trim() || '';
  if (!statusText) return null;

  // Extract venue
  const venueLink = topLine.querySelector('a');
  const venueFull = venueLink?.textContent?.trim() || '';
  const venue = venueFull.replace(/^(NYC|London|Chicago|LA):\s*/i, '').trim() || null;

  let ssStatus = null;
  let openingDate = null;
  let closingDate = null;

  if (statusText.startsWith('Opens ')) {
    ssStatus = 'previews';
    openingDate = parseShortDate(statusText.replace('Opens ', ''));
  } else if (statusText === 'Open run') {
    ssStatus = 'open';
  } else if (statusText.startsWith('Ends ')) {
    ssStatus = 'open';
    closingDate = parseShortDate(statusText.replace('Ends ', ''));
  } else if (statusText === 'Closed') {
    ssStatus = 'closed';
  }

  return { ssStatus, openingDate, closingDate, venue, raw: statusText };
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const urlsData = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
  const urls = urlsData.shows || {};

  const obShows = showsData.shows.filter(s =>
    s.category === 'off-broadway' &&
    (s.status === 'previews' || s.status === 'open') &&
    urls[s.id]
  );

  console.log(`Checking ${obShows.length} OB shows (${obShows.filter(s => s.status === 'previews').length} previews, ${obShows.filter(s => s.status === 'open').length} open) against ShowScore...`);

  let statusChanges = 0;
  let dateCorrections = 0;
  let venueUpdates = 0;
  let errors = 0;

  for (const show of obShows) {
    const url = urls[show.id];
    const archivePath = path.join(ARCHIVE_DIR, `${show.id}.html`);

    let html = null;

    // Try archived HTML first
    if (fs.existsSync(archivePath)) {
      html = fs.readFileSync(archivePath, 'utf8');
    } else {
      // Fetch from ShowScore
      try {
        const result = await fetchPage(url);
        if (result && result.content) {
          html = result.content;
          // Save to archive
          const header = `<!--\n  Archived: ${new Date().toISOString()}\n  Source: ${url}\n  Status: 200\n-->\n`;
          fs.writeFileSync(archivePath, header + html);
        }
        await new Promise(r => setTimeout(r, 800)); // Rate limit
      } catch (e) {
        console.log(`  ❌ ${show.id}: fetch failed — ${e.message}`);
        errors++;
        continue;
      }
    }

    if (!html) {
      errors++;
      continue;
    }

    const ssData = extractStatusFromHtml(html);
    if (!ssData || !ssData.ssStatus) {
      console.log(`  ⚠️  ${show.id}: could not extract status from ShowScore`);
      continue;
    }

    const changes = [];

    // Status correction
    if (show.status === 'previews' && ssData.ssStatus === 'open') {
      changes.push(`status: previews → open`);
      if (!dryRun) show.status = 'open';
      statusChanges++;
    } else if (show.status === 'open' && ssData.ssStatus === 'closed') {
      changes.push(`status: open → closed`);
      if (!dryRun) show.status = 'closed';
      statusChanges++;
    } else if (show.status === 'open' && ssData.ssStatus === 'previews') {
      // ShowScore says still in previews but we have it as open — correct to previews
      changes.push(`status: open → previews`);
      if (!dryRun) show.status = 'previews';
      statusChanges++;
    }

    // Opening date from ShowScore "Opens" date
    if (ssData.openingDate && show.status === 'previews') {
      const currentOpening = show.openingDate;
      if (!currentOpening || currentOpening !== ssData.openingDate) {
        changes.push(`openingDate: ${currentOpening || 'null'} → ${ssData.openingDate}`);
        if (!dryRun) show.openingDate = ssData.openingDate;
        dateCorrections++;
      }
    }

    // Closing date
    if (ssData.closingDate && !show.closingDate) {
      changes.push(`closingDate: null → ${ssData.closingDate}`);
      if (!dryRun) show.closingDate = ssData.closingDate;
      dateCorrections++;
    }

    // Venue (only if currently TBA)
    if (ssData.venue && (!show.venue || show.venue === 'TBA')) {
      changes.push(`venue: ${show.venue || 'null'} → ${ssData.venue}`);
      if (!dryRun) show.venue = ssData.venue;
      venueUpdates++;
    }

    if (changes.length > 0) {
      console.log(`  ✓ ${show.id}: ${changes.join(', ')} [SS: "${ssData.raw}"]`);
    }
  }

  if (!dryRun && (statusChanges > 0 || dateCorrections > 0 || venueUpdates > 0)) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Status changes: ${statusChanges} | Date corrections: ${dateCorrections} | Venue updates: ${venueUpdates} | Errors: ${errors}`);
  if (dryRun) console.log('(DRY RUN — no changes written)');

  await cleanup();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
