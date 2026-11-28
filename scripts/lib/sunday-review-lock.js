#!/usr/bin/env node
/**
 * sunday-review-lock — pure "already ran today" decision for the Sunday
 * newsletter content-review launchd job (#507).
 *
 * Same class of bug as #476 (monitor-lock-staleness.js): the guard must key
 * off a timestamp written ONCE by the launcher (meta.ranAt), never off a
 * file/dir mtime — any unrelated process that stats/touches the lock file
 * resets mtime without a run actually happening. "Today" is a calendar day
 * in America/New_York (the job's actual clock: Sunday 9am ET), not UTC —
 * comparing raw ISO timestamps would misfire for hours around the ET/UTC
 * date boundary.
 *
 * On any ambiguous read (missing file, corrupt JSON, unparseable date) this
 * defaults to "not yet run today" — i.e. PROCEED — mirroring the #476
 * lesson that ambiguity must fail toward doing the work, never toward a
 * silent skip.
 */

const fs = require('fs');

function etDateString(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * @param {{ranAt?: string}|null} meta parsed lock meta.json (or null)
 * @param {Date} [now] injectable clock for tests
 * @returns {boolean} true if a run already completed today (ET) — skip
 */
function alreadyRanToday(meta, now = new Date()) {
  if (!meta || typeof meta.ranAt !== 'string') return false;
  const ranAt = new Date(meta.ranAt);
  if (Number.isNaN(ranAt.getTime())) return false;
  return etDateString(ranAt) === etDateString(now);
}

function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { etDateString, alreadyRanToday, readMeta };

if (require.main === module) {
  const metaPath = process.argv[2];
  if (!metaPath) { console.error('usage: sunday-review-lock.js <meta-json-path>'); process.exit(2); }
  console.log(alreadyRanToday(readMeta(metaPath)) ? 'ALREADY_RAN' : 'PENDING');
}
