/**
 * BRO-6336: the pending-review queue must never pile up unseen again (180 entries sat four months).
 * Pure threshold check used by health-check.js.
 */
'use strict';

const { pendingBacklogStats } = require('./pending-review-backlog');

const MAX_PENDING_ENTRIES = 25;
const MAX_OLDEST_AGE_DAYS = 14;

/** @returns {{ ok: boolean, problems: string[], stats: object }} */
function pendingQueueHealth(pending, now = Date.now(), { maxEntries = MAX_PENDING_ENTRIES, maxAgeDays = MAX_OLDEST_AGE_DAYS } = {}) {
  // Rows held on purpose for a person (autoApplyBlocked, already emailed once) cannot be cleared by automation, so
  // they do not count against the queue limits; the owner digest carries them.
  const shows = Object.fromEntries(Object.entries((pending && pending.shows) || {}).filter(([, e]) => !(e && e.autoApplyBlocked)));
  const stats = pendingBacklogStats({ ...pending, shows }, now);
  const problems = [];
  if (stats.count > maxEntries) problems.push(`${stats.count} entries wait (limit ${maxEntries})`);
  if (stats.oldestAgeDays != null && stats.oldestAgeDays > maxAgeDays) problems.push(`oldest entry is ${stats.oldestAgeDays} days old (limit ${maxAgeDays}): ${stats.oldestKey}`);
  return { ok: problems.length === 0, problems, stats };
}

module.exports = { pendingQueueHealth, MAX_PENDING_ENTRIES, MAX_OLDEST_AGE_DAYS };
