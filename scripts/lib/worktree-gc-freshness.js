/**
 * Freshness check for data/audit/worktree-gc.log (BRO-2608).
 *
 * Why: gc-merged-worktrees.sh (via com.broadwayscore.worktree-gc launchd
 * agent, hourly) is the only automated brake on disk growth from abandoned
 * worktrees. On 2026-08-26 it silently stopped appending to this log for
 * five days while disk fell from 88Gi to 26Gi free, and nothing anywhere
 * noticed — there was no freshness signal on this log, so a launchd
 * scheduling failure (or any other cause) produced total silence instead of
 * a warning. This does not fix the launchd cause; it makes the NEXT outage
 * of this kind visible on the same day it starts instead of five days later.
 *
 * checkWorktreeGcFreshness is the pure decision function; health-check.js's
 * worktreeGcFreshnessResults formats it into a digest row.
 */

'use strict';

// launchd fires the agent hourly (StartInterval 3600) plus a 04:00 daily
// backstop (StartCalendarInterval) — 6h covers several missed hourly fires
// plus jitter before flagging, same margin as other hourly-cadence checks in
// this file (avoids false alarms from ordinary run-to-run jitter).
const STALE_WARN_HOURS = 6;

// A day past the warn threshold: comfortably inside the observed ~5-day
// outage window this issue exists for, escalated from warn to error so a
// multi-day outage doesn't sit at the same severity as a single missed hour.
const STALE_ERROR_HOURS = 24;

/**
 * @param {string|null|undefined} logText - contents of data/audit/worktree-gc.log
 * @returns {string|null} the newest `YYYY-MM-DD HH:MM:SS` timestamp found in a
 *   bracketed log line (UTC, as written by gc-merged-worktrees.sh's `date -u`
 *   + `tee -a`), or null if no such line exists.
 */
function lastTimestampFromLog(logText) {
  if (typeof logText !== 'string') return null;
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * @param {string|null|undefined} lastLineTimestamp - e.g. "2026-08-31 11:13:30" (UTC), from lastTimestampFromLog()
 * @param {number} nowMs - current time in ms (Date.now() at call site)
 * @returns {{hoursStale: number, severity: 'warn'|'error'}|null} null when fresh or timestamp missing/unparseable
 */
function checkWorktreeGcFreshness(lastLineTimestamp, nowMs) {
  if (typeof lastLineTimestamp !== 'string' || !lastLineTimestamp) return null;
  // Explicit 'Z': the log is written in UTC (`date -u`, BRO-2608 fix) but
  // this runs on a UTC GitHub Actions runner (data-health-check.yml), not the
  // Mac Studio that writes the log — an offset-less parse here would be
  // read back as THIS process's local time instead, silently reintroducing
  // the exact TZ-mismatch bug the UTC write was meant to close.
  const parsedMs = Date.parse(`${lastLineTimestamp.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsedMs)) return null;
  const hoursStale = (nowMs - parsedMs) / (60 * 60 * 1000);
  if (hoursStale < STALE_WARN_HOURS) return null;
  return { hoursStale, severity: hoursStale >= STALE_ERROR_HOURS ? 'error' : 'warn' };
}

module.exports = { checkWorktreeGcFreshness, lastTimestampFromLog, STALE_WARN_HOURS, STALE_ERROR_HOURS };
