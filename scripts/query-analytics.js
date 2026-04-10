#!/usr/bin/env node
/**
 * query-analytics.js — Query Google Analytics 4 Data API
 *
 * Setup (one-time):
 *   1. Go to https://console.cloud.google.com → Create or select project
 *   2. Enable "Google Analytics Data API" (search in API Library)
 *   3. Create a Service Account (IAM → Service Accounts → Create)
 *   4. Download the JSON key file
 *   5. In GA4 Admin → Property Access Management → Add the service account
 *      email as "Viewer"
 *   6. Save key as GA_KEY_FILE=/path/to/key.json in .env
 *      or base64-encode it: GA_SERVICE_ACCOUNT_KEY=$(base64 < key.json)
 *   7. Set GA4_PROPERTY_ID in .env (numeric property ID, not "G-..." measurement ID)
 *
 * Usage:
 *   node scripts/query-analytics.js                    # Default: ticket clicks summary
 *   node scripts/query-analytics.js ticket-clicks      # Ticket clicks by show & platform
 *   node scripts/query-analytics.js top-pages          # Most viewed pages (last 30 days)
 *   node scripts/query-analytics.js traffic            # Daily sessions & users (last 30 days)
 *   node scripts/query-analytics.js events             # All custom events summary
 *   node scripts/query-analytics.js search-terms       # What users search for on-site
 *   node scripts/query-analytics.js geo-audit          # Country breakdown — find bot geos
 *   node scripts/query-analytics.js --days=7           # Override date range (any report)
 *   node scripts/query-analytics.js --start=2026-02-01 --end=2026-02-17  # Exact range
 */

const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = process.env[match[1]] || match[2];
  }
}

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;

function getClient() {
  if (process.env.GA_KEY_FILE) {
    return new BetaAnalyticsDataClient({ keyFilename: process.env.GA_KEY_FILE });
  }
  if (process.env.GA_SERVICE_ACCOUNT_KEY) {
    const decoded = Buffer.from(process.env.GA_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8');
    return new BetaAnalyticsDataClient({ credentials: JSON.parse(decoded) });
  }
  return new BetaAnalyticsDataClient();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { report: 'ticket-clicks', days: 30, start: null, end: null };
  for (const arg of args) {
    if (arg.startsWith('--days=')) opts.days = parseInt(arg.split('=')[1]);
    else if (arg.startsWith('--start=')) opts.start = arg.split('=')[1];
    else if (arg.startsWith('--end=')) opts.end = arg.split('=')[1];
    else if (!arg.startsWith('--')) opts.report = arg;
  }
  return opts;
}

function getDateRange(opts) {
  if (opts.start && opts.end) return { startDate: opts.start, endDate: opts.end };
  return { startDate: `${opts.days}daysAgo`, endDate: 'today' };
}

function formatTable(headers, rows) {
  if (rows.length === 0) { console.log('  (no data)'); return; }
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] || '').length))
  );
  console.log(`  ${headers.map((h, i) => h.padEnd(colWidths[i])).join('  ')}`);
  console.log(`  ${colWidths.map(w => '─'.repeat(w)).join('──')}`);
  for (const row of rows) {
    console.log(`  ${row.map((v, i) => String(v || '').padEnd(colWidths[i])).join('  ')}`);
  }
}

async function reportTicketClicks(client, dateRange) {
  console.log('\nTicket Link Clicks\n');

  const [summary] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'ticket_link_click' } } },
  });
  console.log(`  Total clicks: ${parseInt(summary.rows?.[0]?.metricValues?.[0]?.value || '0').toLocaleString()}\n`);

  const [byShow] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'customEvent:show_name' }, { name: 'customEvent:platform' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'ticket_link_click' } } },
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 30,
  });
  formatTable(['Show', 'Platform', 'Clicks'], (byShow.rows || []).map(r => [
    r.dimensionValues[0]?.value, r.dimensionValues[1]?.value,
    parseInt(r.metricValues[0]?.value || '0').toLocaleString(),
  ]));

  console.log('');
  const [byDay] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'ticket_link_click' } } },
    orderBys: [{ dimension: { dimensionName: 'date' } }],
  });
  formatTable(['Date', 'Clicks'], (byDay.rows || []).map(r => {
    const d = r.dimensionValues[0]?.value || '';
    return [`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`, parseInt(r.metricValues[0]?.value || '0').toLocaleString()];
  }));
}

async function reportTopPages(client, dateRange) {
  console.log('\nTop Pages\n');
  const [res] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 40,
  });
  formatTable(['Page', 'Views', 'Users'], (res.rows || []).map(r => [
    r.dimensionValues[0]?.value,
    parseInt(r.metricValues[0]?.value || '0').toLocaleString(),
    parseInt(r.metricValues[1]?.value || '0').toLocaleString(),
  ]));
}

async function reportTraffic(client, dateRange) {
  console.log('\nDaily Traffic\n');
  const [res] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
  });
  formatTable(['Date', 'Sessions', 'Users', 'Page Views'], (res.rows || []).map(r => {
    const d = r.dimensionValues[0]?.value || '';
    return [`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`,
      parseInt(r.metricValues[0]?.value || '0').toLocaleString(),
      parseInt(r.metricValues[1]?.value || '0').toLocaleString(),
      parseInt(r.metricValues[2]?.value || '0').toLocaleString()];
  }));
}

async function reportEvents(client, dateRange) {
  console.log('\nAll Events\n');
  const [res] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 30,
  });
  formatTable(['Event', 'Count', 'Users'], (res.rows || []).map(r => [
    r.dimensionValues[0]?.value,
    parseInt(r.metricValues[0]?.value || '0').toLocaleString(),
    parseInt(r.metricValues[1]?.value || '0').toLocaleString(),
  ]));
}

async function reportGeoAudit(client, dateRange) {
  console.log('\nGeo Audit — bot detection via engagement outliers\n');
  const [res] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'country' }],
    metrics: [
      { name: 'sessions' },
      { name: 'engagementRate' },
      { name: 'averageSessionDuration' },
      { name: 'screenPageViewsPerSession' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 25,
  });
  formatTable(
    ['Country', 'Sessions', 'Engagement %', 'Avg Duration', 'Pages/Session'],
    (res.rows || []).map((r) => {
      const engagement = parseFloat(r.metricValues[1]?.value || '0') * 100;
      const duration = parseFloat(r.metricValues[2]?.value || '0');
      const pps = parseFloat(r.metricValues[3]?.value || '0');
      return [
        r.dimensionValues[0]?.value || '(not set)',
        parseInt(r.metricValues[0]?.value || '0').toLocaleString(),
        engagement.toFixed(1) + '%',
        duration.toFixed(1) + 's',
        pps.toFixed(2),
      ];
    })
  );
  console.log('\n  Bot signature: high sessions + low engagement % + low duration + ~1.0 pages/session');
}

async function reportSearchTerms(client, dateRange) {
  console.log('\nOn-Site Search Terms\n');
  const [res] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'searchTerm' }],
    metrics: [{ name: 'eventCount' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 30,
  });
  formatTable(['Search Term', 'Count'], (res.rows || []).map(r => [
    r.dimensionValues[0]?.value,
    parseInt(r.metricValues[0]?.value || '0').toLocaleString(),
  ]));
}

async function main() {
  if (!PROPERTY_ID) {
    console.error('GA4_PROPERTY_ID not set in .env');
    console.error('Find it: GA4 Admin > Property Settings > Property ID (numeric, not G-...)');
    process.exit(1);
  }
  const opts = parseArgs();
  const dateRange = getDateRange(opts);
  const client = getClient();
  console.log(`Date range: ${dateRange.startDate} to ${dateRange.endDate}`);

  const reports = {
    'ticket-clicks': reportTicketClicks, 'top-pages': reportTopPages,
    'traffic': reportTraffic, 'events': reportEvents, 'search-terms': reportSearchTerms,
    'geo-audit': reportGeoAudit,
  };
  const fn = reports[opts.report];
  if (!fn) { console.error(`Unknown report: ${opts.report}\nAvailable: ${Object.keys(reports).join(', ')}`); process.exit(1); }

  try {
    await fn(client, dateRange);
  } catch (err) {
    if (err.message?.includes('credentials')) {
      console.error('\nAuth failed. Set GA_KEY_FILE or GA_SERVICE_ACCOUNT_KEY in .env');
    } else {
      console.error(`\nError: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
