#!/usr/bin/env node
'use strict';

/**
 * BRO-91 follow-up — full-corpus late-add sweep.
 *
 * scripts/audit-opening-night-coverage.js already calls detectLateAdd(), but
 * only over `target` = shows that are open, opened within the ledger window,
 * or have fresh review evidence (see writeLedger()'s `target` filter). That
 * means every CLOSED, out-of-window show in the corpus is invisible to the
 * production late-add signal. This script runs detectLateAdd() over the
 * FULL shows.json corpus (no window) so historical late-adds -- the class
 * BRO-91's evidence run surfaced (old Broadway revivals, West End
 * transfers) -- are enumerable on demand, not just discoverable via a
 * throwaway one-liner.
 *
 * Read-only: writes a JSON snapshot for triage, makes no data changes.
 */

const fs = require('fs');
const path = require('path');
const { detectLateAdd, GRACE_DAYS } = require('./lib/late-add-detector.js');

function main() {
  const dataDir = path.join(__dirname, '..', 'data');
  const shows = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8')).shows;
  const reviews = Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8')).reviews);

  const reviewsByShow = new Map();
  for (const r of reviews) {
    if (!reviewsByShow.has(r.showId)) reviewsByShow.set(r.showId, []);
    reviewsByShow.get(r.showId).push(r);
  }

  // Tally reasons for NOT flagging too -- a low flaggedCount is ambiguous
  // otherwise: "checked, clean" and "couldn't check" both collapse into the
  // same number without this (ship-check finding).
  const skipReasons = { 'no-catalog-clock': 0, 'no-measurable-reviews': 0 };
  const flagged = [];
  for (const show of shows) {
    const catalogClock = show.previewsStartDate || show.openingDate || null;
    const r = detectLateAdd(reviewsByShow.get(show.id) || [], catalogClock);
    if (!r.isLateAdd) {
      if (r.reason && Object.prototype.hasOwnProperty.call(skipReasons, r.reason)) skipReasons[r.reason] += 1;
      continue;
    }
    flagged.push({
      showId: show.id,
      title: show.title,
      market: show.market || null,
      category: show.category || null,
      gapDays: r.gapDays,
      earliestReviewDate: r.earliestReviewDate,
      earliestOutletId: r.earliestOutletId,
      catalogClock: r.catalogClock,
      hasPriorRuns: !!show.priorRuns,
      hasTransferOf: !!show.transferOf,
    });
  }
  flagged.sort((a, b) => b.gapDays - a.gapDays);

  const needsReview = flagged.filter((f) => !f.hasPriorRuns && !f.hasTransferOf);
  const out = {
    generatedAt: new Date().toISOString(),
    graceDays: GRACE_DAYS,
    totalShows: shows.length,
    flaggedCount: flagged.length,
    needsReviewCount: needsReview.length,
    skippedNoCatalogClockCount: skipReasons['no-catalog-clock'],
    skippedNoMeasurableReviewsCount: skipReasons['no-measurable-reviews'],
    flagged,
  };

  const outPath = path.join(dataDir, 'audit', 'late-add-corpus-sweep.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

  console.log(`late-add corpus sweep: ${flagged.length}/${shows.length} shows flagged (>${GRACE_DAYS}d gap), ${needsReview.length} with neither priorRuns nor transferOf`);
  console.log(`  skipped (no catalog clock): ${skipReasons['no-catalog-clock']}, skipped (no measurable reviews): ${skipReasons['no-measurable-reviews']}`);
  console.log(`written: ${path.relative(process.cwd(), outPath)}`);
}

if (require.main === module) main();

module.exports = { main };
