'use strict';
/**
 * Lane rows a rebuild must keep although the show is not (or no longer) leased (2026-11-17).
 *
 * The opening-night lane writes its reviews straight into reviews.json and pushes their texts to review-texts only
 * when its job ends. A rebuild rebuilds a show from review-texts, so between "the lease is not visible" (a workflow
 * that never synced, a failed sync, or the watchdog releasing the lease before the lane job pushed) and "the texts
 * arrived", every rebuild dropped the lane's rows: the-fantasticks-2026 went from 20 live reviews to 0 on its press
 * night. A lane row is kept while review-texts holds no file for its outlet in that show yet, for at most
 * MAX_AGE_DAYS after the lane saw it (texts that never arrive must not pin a row forever).
 */
const fs = require('fs');
const path = require('path');
const { isLaneReview } = require('./trust-model');

const MAX_AGE_DAYS = 7;

/** Outlet ids that have a review-text file in `showDir` (files are `<outletId>--<critic>.json`). */
function outletsWithTexts(showDir) {
  let files = [];
  try { files = fs.readdirSync(showDir); } catch { return new Set(); }
  return new Set(files.filter((f) => f.endsWith('.json') && f.includes('--')).map((f) => f.split('--')[0]));
}

/**
 * existing: rows of the current reviews.json. rebuilt: rows this rebuild produced so far.
 * Returns the existing lane rows to carry: not leased (those are carried already), seen by the lane within
 * MAX_AGE_DAYS, no rebuilt row for the same show+outlet, and no review-text file for that outlet yet.
 */
function orphanLaneRows(existing, rebuilt, { leased = new Set(), reviewTextsDir, now = Date.now() } = {}) {
  const have = new Set((rebuilt || []).map((r) => `${r.showId}|${r.outletId}`));
  const texts = new Map();
  const textsFor = (showId) => {
    if (!texts.has(showId)) texts.set(showId, outletsWithTexts(path.join(reviewTextsDir, showId)));
    return texts.get(showId);
  };
  return (existing || []).filter((r) => {
    if (!r || !r.showId || !r.outletId || leased.has(r.showId) || !isLaneReview(r)) return false;
    const seen = Date.parse(r.openingNightLane.seenAt);
    if (!(now - seen <= MAX_AGE_DAYS * 86400e3)) return false;
    if (have.has(`${r.showId}|${r.outletId}`)) return false;
    return !textsFor(r.showId).has(r.outletId);
  });
}

module.exports = { orphanLaneRows, outletsWithTexts, MAX_AGE_DAYS };
