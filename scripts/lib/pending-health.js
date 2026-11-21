/**
 * BRO-6336: the pending-review queue must never pile up unseen again (180 entries sat four months).
 * Pure threshold check used by health-check.js.
 */
'use strict';

const { pendingBacklogStats } = require('./pending-review-backlog');

const MAX_PENDING_ENTRIES = 25;
const MAX_OLDEST_AGE_DAYS = 14;
// BRO-6471: a row held for a person gets a worker card once it has waited this long (the health row files it).
const MAX_HELD_AGE_DAYS = 7;
const DAY_MS = 86400000;

const isHeld = (e) => !!(e && e.autoApplyBlocked);

/** @returns {{ ok: boolean, problems: string[], stats: object }} */
function pendingQueueHealth(pending, now = Date.now(), { maxEntries = MAX_PENDING_ENTRIES, maxAgeDays = MAX_OLDEST_AGE_DAYS } = {}) {
  // Rows held on purpose for a person (autoApplyBlocked) cannot be cleared by the daily pass, so they do not count
  // against the queue limits; heldRowsHealth reports them.
  const shows = Object.fromEntries(Object.entries((pending && pending.shows) || {}).filter(([, e]) => !isHeld(e)));
  const stats = pendingBacklogStats({ ...pending, shows }, now);
  const problems = [];
  if (stats.count > maxEntries) problems.push(`${stats.count} entries wait (limit ${maxEntries})`);
  if (stats.oldestAgeDays != null && stats.oldestAgeDays > maxAgeDays) problems.push(`oldest entry is ${stats.oldestAgeDays} days old (limit ${maxAgeDays}): ${stats.oldestKey}`);
  return { ok: problems.length === 0, problems, stats };
}

/**
 * BRO-6471: rows the daily pass held for a person (autoApplyBlocked), aged from when they were held. Nobody reads
 * a parked Linear card, so a row held past the limit fails the health row that files a worker card.
 * @returns {{ ok: boolean, held: { key: string, needs: string, heldDays: number|null }[], overdue: object[] }}
 */
function heldRowsHealth(pending, now = Date.now(), { maxHeldAgeDays = MAX_HELD_AGE_DAYS } = {}) {
  const held = Object.entries((pending && pending.shows) || {}).filter(([, e]) => isHeld(e)).map(([key, e]) => {
    const at = Date.parse(e.autoApplyBlockedAt || e.detectedAt || e.researchedAt);
    return { key, needs: String(e.autoApplyBlocked), heldDays: Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / DAY_MS)) : null };
  });
  // An undated held row counts as overdue: there is no telling how long it has waited.
  const overdue = held.filter((h) => h.heldDays == null || h.heldDays > maxHeldAgeDays);
  return { ok: overdue.length === 0, held, overdue };
}

module.exports = { pendingQueueHealth, heldRowsHealth, MAX_PENDING_ENTRIES, MAX_OLDEST_AGE_DAYS, MAX_HELD_AGE_DAYS };
