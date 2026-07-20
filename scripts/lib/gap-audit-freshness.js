/**
 * gap-audit-freshness.js
 *
 * Checkpoint freshness + ordering policy for audit-show-review-gap.js.
 *
 * Why this exists (2026-07-14, The Whoopi Monologues incident): the hourly
 * gap-audit cron grinds a 3-year back-catalogue (~126 due targets) under an
 * 18-min budget, ordered least-recently-audited first. A show that opened
 * TODAY sat behind three days of backlog — its missing NYT review (cited by
 * the BWW roundup) was never auto-ingested. Opening-week shows are exactly
 * where reviews land hour-by-hour and where the score is publicly quoted,
 * so they must (a) re-audit on every hourly run and (b) sort ahead of the
 * back-catalogue grind.
 */

const { inOpeningWindow } = require('./gap-reference-sources');

// Shows opened within the last 7 days sort ahead of the back-catalogue grind.
const OPENING_PRIORITY_WINDOW_DAYS = 7;
// Tiered freshness bounds the hourly cost so a busy opening week can't invert
// the starvation and eat the whole budget: only shows opened in the last 2
// days (typically 0-4 shows, where reviews land hour-by-hour) re-audit every
// run; days 3-7 re-check every 3h (late reviews, corrections).
const OPENING_HOT_DAYS = 2;
// Just under the hourly cron interval so consecutive runs never skip.
const OPENING_WINDOW_FRESHNESS_MS = 55 * 60 * 1000;
const OPENING_WARM_FRESHNESS_MS = 3 * 60 * 60 * 1000;
// Talkin' Broadway (and occasionally others) publish up to 24h before the
// official opening (CLAUDE.md rule 14) — cover the eve-of-opening day too.
const PRE_OPENING_GRACE_MS = 24 * 60 * 60 * 1000;

function inOpeningPriorityWindow(show, now = Date.now()) {
  if (show?.status === 'closed') return false;
  if (inOpeningWindow(show, now, OPENING_PRIORITY_WINDOW_DAYS)) return true;
  const opening = Date.parse(show?.openingDate);
  return Number.isFinite(opening) && opening > now && (opening - now) <= PRE_OPENING_GRACE_MS;
}

// How long to skip a show after auditing it. Closed shows that came back clean
// rarely change, so they get a long skip (don't re-burn credits); open shows
// and shows with gaps are re-checked sooner so newly-published reviews are
// caught; opening-week shows re-check every run.
function freshnessMsFor(show, lastEntry, { freshnessHours = 12, now = Date.now() } = {}) {
  const closed = show && show.status === 'closed';
  // A closed show that audited clean won't get new reviews — re-check only yearly
  // (effectively one-time) so the back-catalogue grind doesn't burn credits forever.
  if (closed && lastEntry && lastEntry.gaps === 0) return 365 * 24 * 60 * 60 * 1000; // 365d
  if (closed) return 14 * 24 * 60 * 60 * 1000; // 14d — retry closed shows that still had gaps
  if (inOpeningPriorityWindow(show, now)) {
    return inOpeningWindow(show, now, OPENING_HOT_DAYS)
      ? OPENING_WINDOW_FRESHNESS_MS
      : OPENING_WARM_FRESHNESS_MS;
  }
  return freshnessHours * 60 * 60 * 1000; // open/previews — re-check often for new reviews
}

// Checkpoint timestamp for sorting. Malformed/missing `at` → 0 (treated as
// never-audited, i.e. maximum urgency) so a corrupt entry can't push a show
// to the back of the queue via NaN comparisons.
function checkpointTs(entry) {
  if (!entry || !entry.at) return 0;
  const t = new Date(entry.at).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Ordering for time-budgeted runs: opening-window shows first (reviews are
// landing NOW), then least-recently-audited so the back-catalogue still grinds.
function compareAuditPriority(a, b, checkpoint, now = Date.now()) {
  const wa = inOpeningPriorityWindow(a, now) ? 0 : 1;
  const wb = inOpeningPriorityWindow(b, now) ? 0 : 1;
  if (wa !== wb) return wa - wb;
  return checkpointTs(checkpoint[a.id]) - checkpointTs(checkpoint[b.id]); // oldest / never-audited first
}

module.exports = {
  freshnessMsFor,
  inOpeningPriorityWindow,
  compareAuditPriority,
  checkpointTs,
  OPENING_PRIORITY_WINDOW_DAYS,
  OPENING_HOT_DAYS,
  OPENING_WINDOW_FRESHNESS_MS,
  OPENING_WARM_FRESHNESS_MS,
};
