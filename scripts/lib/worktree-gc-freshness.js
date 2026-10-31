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

/**
 * BRO-2617: the combined log stays fresh while any one repo's pass is running,
 * so a single repo (e.g. ios) going silent is invisible to the overall check.
 * gc-merged-worktrees.sh writes a `DIGEST[<repo>]:` line for every repo on every
 * pass, which makes it the per-repo heartbeat.
 * @param {string|null|undefined} logText
 * @returns {Record<string,string>} repo name -> newest `YYYY-MM-DD HH:MM:SS` of its DIGEST line
 */
function lastTimestampsByRepo(logText) {
  const out = {};
  if (typeof logText !== 'string') return out;
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] DIGEST\[([^\]]+)\]:/.exec(lines[i]);
    if (m && !(m[2] in out)) out[m[2]] = m[1];
  }
  return out;
}

/**
 * @param {string|null|undefined} logText
 * @param {number} nowMs
 * @param {string[]} [expectedRepos] when non-empty, the only repos checked (each must have a heartbeat)
 * @returns {Array<{repo:string, hoursStale:number|null, severity:'warn'|'error'}>} stale repos only.
 *   A repo with no heartbeat at all reports hoursStale null, severity error. Empty when the
 *   log has no DIGEST lines and nothing is expected.
 */
function checkWorktreeGcFreshnessByRepo(logText, nowMs, expectedRepos = []) {
  const byRepo = lastTimestampsByRepo(logText);
  // When the caller names the repos, check only those: a name left in the log by a renamed or
  // removed repo would otherwise alarm forever.
  const names = new Set(expectedRepos.length ? expectedRepos : Object.keys(byRepo));
  const stale = [];
  for (const repo of names) {
    if (!byRepo[repo]) { stale.push({ repo, hoursStale: null, severity: 'error' }); continue; }
    const r = checkWorktreeGcFreshness(byRepo[repo], nowMs);
    if (r) stale.push({ repo, ...r });
  }
  return stale;
}

/** Pure: one payload per repo whose own DIGEST heartbeat is stale (BRO-2617). */
function evaluateRepos(logText, nowMs, expectedRepos = []) {
  if (logText == null) return [];
  return checkWorktreeGcFreshnessByRepo(logText, nowMs, expectedRepos).map((s) => ({
    conditionKey: `worktree-gc:stale:${s.repo}`,
    title: `Infra: worktree GC stale for repo ${s.repo}`,
    description: s.hoursStale == null
      ? `worktree-gc.log has no DIGEST[${s.repo}] line at all, so the ${s.repo} repo's worktrees are not being garbage-collected.`
      : `worktree-gc.log has no DIGEST[${s.repo}] line in the last ${s.hoursStale.toFixed(1)}h while other repos may still be logging, so the ${s.repo} repo's GC pass may have silently stopped.`,
    severity: s.severity, disposition: 'digest',
  }));
}

module.exports = { checkWorktreeGcFreshness, lastTimestampFromLog, lastTimestampsByRepo, checkWorktreeGcFreshnessByRepo, evaluateRepos, STALE_WARN_HOURS, STALE_ERROR_HOURS };
