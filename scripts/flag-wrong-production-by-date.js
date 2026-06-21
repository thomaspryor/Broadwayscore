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
const { isWithinPriorRun } = require('./lib/wrong-production-autoclear');
const { evaluateDateGuard, evaluateDatelessRevivalGuard, earliestShowDate, DAYS_AFTER_CLOSE } = require('./lib/date-guard');

// Multi-production (revival) title index: a show id whose base title has ≥2
// productions in shows.json. Used by the dateless-revival guard below to decide
// whether a review LACKING any usable date should be held as suspect prior-
// production contamination. Same base-title normalization as rebuild-all-reviews.js.
function buildMultiProductionTitleIds(showMap) {
  const baseTitle = (t) => String(t || '').replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '').trim().toLowerCase();
  const groups = {};
  for (const s of Object.values(showMap)) {
    const base = baseTitle(s.title);
    if (!base) continue;
    (groups[base] = groups[base] || []).push(s.id);
  }
  const ids = new Set();
  for (const g of Object.values(groups)) if (g.length >= 2) g.forEach(id => ids.add(id));
  return ids;
}

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = !process.argv.includes('--apply');

// Grace periods are defined in scripts/lib/date-guard.js and exported for
// reuse here (DAYS_AFTER_CLOSE only — DAYS_BEFORE_PREVIEW + UK_* are scoped
// to the pure decision function). Single source of truth.

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
const { extractDateFromUrl } = require('./lib/rebuild-helpers');

function run() {
  const showMap = loadShows();

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()
  );

  const multiProductionTitleIds = buildMultiProductionTitleIds(showMap);

  let flaggedEarly = 0, flaggedLate = 0, skipped = 0, noDate = 0, noWindow = 0, ok = 0;
  let priorRunSkipped = 0, datelessRevivalFlagged = 0;
  let lockedSkipCount = 0;
  const flaggedDetails = [];

  for (const showDir of showDirs) {
    const show = showMap[showDir];
    if (!show) continue;

    // Determine date window
    const earliestStr = earliestShowDate(show);
    if (!earliestStr) { noWindow++; continue; }

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

      let pubDate = parseDate(data.publishDate);
      if (!pubDate && data.url) {
        // Same URL-date resolution the rebuild uses: extractDateFromUrl handles
        // /YYYY/MM/DD/, Guardian /YYYY/mon/DD/, compact YYYYMMDD and YYYY-MM-DD.
        // Require a FULL YYYY-MM-DD — a month-only/year-only date defaults to the
        // 1st and trips the window on genuine near-boundary reviews (Class B FPs).
        const urlDate = extractDateFromUrl(data.url);
        if (urlDate && urlDate.date && /^\d{4}-\d{2}-\d{2}$/.test(urlDate.date)) {
          const d = parseDate(urlDate.date);
          if (d && !isNaN(d.getTime())) pubDate = d;
        }
      }
      if (!pubDate) {
        // Dateless-revival guard: a review with no usable date on a multi-
        // production title that has NOT yet opened is held as suspect prior-
        // production contamination (mirrors rebuild-all-reviews.js).
        const verdict = evaluateDatelessRevivalGuard({
          hasUsableDate: false,
          isMultiProductionTitle: multiProductionTitleIds.has(showDir),
          show,
        });
        if (verdict.flag && data.humanReviewedWrongProduction !== false) {
          datelessRevivalFlagged++;
          flaggedDetails.push({ showId: showDir, title: show.title, file, date: '(none)', issue: 'dateless_revival', diffDays: 0, outlet: data.outlet || '?' });
          if (!DRY_RUN) {
            data.wrongProduction = true;
            data.wrongProductionReason = 'dateless-revival';
            data.wrongProductionNote = `Dateless revival guard: no publishDate on multi-production title that has not yet opened — unverified production (show starts ${earliestStr})`;
            const r = safeWriteReview(filePath, data);
            if (r.lockedSkipped) lockedSkipCount++;
          }
        } else {
          noDate++;
        }
        continue;
      }

      const decision = evaluateDateGuard({ pubDate, show, outletId: data.outletId });
      const issue = decision.issue;
      const diffDays = decision.diffDays;

      if (!issue) { ok++; continue; }

      // Production-continuity exemption: pubDate falls inside a declared priorRuns
      // window — legitimate coverage of an earlier run of THIS production.
      // Applies to both before_preview and after_close (a priorRun's reviews can
      // appear long after the current production's closing date too).
      if (isWithinPriorRun(pubDate, show.priorRuns)) {
        priorRunSkipped++;
        continue;
      }

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
        const tag = d.issue === 'before_preview' ? 'EARLY' : d.issue === 'dateless_revival' ? 'DATELESS' : 'LATE';
        console.log(`    ${tag} ${d.diffDays}d  ${d.outlet.padEnd(25)} ${d.date}`);
      });
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`OK (within window):    ${ok}`);
  console.log(`Skipped (priorRuns):   ${priorRunSkipped}`);
  console.log(`Already flagged:       ${skipped}`);
  console.log(`No publishDate:        ${noDate}`);
  console.log(`${DRY_RUN ? 'Would hold' : 'Held'} (dateless revival): ${datelessRevivalFlagged}`);
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
