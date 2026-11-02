'use strict';
/**
 * BRO-6837: how many shows that were open when the validation baseline was
 * written have since closed on their own scheduled closingDate. health-check's
 * "Sync: baseline drift" subtracts these from the open-show drop, so a weekend
 * of planned closings is not reported to the owner as lost data.
 *
 * Only shows listed in baseline.openShowIds count (written by validate-data.js),
 * so a show that closed before the baseline, or one that disappeared from
 * shows.json, is never excused. A baseline without openShowIds (written before
 * this change) excuses nothing. Pure.
 *
 * @param {Array<{id?:string, status?:string, closingDate?:string}>} shows
 * @param {{openShowIds?:string[]}|null|undefined} baseline
 * @param {Date} [now]
 * @returns {number}
 */
function countScheduledClosingsSince(shows, baseline, now = new Date()) {
  if (!Array.isArray(shows) || !baseline || !Array.isArray(baseline.openShowIds)) return 0;
  const wasOpen = new Set(baseline.openShowIds);
  const today = now.toISOString().slice(0, 10);
  let n = 0;
  for (const s of shows) {
    if (!s || !wasOpen.has(s.id) || s.status !== 'closed') continue;
    const d = typeof s.closingDate === 'string' ? s.closingDate.slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today) n++;
  }
  return n;
}

module.exports = { countScheduledClosingsSince };
