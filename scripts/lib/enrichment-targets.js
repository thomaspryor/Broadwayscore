'use strict';
/**
 * enrichment-targets.js — shared ordering for the daily `--limit=N` enrichers
 * (BRO-7437, root cause of the recurring "Data freshness: shows missing
 * poster/synopsis/tickets" card: BRO-5455, BRO-7368, BRO-7412).
 *
 * THE BUG CLASS. A daily cron runs an enricher over a large candidate list
 * with `--limit=N` and takes `list.slice(0, N)`. Two things then go wrong at
 * once, and both are invisible from the enricher's own output (it cheerfully
 * reports "Attempting 20"):
 *
 *   1. STARVATION. With no rotation, every run takes the SAME first N rows.
 *      Candidates N+1..end are never attempted, not once, for as long as the
 *      cron has existed.
 *   2. WRONG END OF THE LIST. The candidate list is usually in shows.json file
 *      order, which is roughly historical. Closed shows dominate it. The rows
 *      the health check actually reddens over — OPEN shows a visitor can click
 *      today — sit at the far end and are therefore exactly the rows starved.
 *
 * Measured on real data before this file existed (2026-11-13):
 * selectSynopsisTargets() returned 3209 candidates, of which 35 were open and
 * 2953 were closed. update-show-status.yml's three daily synopsis passes
 * (--limit=20, west-end --limit=10, off-west-end --limit=10) reached 40 shows
 * a day, and ZERO of them were among the 38 open shows the freshness report
 * flagged missing_synopsis. The first 20 were all `status: 'closed'`. That is
 * why the gap count only ever grew (65 -> 75 -> 78): the producer never looked
 * at it.
 *
 * THE FIX — three parts, all needed:
 *
 *   TIERS. Shows a visitor can buy a ticket to today (open, previews) rank
 *     ahead of shows that have not opened yet (upcoming), which rank ahead of
 *     the historical tail. The health row counts OPEN shows only, so treating
 *     `upcoming` as equal to `open` would let 215 not-yet-open rows swamp the
 *     35 the row is actually reddening over.
 *   FAIR SHARE. The daily budget is split across the non-empty tiers, an equal
 *     floor each, with the remainder cascading upward. Giving tier 0 the whole
 *     budget would simply move the starvation onto `upcoming` and closed shows
 *     — the same bug with different victims. Note the floor is at least one
 *     slot but never more than the budget itself: with a budget smaller than
 *     the number of non-empty tiers (limit 1 or 2, which no caller uses today)
 *     the lowest tiers get nothing that day. The budget is never overspent.
 *   ROTATION. Day-of-month rotation inside each tier, so a permanently
 *     unfillable row at the head cannot starve the rest of its tier forever.
 *     This is not a new idea: it is the pattern already proven in
 *     enrich-fallback-ticket-links.js:131-136 and ob-discovery-ticket-links.js
 *     ("Day-of-month rotation so permanently-unfindable shows at the head of
 *     the list can't starve the tail forever"). Those two scripts were the
 *     only enrichers that had it. Their inline copies are left as they are —
 *     they are correct and single-tier — but new callers should use this file.
 *
 * PINNING. A caller that has already earned a row its place at the head
 * (BRO-4763: the Broadway parent of an active tour, which is usually a CLOSED
 * revival and so would otherwise sink into the bottom tier) passes it as
 * `pinned`. Pinned rows are taken first and are never rotated out.
 *
 * Guarded by tests/unit/enrichment-target-reach.test.mjs, which fails if a
 * daily enricher's slice no longer reaches, within a month, the open shows the
 * freshness report is flagging.
 */

/** Statuses meaning "a visitor can see or buy this today". */
const LIVE_STATUSES = Object.freeze(['open', 'previews']);
/** Not yet open, but dated: needs its data BEFORE opening night, not after. */
const SOON_STATUSES = Object.freeze(['upcoming']);
/** Everything the daily enrichers should prefer over the historical tail. */
const ACTIVE_STATUSES = Object.freeze([...LIVE_STATUSES, ...SOON_STATUSES]);

function isLiveShow(show) {
  return !!show && LIVE_STATUSES.includes(show.status);
}

function isActiveShow(show) {
  return !!show && ACTIVE_STATUSES.includes(show.status);
}

/** 0 = live, 1 = upcoming, 2 = historical tail / unknown status. */
function statusTier(show) {
  if (isLiveShow(show)) return 0;
  if (show && SOON_STATUSES.includes(show.status)) return 1;
  return 2;
}

/**
 * Stable partition into the three tiers, source order preserved inside each.
 * Pure; returns a new array of arrays.
 */
function tierShows(shows) {
  const tiers = [[], [], []];
  if (!Array.isArray(shows)) return tiers;
  for (const s of shows) tiers[statusTier(s)].push(s);
  return tiers;
}

/**
 * Stable partition: active shows (live + upcoming) first, then the tail.
 * Kept as its own export because it is the cheap predicate callers want when
 * they only need "is this row one the health row cares about".
 */
function orderActiveFirst(shows) {
  const [live, soon, tail] = tierShows(shows);
  return live.concat(soon, tail);
}

/**
 * Daily rotation, then cap. `limit <= 0` means no cap (and so no rotation:
 * nothing is being starved if everything is attempted).
 *
 * The offset counts DAYS SINCE THE EPOCH, not the day of the month. The two
 * inline copies this logic was lifted from (enrich-fallback-ticket-links.js,
 * ob-discovery-ticket-links.js) use `(dayOfMonth * limit) % length`, and that
 * is the one thing from them not worth keeping: `dayOfMonth` only ever takes
 * 31 values, so the offset only ever takes 31 values, and a list longer than
 * about 31 x limit cycles the same 31 windows forever. Rows before the first
 * window and after the last are never attempted — not rarely, never. That is
 * the very bug this module exists to kill, so reproducing it inside the fix
 * would have moved the starvation from the live tier onto the long tail
 * instead of ending it (ship-check finding; measured: the 2953-row tail
 * reached 186 rows in a month and the same 186 every month).
 *
 * With an epoch-day offset the window advances every day without repeating,
 * so every row is reached in ceil(length / limit) days. That is slow for a
 * long tail — a 2953-row tier at 6 a day takes about 16 months — but slow is
 * a budget problem, and it does finish. Never is a different thing.
 *
 * @param {Array} list    candidates, already ordered
 * @param {number} limit  max to attempt this run
 * @param {Date} [now]    injectable clock for tests
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function rotateDaily(list, limit, now = new Date()) {
  if (!Array.isArray(list)) return [];
  if (!limit || limit <= 0 || list.length <= limit) return list.slice();
  const dayIndex = Math.floor(now.getTime() / MS_PER_DAY);
  const offset = ((dayIndex * limit) % list.length + list.length) % list.length;
  return list.slice(offset).concat(list.slice(0, offset)).slice(0, limit);
}

/**
 * Split `limit` across the non-empty tiers: an equal floor each, with the
 * remainder and any slots a small tier cannot use cascading to the earlier
 * (higher-priority) tiers. Returns one budget per tier, same index order.
 */
function shareBudget(tiers, limit) {
  const budgets = tiers.map(() => 0);
  const nonEmpty = tiers.map((t, i) => (t.length ? i : -1)).filter(i => i >= 0);
  if (!nonEmpty.length || limit <= 0) return budgets;
  let remaining = limit;
  const floor = Math.max(1, Math.floor(limit / nonEmpty.length));
  for (const i of nonEmpty) {
    const take = Math.min(floor, tiers[i].length, remaining);
    budgets[i] = take;
    remaining -= take;
  }
  // Cascade what is left (the division remainder, plus slots a tier smaller
  // than its floor could not use) to the highest-priority tiers that can
  // still absorb it.
  for (const i of nonEmpty) {
    if (remaining <= 0) break;
    const spare = Math.min(remaining, tiers[i].length - budgets[i]);
    budgets[i] += spare;
    remaining -= spare;
  }
  return budgets;
}

/**
 * The whole policy in one call.
 *
 * @param {Array} shows                 candidates, in the caller's own order
 * @param {number} limit                max to attempt this run (<=0 = all)
 * @param {object} [opts]
 * @param {Date}   [opts.now]           injectable clock
 * @param {Array}  [opts.pinned]        rows to place at the head, unrotated
 *
 * `pinned` is matched by show `id` where the rows carry one, falling back to
 * object identity. Identity alone silently stops pinning the moment a caller
 * clones, re-reads or re-parses its rows, which would drop a tour parent back
 * into the historical tail without a word (ship-check finding).
 */
function selectDailyTargets(shows, limit, { now = new Date(), pinned = [] } = {}) {
  const all = Array.isArray(shows) ? shows : [];
  const pinnedRefs = new Set(pinned);
  const pinnedIds = new Set(pinned.map(s => s && s.id).filter(Boolean));
  const isPinned = s => pinnedRefs.has(s) || (!!s && !!s.id && pinnedIds.has(s.id));
  const head = all.filter(isPinned);
  const rest = all.filter(s => !isPinned(s));
  if (!limit || limit <= 0 || all.length <= limit) return head.concat(rest);
  if (head.length >= limit) return head.slice(0, limit);

  const tiers = tierShows(rest);
  const budgets = shareBudget(tiers, limit - head.length);
  const picked = head.slice();
  for (let i = 0; i < tiers.length; i++) {
    if (budgets[i] > 0) picked.push(...rotateDaily(tiers[i], budgets[i], now));
  }
  return picked;
}

module.exports = {
  LIVE_STATUSES,
  SOON_STATUSES,
  ACTIVE_STATUSES,
  isLiveShow,
  isActiveShow,
  statusTier,
  tierShows,
  orderActiveFirst,
  rotateDaily,
  shareBudget,
  selectDailyTargets,
};
