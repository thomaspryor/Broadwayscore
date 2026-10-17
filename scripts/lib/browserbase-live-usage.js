/**
 * Shared live Browserbase session-count check, used to enforce a single
 * account-wide daily cap across every script that creates Browserbase
 * sessions directly (currently scripts/collect-review-texts.js and
 * scripts/lib/bww-rr-discover.js).
 *
 * Why this exists (#312): browserbase-caps.js's pure decision function is
 * correct, but its input (a local sessionsToday counter written by ONE
 * script) only ever saw that script's own spend. bww-rr-discover.js's
 * fetchReviewsPageAnchors() creates sessions on a completely separate path
 * (opening-night-poller.js, watch-aggregator-urls.js, audit-show-review-gap.js)
 * with NO session-count cap at all — "cadence-gated at the caller side" per
 * its own docstring, i.e. nothing actually stops it. Live audit 2026-07-27:
 * the Browserbase API reported 310 sessions in the trailing 24h while
 * collect-review-texts.js's local counter showed only 27 — most real spend
 * was happening outside the capped path entirely.
 *
 * Querying the account's actual session list (same endpoint
 * scraper-cost-report.yml already treats as billing ground truth) gives every
 * caller a shared, accurate view of total spend regardless of which script or
 * how many concurrent CI runs created the sessions.
 */

const axios = require('axios');

const BROWSERBASE_SESSIONS_URL = 'https://api.browserbase.com/v1/sessions';

/**
 * Count sessions with createdAt within the last `hours` from a raw API
 * response body. Pure — separated out so the counting logic can be unit
 * tested with a fixture instead of a live network call.
 */
function countRecentSessions(responseData, hours = 24, nowMs = Date.now()) {
  const items = Array.isArray(responseData) ? responseData : (responseData && responseData.data) || [];
  const cutoff = nowMs - hours * 60 * 60 * 1000;
  return items.filter(s => s && s.createdAt && new Date(s.createdAt).getTime() >= cutoff).length;
}

/**
 * Fetch the actual number of Browserbase sessions created in the last
 * `hours` (default 24, rolling) for the given account/project.
 * Returns null on any failure — callers MUST treat null as "unknown," never
 * as "zero" (a network hiccup must not look like a clean budget).
 */
async function fetchLiveBrowserbaseSessionsToday(apiKey, projectId, { hours = 24, timeout = 8000 } = {}) {
  if (!apiKey || !projectId) return null;
  try {
    const resp = await axios.get(BROWSERBASE_SESSIONS_URL, {
      params: { projectId },
      headers: { 'x-bb-api-key': apiKey },
      timeout,
    });
    return countRecentSessions(resp.data, hours);
  } catch {
    return null;
  }
}

module.exports = { fetchLiveBrowserbaseSessionsToday, countRecentSessions, BROWSERBASE_SESSIONS_URL };
