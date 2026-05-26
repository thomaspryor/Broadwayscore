'use strict';

/**
 * Per-venue anomaly gate.
 *
 * Why: Pre-Mortem PRIMARY scenario — a venue page redesign that leaks
 * "Spring Gala 2026" + 13 other phantoms (Atlantic h2 selector reuse)
 * would otherwise push 14 fake shows into staging in one cron tick. The
 * 30-candidate per-source cap catches absurd floods. This gate catches
 * MORE SUBTLE anomalies: a venue that normally returns 6 shows suddenly
 * returns 12 → 2× the rolling 7-day median.
 *
 * Storage: data/audit/ob-venue-counts.json — `{venue: {[YYYY-MM-DD]: count}}`.
 *
 * Behavior:
 *   - Always appends today's count for the venue.
 *   - If fewer than 7 days of history, return 'no-baseline' (no alarm).
 *   - If today's count is more than 2× the 7-day median, set
 *     process.exitCode = 1 and emit `::warning::` so the cron logs
 *     surface it. Returns 'anomalous'.
 *   - Else returns 'ok'.
 *
 * Fail-soft by design: we WARN rather than HARD-FAIL so discovery keeps
 * going for other venues; admin investigates next session.
 */

const fs = require('fs');
const path = require('path');

const COUNTS_FILE = path.join(__dirname, '..', '..', 'data', 'audit', 'ob-venue-counts.json');
const MIN_BASELINE_DAYS = 7;
const ANOMALY_MULTIPLIER = 2;

function loadCounts() {
  try { return JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCounts(counts) {
  fs.mkdirSync(path.dirname(COUNTS_FILE), { recursive: true });
  const tmp = COUNTS_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(counts, null, 2));
  fs.renameSync(tmp, COUNTS_FILE);
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * @param {string} venueName
 * @param {number} todayCount
 * @param {Object} options - { dateOverride for testing }
 * @returns {{ status: 'ok'|'no-baseline'|'anomalous', median: number, todayCount: number }}
 */
function checkVenueAnomaly(venueName, todayCount, options = {}) {
  const counts = loadCounts();
  const today = options.dateOverride || new Date().toISOString().slice(0, 10);
  if (!counts[venueName]) counts[venueName] = {};
  counts[venueName][today] = todayCount;

  // Window: last 7 calendar days NOT including today, only days where we
  // actually have a record (not synthesizing zeros for missing days — a
  // discovery cron miss would otherwise tank the median).
  const recordedDays = Object.entries(counts[venueName])
    .filter(([d]) => d !== today)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // newest first
    .slice(0, MIN_BASELINE_DAYS);

  if (recordedDays.length < MIN_BASELINE_DAYS) {
    saveCounts(counts);
    return { status: 'no-baseline', median: 0, todayCount };
  }

  const baselineCounts = recordedDays.map(([, n]) => n);
  const med = median(baselineCounts);

  if (med >= 1 && todayCount > ANOMALY_MULTIPLIER * med) {
    console.warn(`::warning::venue ${venueName} anomaly: today=${todayCount} > ${ANOMALY_MULTIPLIER}× median ${med} (baseline ${baselineCounts.join(',')})`);
    process.exitCode = 1;
    saveCounts(counts);
    return { status: 'anomalous', median: med, todayCount };
  }

  saveCounts(counts);
  return { status: 'ok', median: med, todayCount };
}

module.exports = {
  checkVenueAnomaly,
  COUNTS_FILE,
  MIN_BASELINE_DAYS,
  ANOMALY_MULTIPLIER,
};
