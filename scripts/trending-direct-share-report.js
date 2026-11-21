#!/usr/bin/env node
'use strict';
/**
 * trending-direct-share-report.js (BRO-2503): how much of the newsletter's
 * "Trending This Week" input is Direct-channel traffic, and how the ranking
 * changes when Direct is excluded. Same GA4 query as
 * scripts/newsletter/popular-pages.mjs. Read-only.
 *
 * Env: GA4_PROPERTY_ID, GA_SERVICE_ACCOUNT_KEY (base64) or GA_KEY_FILE.
 * Run from a cloud session: node scripts/cloud-run-script.js scripts/trending-direct-share-report.js
 */
const { getGaClient } = require('./lib/ga4-client');
const { rankTrendingShowPages, directShareOfShowViews } = require('./lib/newsletter-trending');

async function main() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) { console.error('GA4_PROPERTY_ID not set'); process.exit(1); }
  const days = 7;
  const [res] = await getGaClient().runReport({
    property: `properties/${propertyId}`,
    dateRanges: [
      { startDate: `${days}daysAgo`, endDate: 'today', name: 'thisWeek' },
      { startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo`, name: 'priorWeek' },
    ],
    dimensions: [{ name: 'pagePath' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'screenPageViews' }],
    dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/show/' } } },
    limit: 100000,
  });
  const rows = res.rows || [];
  if (res.rowCount > rows.length) throw new Error('incomplete show-page channel report');
  const { total, direct, share } = directShareOfShowViews(rows);
  console.log(`/show/ page views, last ${days}d: ${total} total, ${direct} Direct (${share === null ? 'n/a' : (share * 100).toFixed(1) + '%'})`);
  const fmt = (list) => list.map((r) => `${r.slug} (${r.views} views, ${r.growth.toFixed(1)}x)`).join('; ') || '(none)';
  console.log('Trending, Direct included :', fmt(rankTrendingShowPages(rows, { excludeDirect: false })));
  console.log('Trending, Direct excluded :', fmt(rankTrendingShowPages(rows, { excludeDirect: true })));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
