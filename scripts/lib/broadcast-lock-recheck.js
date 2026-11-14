'use strict';
/**
 * broadcast-lock-recheck.js — re-verify opening-night eligibility INSIDE the
 * send-lock critical section (BRO-3493 gap 2).
 *
 * send-opening-night-broadcast.js filters pendingShows and runs
 * checkPreviewDedup on the tracker it read at startup, before
 * acquireSendLock(). Two runs that both read "pending" would each proceed
 * once they won the lock in turn. The caller re-reads the tracker after
 * acquiring the lock and asks this function whether a show it is about to
 * draft was taken in the meantime. Pure: no I/O, no clock of its own.
 */

const { shouldRequeueShow, isDiscarded } = require('./broadcast-state');
const { sentOnSiblingRecord } = require('./missed-broadcasts');

/**
 * @param {object} freshShows  tracker `.shows` re-read after the lock was won
 * @param {string[]} showIds   shows the about-to-be-created draft covers
 * @param {{ recreate?: boolean, nowMs?: number }} [opts]
 * @returns {string|null} why the draft must not be created, or null to proceed
 */
function draftLockRecheckBlockReason(freshShows, showIds, { recreate = false, nowMs } = {}) {
  const shows = freshShows || {};
  for (const showId of showIds || []) {
    // A send is final even under --recreate-draft (BRO-4875: recreating a
    // sent show is a double send).
    if (sentOnSiblingRecord(shows, showId)) return `${showId} was sent by another run`;
    if (recreate) continue;
    const rec = shows[showId];
    if (!rec) continue;
    if (isDiscarded(rec)) return `${showId} was discarded at ${rec.discardedAt}`;
    if (rec.completed && !shouldRequeueShow(rec, nowMs)) {
      return `${showId} was drafted by another run${rec.draftId ? ` (draft ${rec.draftId})` : ''}`;
    }
  }
  return null;
}

module.exports = { draftLockRecheckBlockReason };
