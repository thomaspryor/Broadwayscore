/**
 * theatre.reviews roundup negative cache.
 *
 * Why: opening-night-poller.js re-ran discoverTrRoundupHtml for every WE show
 * on every poll. For a show with no roundup that is 2 guessed URLs, each a
 * paid Bright Data call that returns nothing. Poller run 39249486257: 30 of 51
 * theatre.reviews BD calls went to 15 shows with no roundup page.
 *
 * Misses go in the existing BWW roundup miss ledger
 * (data/audit/bww-roundup-miss-ledger.jsonl) under the key `tr:<showId>`, so no
 * new file needs workflow staging, a union-merge rule or a push-with-retry
 * entry, and BWW cooldown lookups (keyed by the bare showId) never see them.
 * Cooldown tiers are TR-specific (see cooldownMsFor).
 */

'use strict';

const {
  readRoundupMisses,
  lastMissForShow,
  recordRoundupMiss,
} = require('./bww-roundup-persistence');

const HOUR = 3600000;
// Tiered, unlike BWW's all-or-nothing 7-day exemption: replaying poller run
// 39249486257 against it skipped only 5 of 15 misses, because 10 of the 15
// opened 3-6 days earlier. TR publishes its roundup after the press night
// reviews, so the first 2 days (from UTC midnight of openingDate, i.e. ~28h after
// a 19:30 London press night) stay uncached; after that a miss holds for 6h
// (still inside the 7-day window), then 24h. An unknown opening date holds 12h.
const HOT_DAYS = 2;
const WINDOW_DAYS = 7;
const COOLDOWN_HOT_MS = 0;
const COOLDOWN_WINDOW_MS = 6 * HOUR;
const COOLDOWN_SETTLED_MS = 24 * HOUR;
const COOLDOWN_UNDATED_MS = 12 * HOUR;

function cooldownMsFor(show, now) {
  const openingMs = show && show.openingDate ? new Date(show.openingDate).getTime() : NaN;
  if (!Number.isFinite(openingMs)) return COOLDOWN_UNDATED_MS;
  const days = Math.abs(now - openingMs) / 86400000;
  if (days < HOT_DAYS) return COOLDOWN_HOT_MS;
  if (days < WINDOW_DAYS) return COOLDOWN_WINDOW_MS;
  return COOLDOWN_SETTLED_MS;
}

const trMissKey = (showId) => `tr:${showId}`;

/** Pure: should theatre.reviews discovery be skipped for `show`? */
function isTrDiscoveryInCooldown(show, entries, now = Date.now()) {
  if (process.env.TR_MISS_CACHE_DISABLED === 'true') return false; // kill switch
  if (!show || !show.id) return false;
  const last = lastMissForShow(trMissKey(show.id), entries);
  if (!last) return false;
  return now - new Date(last.ts).getTime() < cooldownMsFor(show, now);
}

/** Record a miss, only when the WP search answered (not on a fetch failure). */
function recordTrMiss(show, stats, ledgerPath) {
  if (!show || !show.id || !stats || !stats.searchCompleted) return false;
  // Inside the hot window the cooldown is 0, so a row would never be read:
  // skip it rather than append one per poll.
  if (cooldownMsFor(show, Date.now()) === 0) return false;
  recordRoundupMiss(trMissKey(show.id), ledgerPath);
  return true;
}

module.exports = { cooldownMsFor, trMissKey, isTrDiscoveryInCooldown, recordTrMiss, readRoundupMisses };
