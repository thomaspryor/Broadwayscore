'use strict';

/**
 * missed-broadcasts.js — finds shows whose opening-night broadcast silently
 * never happened, AFTER the broadcast pipeline has already stopped looking at
 * them.
 *
 * WHY THIS EXISTS (electra-persona-west-end-2026, 2026-09-01):
 * .github/workflows/opening-night-broadcast.yml only considers shows inside a
 * 2-day lookback window (its `find` step, `LOOKBACK=${{ inputs.lookback_days
 * || 2 }}`). That show qualified on review count but its checklist gate found
 * QA errors on every run, so the send was blocked; ~2 days later it left the
 * window and the pipeline stopped considering it entirely. No broadcast, and —
 * because the overdue pager is itself gated on `pending_shows != ''` — no
 * alert either. The owner found out a week later, by noticing that a DIFFERENT
 * show's email had arrived and this one's never had.
 *
 * WHY THE PREDICATE IS DURABLE, NOT EDGE-TRIGGERED:
 * the obvious fix — "page on the show's final day in the window" — was
 * reviewed and rejected. It only fires if a workflow run happens to land on
 * that specific day AND gets past the time gate (runs before 11:00 UTC are
 * skipped) AND past the readiness gate AND past the overdue step's own 24h
 * per-show dedup, which filters the show out before any escalation branch can
 * run (opening-night-broadcast.yml:851, hasRecentOverdueAlert). Four separate
 * ways to silently miss the one moment that mattered. This predicate is true
 * every day until the condition is resolved, so it cannot be missed by not
 * being asked on the right day.
 *
 * Pure — no I/O, no clock of its own. scripts/check-missed-broadcasts.js does
 * the file reads and the alert routing (CLAUDE.md §15).
 */

const { migrateSentRecord } = require('./broadcast-state');

// Only these two ever broadcast — mirrors the category allowlist in
// opening-night-broadcast.yml's `find` step and findRecentlyOpenedShows.
// Off-Broadway / off-West-End subscribers did not opt into those markets.
const BROADCAST_CATEGORIES = new Set(['broadway', 'west-end']);

// Wait this many days past opening before calling a show missed. The window is
// 2 days, so 3 means "the pipeline has definitively stopped trying" — never a
// race against a broadcast that is merely late.
const DEFAULT_MIN_AGE_DAYS = 3;

// Stop reporting after this. Two reasons: an unbounded lookback would, on this
// script's first ever run, page with every pre-pipeline show in a 2,900-show
// corpus; and a show nobody rescued in three weeks is a backlog item, not an
// alert. Bounded age is what keeps this a signal about the LIVE pipeline.
const DEFAULT_MAX_AGE_DAYS = 21;

// Only shows that could actually have been sent. Matches WEST_END_MIN in
// broadcast-readiness.js — the coarse "enough has landed" floor. Below it, a
// show legitimately never broadcasts (sparse critical coverage is not a
// pipeline failure), and paging about it would be pure noise forever.
const DEFAULT_MIN_SCORED_REVIEWS = 12;

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between a bare 'YYYY-MM-DD' opening date and `now`, both anchored
 * to UTC midnight. Parsing the parts explicitly (rather than `new Date(str)`
 * plus `setHours`, as the workflow's inline blocks do) keeps this stable
 * regardless of the runner's TZ — the mixed UTC-parse/local-truncate pairing
 * shifts by a day for anyone west of Greenwich.
 */
function daysSinceOpening(openingDate, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(openingDate || ''));
  if (!m) return null;
  const opened = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((todayUtc - opened) / MS_PER_DAY);
}

/**
 * Did this show's broadcast ever complete? `completed` is set once the Resend
 * draft exists (recordDraftCompletion in send-opening-night-broadcast.js); the
 * owner then sends from Resend. migrateSentRecord is applied so pre-schema
 * legacy entries read correctly instead of looking un-sent and re-paging.
 *
 * A `preview:<market>:<id>:<date>` entry does NOT count: the owner getting a
 * preview of a draft that was never created is exactly the half-finished state
 * this sweep is meant to surface.
 */
function hasCompletedBroadcast(sentShows, showId) {
  const record = (sentShows || {})[showId];
  if (!record) return false;
  return migrateSentRecord(record).completed === true;
}

/**
 * @param {object}   args
 * @param {Array}    args.shows      - shows.json `.shows`
 * @param {object}   args.sentShows  - opening-night-sent.json `.shows`
 * @param {Array}    args.reviews    - reviews.json entries (for the scored floor)
 * @param {number}   args.now        - epoch ms
 * @returns {Array<{id,title,category,openingDate,daysSinceOpening,scoredReviews}>}
 *   sorted oldest-opening first. Empty array is the healthy case.
 */
function findMissedBroadcasts({
  shows,
  sentShows,
  reviews,
  now,
  minAgeDays = DEFAULT_MIN_AGE_DAYS,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  minScoredReviews = DEFAULT_MIN_SCORED_REVIEWS,
} = {}) {
  const scoredByShow = new Map();
  for (const r of reviews || []) {
    if (!r || r.assignedScore == null) continue;
    scoredByShow.set(r.showId, (scoredByShow.get(r.showId) || 0) + 1);
  }

  const missed = [];
  for (const s of shows || []) {
    if (!s || !s.id || !s.openingDate) continue;
    if (s.status !== 'open') continue;
    if (!BROADCAST_CATEGORIES.has(s.category)) continue;
    // Opera never broadcasts (see findRecentlyOpenedShows) — don't page for
    // the absence of a send that is deliberately never attempted.
    if (s.type === 'opera') continue;

    const age = daysSinceOpening(s.openingDate, now);
    if (age === null || age < minAgeDays || age > maxAgeDays) continue;
    if (hasCompletedBroadcast(sentShows, s.id)) continue;

    const scored = scoredByShow.get(s.id) || 0;
    if (scored < minScoredReviews) continue;

    missed.push({
      id: s.id,
      title: s.title || s.id,
      category: s.category,
      openingDate: s.openingDate,
      daysSinceOpening: age,
      scoredReviews: scored,
    });
  }

  return missed.sort((a, b) => b.daysSinceOpening - a.daysSinceOpening || a.id.localeCompare(b.id));
}

module.exports = {
  findMissedBroadcasts,
  daysSinceOpening,
  hasCompletedBroadcast,
  BROADCAST_CATEGORIES,
  DEFAULT_MIN_AGE_DAYS,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MIN_SCORED_REVIEWS,
};
