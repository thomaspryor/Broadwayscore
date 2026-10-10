#!/usr/bin/env node
/**
 * Show "+ reviews" ranking analyzer.
 *
 * The site-wide average position (≈9.6) is misleading: it's inflated by the brand
 * term and a few strong pages. This script answers the real question — how do we
 * actually rank for "[show] reviews"-intent queries, across ALL shows?
 *
 * Pulls the last 28 days of Search Console query data, isolates review-intent
 * queries (contain "review"/"reviews"), and buckets them by position so you can
 * see the true distribution (top-3 vs page-1 vs page-2 vs beyond) rather than a
 * single brand-skewed mean. Also buckets /show/ DETAIL pages by position.
 *
 * Read-only. No writes, no alerts. Run via workflow_dispatch (needs GOOGLE_INDEXING_KEY).
 *   node scripts/analyze-show-review-rankings.js
 */

const { getAccessToken, loadServiceAccount, SCOPE_WEBMASTERS, SITE_URL_GSC } = require('./submit-google-indexing');

const DAYS = 28;
const SITE = encodeURIComponent(SITE_URL_GSC);

async function gsc(token, body) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${SITE}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`GSC ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Position buckets — competition rank semantics: lower = better.
function bucketOf(pos) {
  if (pos <= 3) return 'top3';
  if (pos <= 10) return 'page1'; // 4-10
  if (pos <= 20) return 'page2'; // 11-20
  return 'beyond'; // 21+
}

function summarize(rows, label) {
  const buckets = { top3: [], page1: [], page2: [], beyond: [] };
  let totClicks = 0, totImp = 0, wPos = 0;
  for (const r of rows) {
    buckets[bucketOf(r.position)].push(r);
    totClicks += r.clicks;
    totImp += r.impressions;
    wPos += r.position * r.impressions; // impression-weighted avg position
  }
  const avgPos = totImp > 0 ? wPos / totImp : 0;
  console.log(`\n=== ${label} ===`);
  console.log(`  ${rows.length} queries | ${totClicks} clicks | ${totImp} impressions | impression-weighted avg position ${avgPos.toFixed(1)}`);
  for (const [name, list] of Object.entries(buckets)) {
    const c = list.reduce((s, r) => s + r.clicks, 0);
    const i = list.reduce((s, r) => s + r.impressions, 0);
    const pct = rows.length ? Math.round((list.length / rows.length) * 100) : 0;
    const labelName = { top3: 'Top 3   ', page1: 'Page 1 (4-10)', page2: 'Page 2 (11-20)', beyond: 'Beyond (21+) ' }[name];
    console.log(`  ${labelName}: ${String(list.length).padStart(4)} queries (${String(pct).padStart(2)}%) | ${String(c).padStart(5)} clicks | ${i} impressions`);
  }
  return { rows: rows.length, totClicks, totImp, avgPos, buckets };
}

async function main() {
  const token = await getAccessToken(loadServiceAccount(), SCOPE_WEBMASTERS);

  const end = new Date();
  end.setDate(end.getDate() - 3); // GSC ~3-day lag
  const start = new Date(end);
  start.setDate(start.getDate() - DAYS);
  const fmt = d => d.toISOString().slice(0, 10);
  console.log(`Window: ${fmt(start)} to ${fmt(end)} (${DAYS} days)`);

  // All queries (rowLimit max 25000)
  const qData = await gsc(token, {
    startDate: fmt(start), endDate: fmt(end), dimensions: ['query'], rowLimit: 25000,
  });
  const allQueries = (qData.rows || []).map(r => ({
    query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position,
  }));
  console.log(`\nPulled ${allQueries.length} total queries.`);

  // Review-intent queries: contain the word "review" or "reviews"
  const reviewQueries = allQueries.filter(r => /\breviews?\b/i.test(r.query));
  summarize(reviewQueries, 'REVIEW-INTENT QUERIES ("[show] review(s)")');

  // For contrast: the brand term(s) we know inflate the site average
  const brand = allQueries.filter(r => /broadway\s*scorecard|broadwayscorecard/i.test(r.query));
  const brandClicks = brand.reduce((s, r) => s + r.clicks, 0);
  const totalClicks = allQueries.reduce((s, r) => s + r.clicks, 0);
  console.log(`\nBrand queries: ${brand.length} | ${brandClicks} clicks (${Math.round((brandClicks / Math.max(totalClicks, 1)) * 100)}% of ALL clicks) — this is what pulls the site avg to ~position 1`);

  // Show DETAIL pages by position (independent of query wording)
  const pData = await gsc(token, {
    startDate: fmt(start), endDate: fmt(end), dimensions: ['page'], rowLimit: 25000,
  });
  const showPages = (pData.rows || [])
    .filter(r => /\/show\//.test(r.keys[0]))
    .map(r => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position }));
  summarize(showPages, 'SHOW DETAIL PAGES (/show/*)');

  // Worst-ranked review queries with real impression demand (page 2+ but people searching)
  const opportunities = reviewQueries
    .filter(r => r.position > 10 && r.impressions >= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25);
  console.log(`\n=== TOP OPPORTUNITIES: review queries on page 2+ with real demand (≥20 imp) ===`);
  for (const r of opportunities) {
    console.log(`  pos ${r.position.toFixed(1).padStart(5)} | ${String(r.impressions).padStart(4)} imp | ${String(r.clicks).padStart(3)} cl | ${r.query}`);
  }
  if (opportunities.length === 0) console.log('  (none — review queries with demand are mostly page 1)');
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
