#!/usr/bin/env node
/**
 * Refreshes data/seo-gsc-impressions.json: 90-day Search Console impressions per
 * /show, /cast and /critics page (searchAnalytics, dimension "page"). Read by
 * scripts/lib/seo-indexability.js: a page only counts as thin with 0 impressions
 * here AND no PostHog search landing (BRO-5992). Needs GOOGLE_INDEXING_KEY (CI only).
 * Never overwrites the snapshot with an empty or failed pull.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { getAccessToken, loadServiceAccount, SCOPE_WEBMASTERS, SITE_URL_GSC } = require('./submit-google-indexing');
const { aggregateRows } = require('./lib/gsc-impressions');

const OUT = path.join(__dirname, '..', 'data', 'seo-gsc-impressions.json');
const WINDOW_DAYS = 90;
const PAGE_SIZE = 25000;
const MAX_PAGES = 20; // 500k rows ceiling

async function main() {
  const token = await getAccessToken(loadServiceAccount(), SCOPE_WEBMASTERS);
  const end = new Date(); end.setDate(end.getDate() - 3); // ~3 day GSC lag
  const start = new Date(end); start.setDate(start.getDate() - WINDOW_DAYS + 1);
  const fmt = d => d.toISOString().slice(0, 10);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL_GSC)}/searchAnalytics/query`;
  const rows = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: fmt(start), endDate: fmt(end), dimensions: ['page'], rowLimit: PAGE_SIZE, startRow: i * PAGE_SIZE }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`GSC searchAnalytics ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const batch = (await res.json()).rows || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    // A truncated pull would read as 0 impressions for the missing pages: refuse it.
    if (i === MAX_PAGES - 1) throw new Error(`hit the ${MAX_PAGES * PAGE_SIZE} row ceiling; raise MAX_PAGES, keeping existing snapshot`);
  }
  const pages = aggregateRows(rows);
  if (Object.keys(pages).length === 0) throw new Error(`no tracked pages in ${rows.length} GSC rows; keeping existing snapshot`);
  const sorted = Object.fromEntries(Object.keys(pages).sort().map(k => [k, pages[k]]));
  const out = { generated: new Date().toISOString().slice(0, 10), windowDays: WINDOW_DAYS, startDate: fmt(start), endDate: fmt(end), pages: sorted };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${Object.keys(sorted).length} pages (${rows.length} GSC rows) to ${path.relative(process.cwd(), OUT)}`);
}
main().catch(e => { console.error(e.message); process.exit(1); });
