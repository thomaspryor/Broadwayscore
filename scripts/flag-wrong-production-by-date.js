#!/usr/bin/env node
/**
 * Flag reviews as wrongProduction when publishDate falls outside
 * the show's date window: [previewStart - 14 days, closingDate + 7 days].
 *
 * This catches reviews of earlier/later productions that were incorrectly
 * linked to the wrong showId by aggregator sources.
 *
 * Safe to re-run — skips files already flagged wrongProduction/wrongShow/manualClear.
 * Run after adding new publishDates (e.g., backfill-url-dates.js) to catch more.
 *
 * Usage:
 *   node scripts/flag-wrong-production-by-date.js              # dry run
 *   node scripts/flag-wrong-production-by-date.js --apply      # write flags
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = !process.argv.includes('--apply');

// Grace periods — 21d before preview catches press nights (esp. London);
// 7d after close allows closing-night retrospectives
const DAYS_BEFORE_PREVIEW = 21;
const DAYS_AFTER_CLOSE = 7;

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows || data;
  const map = {};
  for (const show of Object.values(shows)) {
    map[show.id] = show;
  }
  return map;
}

const { parseDate } = require('./lib/date-utils');

function run() {
  const showMap = loadShows();

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()
  );

  let flaggedEarly = 0, flaggedLate = 0, skipped = 0, noDate = 0, noWindow = 0, ok = 0;
  let lockedSkipCount = 0;
  const flaggedDetails = [];

  for (const showDir of showDirs) {
    const show = showMap[showDir];
    if (!show) continue;

    // Determine date window
    const earliestStr = show.previewDate || show.previewsStartDate || show.openingDate;
    if (!earliestStr) { noWindow++; continue; }

    const windowStart = new Date(earliestStr);
    windowStart.setDate(windowStart.getDate() - DAYS_BEFORE_PREVIEW);

    let windowEnd = null;
    if (show.closingDate) {
      windowEnd = new Date(show.closingDate);
      windowEnd.setDate(windowEnd.getDate() + DAYS_AFTER_CLOSE);
    }

    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      // Skip already-flagged
      if (data.wrongProduction || data.wrongShow || data.wrongProductionManualClear || data.allowEarlyDate) {
        skipped++;
        continue;
      }

      const pubDate = parseDate(data.publishDate);
      if (!pubDate) { noDate++; continue; }

      let issue = null;
      let diffDays = 0;

      if (pubDate < windowStart) {
        diffDays = Math.round((windowStart - pubDate) / 86400000);
        issue = 'before_preview';
      } else if (windowEnd && pubDate > windowEnd) {
        diffDays = Math.round((pubDate - windowEnd) / 86400000);
        issue = 'after_close';
      }

      if (!issue) { ok++; continue; }

      const note = issue === 'before_preview'
        ? `Date guard: review ${data.publishDate} is ${diffDays}d before ${earliestStr} (preview/open) — likely different production`
        : `Date guard: review ${data.publishDate} is ${diffDays}d after ${show.closingDate} (close+${DAYS_AFTER_CLOSE}d) — likely different production`;

      if (issue === 'before_preview') flaggedEarly++;
      else flaggedLate++;

      flaggedDetails.push({
        showId: showDir,
        title: show.title,
        file,
        date: data.publishDate,
        issue,
        diffDays,
        outlet: data.outlet,
      });

      if (!DRY_RUN) {
        data.wrongProduction = true;
        data.wrongProductionNote = note;
        const result = safeWriteReview(filePath, data);
        if (result.lockedSkipped) lockedSkipCount++;
      }
    }
  }

  // Print flagged reviews grouped by show
  if (flaggedDetails.length > 0) {
    const byShow = {};
    flaggedDetails.forEach(d => {
      byShow[d.showId] = byShow[d.showId] || { title: d.title, items: [] };
      byShow[d.showId].items.push(d);
    });

    const sorted = Object.entries(byShow).sort((a, b) => b[1].items.length - a[1].items.length);
    console.log(`\n--- ${DRY_RUN ? 'Would flag' : 'Flagged'} ---`);
    for (const [showId, { title, items }] of sorted.slice(0, 30)) {
      console.log(`\n  ${title} (${showId}): ${items.length} reviews`);
      items.slice(0, 5).forEach(d => {
        const tag = d.issue === 'before_preview' ? 'EARLY' : 'LATE';
        console.log(`    ${tag} ${d.diffDays}d  ${d.outlet.padEnd(25)} ${d.date}`);
      });
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`OK (within window):    ${ok}`);
  console.log(`Already flagged:       ${skipped}`);
  console.log(`No publishDate:        ${noDate}`);
  console.log(`No show date window:   ${noWindow}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} (early): ${flaggedEarly}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} (late):  ${flaggedLate}`);
  console.log(`${DRY_RUN ? 'Would flag' : 'Flagged'} total:   ${flaggedEarly + flaggedLate}`);
  console.log(`[LOCKED-SKIP-COUNT] flag-wrong-production-by-date: ${lockedSkipCount}`);
  if (DRY_RUN && (flaggedEarly + flaggedLate) > 0) {
    console.log(`\nRun with --apply to write flags.`);
  }
}

run();
