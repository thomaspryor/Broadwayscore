/**
 * Fold a timestamped history array to one entry per calendar day (task #530
 * follow-up).
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * Rolling-window history files ("keep the last N entries") assume one entry per
 * run-day. When CI runs the producer many times in a day, that assumption
 * breaks and the window silently collapses: data/audit/bundle-size-history.json
 * held 50 entries spanning 8 days with duplicates, 21 of them on 2026-04-19
 * alone. A "last 50 builds" trend meant to cover ~50 days was covering ~2 — so
 * any comparison against the far end of the window was reading yesterday, not
 * last month, and nothing surfaced that.
 *
 * This is the same class as the duplicate 2026-06-21 row that skewed
 * check-seo-health.js's 4-week baselines for six weeks (#530). There the key
 * was a date string and the duplicate was exact; here the key is a full ISO
 * timestamp, so no two entries collide and the blind append looks fine.
 *
 * Folding by DAY before trimming makes the retention count mean what it says.
 * The last entry for a day wins: it is the most complete measurement of that
 * day's build.
 *
 * @param {Array<object>} entries      history rows, oldest first
 * @param {string} [field='timestamp'] the ISO-ish date/timestamp field to key on
 * @returns {Array<object>} one entry per day, chronological
 */
'use strict';

function foldHistoryByDay(entries, field = 'timestamp') {
  if (!Array.isArray(entries)) return [];

  const byDay = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry[field];
    // Anything without a usable key is kept as-is under a unique bucket rather
    // than dropped — losing a row to fix a duplicate would be a worse bug.
    const day = typeof raw === 'string' && raw.length >= 10
      ? raw.slice(0, 10)
      : `__unkeyed_${byDay.size}`;
    byDay.set(day, entry); // last write for a day wins
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, entry]) => entry);
}

module.exports = { foldHistoryByDay };
