// "Trending This Week" data — GA4 page-view climbers, ranked by WoW growth.
//
// Earlier version was "Most-Read Show Pages" sorted by raw views, which made
// Hamilton + Wicked the top two slots every week (user-flagged 2026-05-24:
// "Is Hamilton and Wicked going to be the top two slots for the most read
// pages just every week?"). Evergreen blockbusters always win raw-views.
//
// What's actually newsworthy in a weekly digest is MOVEMENT — which show's
// page got a traffic spike vs the prior week. That maps to "people are
// suddenly searching for / talking about X right now," which is the kind
// of signal a Broadway-fan newsletter exists to surface.
//
// Algorithm:
//   1. Query GA4 twice — last 7 days AND the 7 days before that — in a
//      single multi-range report.
//   2. Filter to /show/{slug} paths and exclude Direct traffic from both weeks
//      (BRO-2503: the same bot-inflated channel identified in BRO-44).
//   3. Compute growth = thisWeek_views / max(priorWeek_views, FLOOR).
//      FLOOR prevents 0 → tiny → "infinite growth" noise.
//   4. Require thisWeek_views ≥ MIN_THIS_WEEK_VIEWS for noise control
//      (a page going 1 → 8 views shouldn't make the top-3).
//   5. Sort by growth ratio desc.
//
// Returns: [{ slug, views, prior, growth }, ...].

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const cjsRequire = createRequire(import.meta.url);
const { rankTrendingShowPages } = cjsRequire('../lib/newsletter-trending.js');
export { rankTrendingShowPages };

function loadEnv(repo) {
  const envPath = path.join(repo, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2];
  }
}

// `asOf` (YYYY-MM-DD) anchors the trending window to the issue's draft date
// rather than the wall-clock run date. The newsletter is drafted Saturday and
// sent Sunday; if the run is DELAYED to e.g. Monday, a `today`-relative window
// slides off the issue's week (a major traffic event like the Tony Awards moves
// from "this week" into the "prior week" baseline, collapsing all growth ratios)
// and the section silently empties. Anchoring makes a delayed run produce the
// same Trending list an on-time run would have. When `asOf` is omitted the
// original run-date-relative window is used.
export async function fetchTrendingShowPages({ repo, days = 7, limit = 5, asOf = null } = {}) {
  loadEnv(repo);
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) return null;

  let BetaAnalyticsDataClient;
  try {
    ({ BetaAnalyticsDataClient } = cjsRequire('@google-analytics/data'));
  } catch {
    return null;
  }

  let client;
  if (process.env.GA_KEY_FILE) {
    const keyPath = path.isAbsolute(process.env.GA_KEY_FILE)
      ? process.env.GA_KEY_FILE
      : path.resolve(repo, process.env.GA_KEY_FILE);
    client = new BetaAnalyticsDataClient({ keyFilename: keyPath });
  } else if (process.env.GA_SERVICE_ACCOUNT_KEY) {
    const decoded = Buffer.from(process.env.GA_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8');
    client = new BetaAnalyticsDataClient({ credentials: JSON.parse(decoded) });
  } else if (!process.env.CI && !process.env.GITHUB_ACTIONS) {
    // Application Default Credentials — LAST resort, and LOCAL ONLY.
    //
    // Why it exists: without this, a dev machine can never render the Trending
    // section, because the only other credential paths are a key file and a
    // base64 secret that live solely in CI. On 2026-08-09 that forced a false
    // choice — CI could build Trending but stripped the featured openings,
    // while a local run kept the openings and silently dropped Trending. The
    // owner had to ship a newsletter missing a section.
    //
    // Why it is gated to non-CI: in CI a missing secret MUST fail loudly. If a
    // runner ever carries an ambient service identity (self-hosted, GCP-backed
    // image), an ungated ADC fallback would quietly authenticate as whatever
    // that identity is and query a GA4 property nobody chose — shipping a
    // plausible-but-wrong Trending list instead of an obvious empty one. Silent
    // wrong data is worse than a visible gap; that is the whole lesson of the
    // 2026-08-09 incident. Locally the blast radius is one dev's preview.
    try {
      client = new BetaAnalyticsDataClient();
    } catch {
      return null;
    }
  } else {
    return null;
  }

  // Multi-range report: one row per (pagePath, channel, dateRange).
  // The implicit range name is appended at dimensionValues[2].
  const off = (n) => { const d = new Date(asOf + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const dateRanges = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    ? [
        { startDate: off(-days), endDate: asOf, name: 'thisWeek' },
        { startDate: off(-days * 2), endDate: off(-(days + 1)), name: 'priorWeek' },
      ]
    : [
        { startDate: `${days}daysAgo`, endDate: 'today', name: 'thisWeek' },
        { startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo`, name: 'priorWeek' },
      ];
  let res;
  try {
    [res] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges,
      dimensions: [{ name: 'pagePath' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'screenPageViews' }],
      dimensionFilter: {
        filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/show/' } },
      },
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      // Channel breakdown multiplies rows. Keep both weeks' baselines instead
      // of taking only the 200 busiest page/channel/range combinations.
      limit: 100000,
    });
    if (res.rowCount > (res.rows || []).length) throw new Error('incomplete show-page channel report');
  } catch (err) {
    process.stderr.write(`[trending-pages] GA4 query failed: ${err.message}\n`);
    return null;
  }

  return rankTrendingShowPages(res.rows || [], { limit });
}

// Backwards-compatible alias — generator imports `fetchPopularShowPages`.
// New code should prefer `fetchTrendingShowPages` (more accurate name).
export { fetchTrendingShowPages as fetchPopularShowPages };
