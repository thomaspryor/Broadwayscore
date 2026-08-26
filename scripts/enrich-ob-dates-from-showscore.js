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
const { fetchPage, cleanup } = require('./lib/scraper');
const { extractStatusFromHtml } = require('./lib/show-score-status');
const { writeClosingDate, canWriteClosingDate } = require('./lib/closing-date-guard');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { sanitizeVenueForWrite } = require('./lib/venue-classification');
const { isPlaceholderVenue } = require('./audit-placeholder-venues');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-ob-dates-from-showscore.js — One-time enrichment of OB show dates/statuses from ShowScore.

Usage:
  node scripts/enrich-ob-dates-from-showscore.js [options]
  node scripts/enrich-ob-dates-from-showscore.js --help, -h    print this usage and exit
`;
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const URLS_PATH = path.join(__dirname, '..', 'data', 'show-score-urls.json');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'show-score');
const dryRun = process.argv.includes('--dry-run');

/**
 * Decide whether/what to update an OB show's venue to from ShowScore data.
 * Mirrors enrich-west-end-shows.js's decideVenueUpdate. `ssData.venue` comes
 * from extractStatusFromHtml() parsing ShowScore's `.show-page-v2__info-top-line`
 * element — the exact source venue-classification.js's sanitizeVenueForWrite
 * doc comment cites as the cause of the original 63-show neighbourhood-blob
 * contamination that motivated card #994. This write site was found skipping
 * the guard by ship-check adversarial review (card #1922, cousin of #1921).
 */
function decideOBVenueUpdate(currentVenue, rawSsVenue) {
  if (!rawSsVenue) return { venue: null, reason: null };
  // Canonical placeholder check (audit-placeholder-venues.js) rather than a
  // hardcoded "TBA" literal, so a current venue of "TBD"/"N/A"/a
  // neighbourhood blob is also eligible for replacement.
  if (!isPlaceholderVenue(currentVenue).placeholder) return { venue: null, reason: null };
  const sanitized = sanitizeVenueForWrite(rawSsVenue);
  if (!sanitized) {
    return { venue: null, reason: `venue "${rawSsVenue}" failed sanitizeVenueForWrite (placeholder/neighbourhood blob)` };
  }
  return { venue: sanitized, reason: null };
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const showsData = loadShows();
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
    if (ssData.closingDate && !show.closingDate && canWriteClosingDate(show)) {
      changes.push(`closingDate: null → ${ssData.closingDate}`);
      if (!dryRun) writeClosingDate(show, ssData.closingDate, 'ShowScore "Ends" date (OB enrichment)');
      dateCorrections++;
    }

    // Venue (only if currently TBA)
    const venueDecision = decideOBVenueUpdate(show.venue, ssData.venue);
    if (venueDecision.venue) {
      changes.push(`venue: ${show.venue || 'null'} → ${venueDecision.venue}`);
      if (!dryRun) show.venue = venueDecision.venue;
      venueUpdates++;
    } else if (venueDecision.reason) {
      console.log(`  ⚠️  ${show.id}: ${venueDecision.reason} — not written`);
    }

    if (changes.length > 0) {
      console.log(`  ✓ ${show.id}: ${changes.join(', ')} [SS: "${ssData.raw}"]`);
    }
  }

  if (!dryRun && (statusChanges > 0 || dateCorrections > 0 || venueUpdates > 0)) {
    saveShows(showsData);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Status changes: ${statusChanges} | Date corrections: ${dateCorrections} | Venue updates: ${venueUpdates} | Errors: ${errors}`);
  if (dryRun) console.log('(DRY RUN — no changes written)');

  await cleanup();
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { decideOBVenueUpdate };
