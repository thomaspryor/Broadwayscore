/**
 * hoursAgo() / formatAge(): the age helpers scripts/health-check.js uses for
 * every freshness row. Extracted (BRO-2476) so scripts/lib/audit-freshness-
 * checks.js computes ages with the SAME code instead of a copy; health-check.js
 * re-exports hoursAgo unchanged.
 *
 * BRO-3349 (prevent-class): a BARE "YYYY-MM-DD" is a whole UTC day, not the
 * instant of its midnight. `new Date('2026-09-20')` is that day's START, so
 * treating it as a write timestamp inflates every reported age by up to 24h —
 * which is exactly how "Data quality: provider spend ledger" spent five days
 * reporting a perfectly fresh ledger as ">48h stale". Two live FRESHNESS_CHECKS
 * fields are day-shaped today (data/cast-changes.json's `lastUpdated`, warn at
 * 72h with a Wed+Sat writer — a Saturday write read 83h on Tuesday against a
 * true 59h; and data/commercial.json's `_meta.lastUpdated`), and nothing stops
 * a future producer from emitting another. Anchoring on the day's END is the
 * only reading that cannot over-report: a file written at ANY point during day
 * D is at most as old as D's end. Full timestamps are untouched — they do not
 * match the bare-day shape.
 *
 * BRO-2476: the end-of-day anchor makes a bare day equal to TODAY read as a
 * negative age ("Freshness: cast-changes.json: -19h old" in the 2026-10-13
 * digest). Ages are clamped at 0: every caller compares `age > threshold`, so
 * a not-yet-ended day and a just-written file are both simply "fresh".
 *
 * Covered by scripts/tests/health-check-hours-ago.test.mjs.
 */

'use strict';

const BARE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function hoursAgo(dateStr, now = Date.now()) {
  // `new Date(null)` is epoch 0, i.e. a FINITE ~497,000h — a plausible-looking
  // number rather than the Infinity every caller's "no usable value" branch
  // expects. Numeric epoch inputs stay supported (some snapshots store
  // `timestamp` as a number); only null is special-cased.
  if (dateStr === null) return Infinity;
  const d = new Date(BARE_DAY_RE.test(dateStr) ? `${dateStr}T23:59:59.999Z` : dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return Math.max(0, (now - d.getTime()) / (1000 * 60 * 60));
}

function formatAge(hours) {
  if (hours === Infinity) return 'unknown';
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

module.exports = { hoursAgo, formatAge, BARE_DAY_RE };
