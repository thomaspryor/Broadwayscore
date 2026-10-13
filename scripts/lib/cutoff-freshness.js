'use strict';
/**
 * Pure decisions for scripts/check-cutoff-freshness.js (BRO-3040).
 *
 * The Tony half used to default a missing `lastVerified` to today, so its
 * staleness was always 0 days and the alarm could never fire. Now every
 * record must carry the field: findMissingLastVerified() names the ones that
 * do not, and the CLI fails on them instead of passing silently.
 */

const FRESHNESS_WINDOW_DAYS = 60;
const STALE_THRESHOLD_DAYS = 60;

function daysBetween(isoA, isoB) {
  return Math.round((new Date(isoB) - new Date(isoA)) / 86400000);
}

/** Records whose lastVerified is absent or not an ISO YYYY-MM-DD date. */
function findMissingLastVerified(records) {
  return records.filter((r) => !(typeof r.lastVerified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.lastVerified)));
}

/**
 * Stale records: `end` is 0..FRESHNESS_WINDOW_DAYS away and lastVerified is
 * more than STALE_THRESHOLD_DAYS old. Returns [{ record, daysToEnd, daysStale }].
 */
function findStaleCutoffs(records, today) {
  const stale = [];
  for (const r of records) {
    const daysToEnd = daysBetween(today, r.end);
    if (daysToEnd < 0 || daysToEnd > FRESHNESS_WINDOW_DAYS) continue;
    const daysStale = daysBetween(r.lastVerified || '1970-01-01', today);
    if (daysStale > STALE_THRESHOLD_DAYS) stale.push({ record: r, daysToEnd, daysStale });
  }
  return stale;
}

module.exports = { FRESHNESS_WINDOW_DAYS, STALE_THRESHOLD_DAYS, daysBetween, findMissingLastVerified, findStaleCutoffs };
