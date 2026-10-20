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
 * The cooldown rule is the same as BWW's: none within 7 days of opening (the
 * roundup may be about to publish), 24h otherwise.
 */

'use strict';

const {
  readRoundupMisses,
  lastMissForShow,
  isInRoundupMissCooldown,
  recordRoundupMiss,
} = require('./bww-roundup-persistence');

const trMissKey = (showId) => `tr:${showId}`;

/** Pure: should theatre.reviews discovery be skipped for `show`? */
function isTrDiscoveryInCooldown(show, entries, now = Date.now()) {
  if (!show || !show.id) return false;
  return isInRoundupMissCooldown(show, lastMissForShow(trMissKey(show.id), entries), now);
}

/** Record a miss, only when the WP search answered (not on a fetch failure). */
function recordTrMiss(show, stats, ledgerPath) {
  if (!show || !show.id || !stats || !stats.searchCompleted) return false;
  recordRoundupMiss(trMissKey(show.id), ledgerPath);
  return true;
}

module.exports = { trMissKey, isTrDiscoveryInCooldown, recordTrMiss, readRoundupMisses };
