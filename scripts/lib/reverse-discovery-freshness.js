/**
 * Freshness check for data/audit/reverse-discovery-candidates.json (BRO-114).
 *
 * Why: audit-reverse-discovery.yml runs every 6h and diffs each source's
 * current rolling window against reverse-discovery-state.json — a show that
 * appeared while a run was skipped still surfaces on the NEXT run, as long
 * as it's still inside the window when that run finally executes. That's a
 * natural backfill, not an explicit one, and it has a real limit: the BWW
 * Google-News sitemap (bwwgnewsbway.cfm) is the shortest-window source
 * (~5 days live-verified 2026-07-26, vs. WET/DTLI's --days=45 sitemaps). If
 * the cron is skipped/delayed for longer than that window, an article can
 * rotate out before any run ever sees it — permanently and silently, since
 * nothing before this check compared `generatedAt` against wall-clock time.
 *
 * checkReverseDiscoveryFreshness is the pure decision function; health-
 * check.js's reverseDiscoveryFreshnessResults formats it into a digest row.
 */

'use strict';

// One missed 6h run plus buffer before flagging — avoids false alarms from
// ordinary run-to-run jitter (queued concurrency group, GHA cron delay).
const STALE_WARN_HOURS = 24;

// Comfortably inside the ~5-day BWW window's edge: still time for a human to
// notice and re-dispatch before an article that's currently in-window rotates
// out unseen.
const STALE_ERROR_HOURS = 96;

/**
 * @param {{generatedAt?: string}|null|undefined} report - parsed reverse-discovery-candidates.json
 * @param {number} nowMs - current time in ms (Date.now() at call site)
 * @returns {{hoursStale: number, severity: 'warn'|'error'}|null} null when fresh or report/generatedAt missing
 */
function checkReverseDiscoveryFreshness(report, nowMs) {
  if (!report || typeof report.generatedAt !== 'string') return null;
  const generatedMs = Date.parse(report.generatedAt);
  if (!Number.isFinite(generatedMs)) return null;
  const hoursStale = (nowMs - generatedMs) / (60 * 60 * 1000);
  if (hoursStale < STALE_WARN_HOURS) return null;
  return { hoursStale, severity: hoursStale >= STALE_ERROR_HOURS ? 'error' : 'warn' };
}

module.exports = { checkReverseDiscoveryFreshness, STALE_WARN_HOURS, STALE_ERROR_HOURS };
