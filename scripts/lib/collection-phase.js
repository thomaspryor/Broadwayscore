'use strict';

/**
 * collection-phase.js (BRO-4770) — is a show still in its review-collection
 * phase? Used by scripts/audit-show-review-gap.js to decide which shows get the
 * (fetch-heavy) roundup-gap check. A fixed "opened in the last N days" window
 * dropped a show the moment day N passed, even when a late review landed on
 * day N+1. Here a show stays in scope while it is inside its opening window OR
 * any review file for it was first seen within `quietDays`; a late review
 * therefore re-enters the show automatically.
 */

const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const DEFAULT_QUIET_DAYS = 10;

/**
 * Newest firstSeenAt (ms) across a show's review files, 0 when none. Reads each
 * file's JSON, so callers only use it for shows already past the opening window.
 */
function lastNewReviewAt(showDir) {
  let newest = 0;
  let names;
  try { names = fs.readdirSync(showDir); } catch { return 0; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(showDir, n), 'utf8')); } catch { continue; }
    const t = Date.parse((d && (d.firstSeenAt || d.textFetchedAt)) || '');
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

/**
 * @param {number} lastReviewMs  newest first-seen time of any review (0 = none)
 * @param {number} [now]
 * @param {number} [quietDays]
 */
function hasRecentReviewActivity(lastReviewMs, now = Date.now(), quietDays = DEFAULT_QUIET_DAYS) {
  return lastReviewMs > 0 && now - lastReviewMs <= quietDays * DAY;
}

module.exports = { lastNewReviewAt, hasRecentReviewActivity, DEFAULT_QUIET_DAYS };
