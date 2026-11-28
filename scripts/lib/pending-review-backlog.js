/**
 * BRO-6336: how big and how old the commercial pending-review backlog is.
 * Pure; scripts/pending-review-backlog.js prints it in the weekly commercial run so a pile
 * of unreviewed deep-research results (180 sat for four months) shows up as a number.
 */
'use strict';

const DAY_MS = 86400000;

function entryTime(entry) {
  for (const field of ['researchedAt', 'detectedAt', 'addedAt']) {
    const t = Date.parse(entry && entry[field]);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** pending: the parsed commercial-pending-review.json. Returns { count, dated, oldestKey, oldestAt, oldestAgeDays }. */
function pendingBacklogStats(pending, now = Date.now()) {
  const shows = (pending && pending.shows) || {};
  let oldestKey = null;
  let oldestMs = null;
  let dated = 0;
  for (const [key, entry] of Object.entries(shows)) {
    const t = entryTime(entry);
    if (t == null) continue;
    dated++;
    if (oldestMs == null || t < oldestMs) { oldestMs = t; oldestKey = key; }
  }
  return {
    count: Object.keys(shows).length,
    dated,
    oldestKey,
    oldestAt: oldestMs == null ? null : new Date(oldestMs).toISOString(),
    oldestAgeDays: oldestMs == null ? null : Math.max(0, Math.floor((now - oldestMs) / DAY_MS)),
  };
}

function formatBacklogLine(stats) {
  if (!stats.count) return 'Pending-review backlog: 0 entries.';
  const age = stats.oldestAgeDays == null ? 'oldest age unknown (no dated entries)' : `oldest ${stats.oldestAgeDays} days (${stats.oldestKey}, ${stats.oldestAt.slice(0, 10)})`;
  const undated = stats.count - stats.dated;
  return `Pending-review backlog: ${stats.count} entries, ${age}${undated ? `, ${undated} undated` : ''}.`;
}

module.exports = { pendingBacklogStats, formatBacklogLine, entryTime };
