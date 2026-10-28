/**
 * BRO-6336: the pending-review queue must never pile up unseen again (180 entries sat four months).
 * Pure threshold check used by health-check.js.
 */
'use strict';

const { pendingBacklogStats } = require('./pending-review-backlog');

const MAX_PENDING_ENTRIES = 25;
const MAX_OLDEST_AGE_DAYS = 14;
// Rows held for a person get a longer leash: they wait on the pending-review Linear card, but must not sit forever.
const MAX_HELD_AGE_DAYS = 60;

/** @returns {{ ok: boolean, problems: string[], stats: object }} */
function pendingQueueHealth(pending, now = Date.now(), { maxEntries = MAX_PENDING_ENTRIES, maxAgeDays = MAX_OLDEST_AGE_DAYS, maxHeldAgeDays = MAX_HELD_AGE_DAYS } = {}) {
  // Rows held on purpose for a person (autoApplyBlocked) cannot be cleared by automation, so they do not count
  // against the queue limits; the pending-review Linear card carries them.
  const shows = Object.fromEntries(Object.entries((pending && pending.shows) || {}).filter(([, e]) => !(e && e.autoApplyBlocked)));
  const stats = pendingBacklogStats({ ...pending, shows }, now);
  const problems = [];
  if (stats.count > maxEntries) problems.push(`${stats.count} entries wait (limit ${maxEntries})`);
  if (stats.oldestAgeDays != null && stats.oldestAgeDays > maxAgeDays) problems.push(`oldest entry is ${stats.oldestAgeDays} days old (limit ${maxAgeDays}): ${stats.oldestKey}`);
  const held = Object.fromEntries(Object.entries((pending && pending.shows) || {}).filter(([, e]) => e && e.autoApplyBlocked));
  const heldStats = pendingBacklogStats({ ...pending, shows: held }, now);
  if (heldStats.oldestAgeDays != null && heldStats.oldestAgeDays > maxHeldAgeDays) problems.push(`a row held for a person is ${heldStats.oldestAgeDays} days old (limit ${maxHeldAgeDays}): ${heldStats.oldestKey}`);
  return { ok: problems.length === 0, problems, stats };
}

module.exports = { pendingQueueHealth, MAX_PENDING_ENTRIES, MAX_OLDEST_AGE_DAYS };
