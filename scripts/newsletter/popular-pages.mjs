// Real "Most Popular Pages" data, sourced from Google Analytics 4 Data API.
//
// Replaces the prior hand-built fallback (openings + closings padded to 3)
// that Codex correctly flagged as dishonest. Now: actual GA4 page views.
//
// Filters to `/show/{slug}` paths so the email renders renderable cards with
// the show's poster + critic score. The wider GA4 top-pages list includes
// section pages (/biz, /tony-awards, etc.) which are valid traffic signals
// but not in a format that maps to the show-card UI of this newsletter.
//
// Auth: same GA4_PROPERTY_ID + GA_KEY_FILE / GA_SERVICE_ACCOUNT_KEY env vars
// scripts/query-analytics.js uses — credentials are already wired.
//
// Falls back to null on error so the section silently skips and the runner's
// build report records the skipReason — same pattern as every other section.

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const cjsRequire = createRequire(import.meta.url);

function loadEnv(repo) {
  const envPath = path.join(repo, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2];
  }
}

// Returns: [{ slug, views, users }, ...] sorted by views desc.
// `limit` caps how many we surface (default 5 — newsletter renders top 3 but
// keeping a few extras lets the caller filter for "open" shows only).
// `days` is the GA4 lookback window (default 7).
export async function fetchPopularShowPages({ repo, days = 7, limit = 5 } = {}) {
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
    // GA_KEY_FILE is a relative path in .env (./ga-service-account.json).
    // Resolve against `repo` so it works from a worktree where cwd differs.
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

  let res;
  try {
    [res] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      // Pull a generous slice — many show pages will fall outside the top 5
      // global pages (which are dominated by /, /biz, /off-broadway, etc.)
      limit: 50,
    });
  } catch (err) {
    process.stderr.write(`[popular-pages] GA4 query failed: ${err.message}\n`);
    return null;
  }

  const showRe = /^\/show\/([a-z0-9-]+)\/?$/i;
  const pages = [];
  for (const row of (res.rows || [])) {
    const pagePath = row.dimensionValues?.[0]?.value || '';
    const m = showRe.exec(pagePath);
    if (!m) continue;
    pages.push({
      slug: m[1],
      views: parseInt(row.metricValues?.[0]?.value || '0', 10),
      users: parseInt(row.metricValues?.[1]?.value || '0', 10),
    });
    if (pages.length >= limit) break;
  }
  return pages;
}
