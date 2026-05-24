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
//   2. Filter to /show/{slug} paths.
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

const MIN_THIS_WEEK_VIEWS = 30;  // noise floor
const PRIOR_FLOOR = 5;           // divisor floor — keeps 0 → small ratios sane
const MIN_GROWTH = 1.5;          // must be at least 1.5× to count as climbing

function loadEnv(repo) {
  const envPath = path.join(repo, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2];
  }
}

export async function fetchTrendingShowPages({ repo, days = 7, limit = 5 } = {}) {
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
  } else {
    return null;
  }

  // Multi-range report. GA4 returns one row per (pagePath × dateRange).
  // The range name lands in dimensionValues[1] when ≥2 dateRanges are passed.
  let res;
  try {
    [res] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [
        { startDate: `${days}daysAgo`, endDate: 'today', name: 'thisWeek' },
        { startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo`, name: 'priorWeek' },
      ],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 200, // generous — filter to show pages then sort by growth
    });
  } catch (err) {
    process.stderr.write(`[trending-pages] GA4 query failed: ${err.message}\n`);
    return null;
  }

  const showRe = /^\/show\/([a-z0-9-]+)\/?$/i;
  const bySlug = new Map();
  for (const row of (res.rows || [])) {
    const pagePath = row.dimensionValues?.[0]?.value || '';
    const rangeName = row.dimensionValues?.[1]?.value || '';
    const m = showRe.exec(pagePath);
    if (!m) continue;
    const slug = m[1];
    const views = parseInt(row.metricValues?.[0]?.value || '0', 10);
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, views: 0, prior: 0 });
    const entry = bySlug.get(slug);
    if (rangeName === 'thisWeek' || rangeName === 'date_range_0') entry.views = views;
    else if (rangeName === 'priorWeek' || rangeName === 'date_range_1') entry.prior = views;
  }

  const climbers = [];
  for (const entry of bySlug.values()) {
    if (entry.views < MIN_THIS_WEEK_VIEWS) continue;
    const priorEffective = Math.max(entry.prior, PRIOR_FLOOR);
    const growth = entry.views / priorEffective;
    if (growth < MIN_GROWTH) continue;
    climbers.push({ ...entry, growth });
  }
  climbers.sort((a, b) => b.growth - a.growth);
  return climbers.slice(0, limit);
}

// Backwards-compatible alias — generator imports `fetchPopularShowPages`.
// New code should prefer `fetchTrendingShowPages` (more accurate name).
export { fetchTrendingShowPages as fetchPopularShowPages };
