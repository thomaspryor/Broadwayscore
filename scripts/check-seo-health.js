#!/usr/bin/env node
/**
 * Weekly SEO Health Check
 *
 * Checks index coverage, search performance, sitemap status,
 * new page indexing, stale page detection, target keyword rankings,
 * and Core Web Vitals via Google Search Console & PageSpeed APIs.
 *
 * Usage:
 *   node scripts/check-seo-health.js              # Full health check
 *   node scripts/check-seo-health.js --test-auth   # Test API access only
 *   node scripts/check-seo-health.js --dry-run     # Run checks, skip writes & alerts
 *
 * Environment:
 *   GOOGLE_INDEXING_KEY       Base64-encoded service account JSON key
 *   DISCORD_WEBHOOK_ALERTS    Discord webhook for alerts (optional in dry-run)
 */

const fs = require('fs');
const path = require('path');
const {
  getAccessToken, loadServiceAccount, readQuotaLedger, writeQuotaLedger,
  recordQuotaUsage, getQuotaRemaining,
  SCOPE_INDEXING, SCOPE_WEBMASTERS, SITE_HOST, SITE_URL_GSC,
} = require('./submit-google-indexing');

const HEALTH_PATH = path.join(__dirname, '../data/audit/seo-health.json');
const HISTORY_PATH = path.join(__dirname, '../data/audit/seo-performance-history.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');

// Target keywords to track weekly positions for
const TARGET_KEYWORDS = [
  'broadway show reviews',
  'best broadway shows',
  'best broadway shows 2026',
  'broadway ratings',
  'broadway show ratings',
  'broadway scorecard',
  'broadway musicals ranked',
  'best broadway musicals',
  'best broadway musicals 2026',
  'broadway shows closing soon',
  'new broadway shows',
  'new broadway shows 2026',
  'upcoming broadway shows',
  'broadway lottery shows',
  'broadway rush tickets',
  'broadway box office grosses',
  'best broadway plays',
  'broadway shows for kids',
  'hamilton vs wicked',
  'broadway shows for tourists',
];

// Key pages to check Core Web Vitals for (covers main page types)
const CWV_PAGES = [
  `${SITE_HOST}/`,
  `${SITE_HOST}/browse/best-broadway-musicals`,
  `${SITE_HOST}/show/hamilton`,
  `${SITE_HOST}/west-end`,
  `${SITE_HOST}/off-broadway`,
];

// Google's "Good" CWV absolute thresholds
const CWV_ABSOLUTE = {
  lcp: 2500,     // ms — Largest Contentful Paint (Good < 2.5s)
  cls: 0.1,      // Cumulative Layout Shift (Good < 0.1)
  inp: 200,      // ms — Interaction to Next Paint (Good < 200ms)
  lighthouseMin: 70,  // Lighthouse performance score floor
};

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const testAuthOnly = args.includes('--test-auth');

// --- HTTP helpers ---

async function gscFetch(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GSC API ${response.status}: ${text}`);
  }
  return response.json();
}

// --- Auth ---

async function testAuth(serviceAccount) {
  console.log('Testing authentication scopes...\n');
  let allOk = true;

  // Indexing scope
  try {
    await getAccessToken(serviceAccount, SCOPE_INDEXING);
    console.log('  Indexing scope: OK');
  } catch (err) {
    console.error(`  Indexing scope: FAILED - ${err.message}`);
    allOk = false;
  }

  // Webmasters scope - test with actual API call
  try {
    const token = await getAccessToken(serviceAccount, SCOPE_WEBMASTERS);
    const siteUrl = encodeURIComponent(SITE_URL_GSC);
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/sitemaps`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      console.log('  Webmasters scope: OK (sitemaps accessible)');
    } else {
      const text = await res.text();
      console.error(`  Webmasters scope: FAILED - ${res.status} ${text}`);
      console.error('\n  Ensure "Google Search Console API" is enabled in GCP project.');
      allOk = false;
    }
  } catch (err) {
    console.error(`  Webmasters scope: FAILED - ${err.message}`);
    allOk = false;
  }

  if (allOk) console.log('\nAll scopes verified.');
  return allOk;
}

// --- Check: Search Performance ---

async function checkSearchPerformance(token) {
  console.log('\n--- Search Performance ---');
  const siteUrl = encodeURIComponent(SITE_URL_GSC);

  // Last 7 days
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 3); // GSC data has ~3 day lag
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 7);

  // Prior 7 days
  const priorEnd = new Date(startDate);
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorStart.getDate() - 7);

  const fmt = d => d.toISOString().slice(0, 10);

  const [current, prior] = await Promise.all([
    gscFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
      token,
      { method: 'POST', body: JSON.stringify({ startDate: fmt(startDate), endDate: fmt(endDate), dimensions: [], rowLimit: 1 }) }
    ),
    gscFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
      token,
      { method: 'POST', body: JSON.stringify({ startDate: fmt(priorStart), endDate: fmt(priorEnd), dimensions: [], rowLimit: 1 }) }
    ),
  ]);

  const cur = current.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const prev = prior.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  console.log(`  Period: ${fmt(startDate)} to ${fmt(endDate)}`);
  console.log(`  Clicks: ${cur.clicks} (was ${prev.clicks})`);
  console.log(`  Impressions: ${cur.impressions} (was ${prev.impressions})`);
  console.log(`  CTR: ${(cur.ctr * 100).toFixed(1)}%`);
  console.log(`  Avg Position: ${cur.position.toFixed(1)}`);

  // Top queries
  let topQueries = [];
  try {
    const queryData = await gscFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
      token,
      { method: 'POST', body: JSON.stringify({ startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ['query'], rowLimit: 20 }) }
    );
    topQueries = (queryData.rows || []).map(r => ({
      query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10,
    }));
  } catch { /* non-critical */ }

  // Top pages
  let topPages = [];
  try {
    const pageData = await gscFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
      token,
      { method: 'POST', body: JSON.stringify({ startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ['page'], rowLimit: 20 }) }
    );
    topPages = (pageData.rows || []).map(r => ({
      page: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10,
    }));
  } catch { /* non-critical */ }

  return {
    period: { start: fmt(startDate), end: fmt(endDate) },
    clicks: cur.clicks,
    impressions: cur.impressions,
    ctr: Math.round(cur.ctr * 10000) / 10000,
    position: Math.round(cur.position * 10) / 10,
    priorClicks: prev.clicks,
    priorImpressions: prev.impressions,
    topQueries,
    topPages,
  };
}

// --- Check: Index Coverage (sample URLs via URL Inspection API) ---

async function checkIndexCoverage(token, sampleUrls) {
  console.log('\n--- Index Coverage ---');
  const siteUrl = SITE_URL_GSC;
  let indexed = 0;
  let notIndexed = 0;
  const issues = [];

  for (const url of sampleUrls) {
    try {
      const result = await fetch(
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inspectionUrl: url, siteUrl }),
        }
      );
      if (!result.ok) {
        const text = await result.text();
        if (result.status === 429) {
          console.log(`  Rate limited at ${indexed + notIndexed}/${sampleUrls.length} URLs. Stopping sample.`);
          break;
        }
        issues.push({ url, error: `${result.status}: ${text.slice(0, 100)}` });
        continue;
      }
      const data = await result.json();
      const verdict = data.inspectionResult?.indexStatusResult?.verdict;
      if (verdict === 'PASS') {
        indexed++;
      } else {
        notIndexed++;
        issues.push({ url, verdict, coverageState: data.inspectionResult?.indexStatusResult?.coverageState });
      }
      // Rate limit: 600/min = 10/sec, stay well under
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      issues.push({ url, error: err.message });
    }
  }

  const total = indexed + notIndexed;
  const rate = total > 0 ? Math.round((indexed / total) * 100) : 0;
  console.log(`  Sampled ${total} URLs: ${indexed} indexed, ${notIndexed} not indexed (${rate}% coverage)`);

  if (issues.length > 0 && issues.length <= 10) {
    issues.forEach(i => console.log(`  Issue: ${i.url} - ${i.verdict || i.error || 'unknown'}`));
  }

  return { indexed, notIndexed, total, rate, issues: issues.slice(0, 20) };
}

// --- Check: Sitemap Status ---

async function checkSitemapStatus(token) {
  console.log('\n--- Sitemap Status ---');
  const siteUrl = encodeURIComponent(SITE_URL_GSC);

  const data = await gscFetch(
    `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/sitemaps`,
    token
  );

  const sitemaps = data.sitemap || [];
  console.log(`  ${sitemaps.length} sitemap(s) found`);

  for (const sm of sitemaps) {
    const errors = sm.errors || 0;
    const warnings = sm.warnings || 0;
    const submitted = sm.contents?.map(c => `${c.type}: ${c.submitted}`).join(', ') || 'unknown';
    console.log(`  ${sm.path}: ${errors} errors, ${warnings} warnings (${submitted})`);
  }

  // Flag a stale root sitemap.xml submission. This site serves only sharded
  // sitemaps at /sitemap/N.xml (robots.txt lists all 9); Next never generates a
  // root /sitemap.xml, so a submitted `${SITE_HOST}/sitemap.xml` 404s and shows a
  // persistent (cosmetic) error in GSC. We cannot auto-delete it: the indexing
  // service account has read/inspect access but not sitemap-management permission
  // (DELETE /sitemaps returns 403). Removing it is a one-time manual step in the
  // GSC UI by a property Owner. We surface it here so it's diagnosable, but it does
  // not affect indexing (the 9 shards are submitted and discovered via robots.txt).
  const orphanPath = `${SITE_HOST}/sitemap.xml`;
  const orphan = sitemaps.find(sm => sm.path === orphanPath && (sm.errors || 0) > 0);
  if (orphan) {
    console.log(`  Note: stale orphan sitemap ${orphanPath} has ${orphan.errors} GSC error(s) — cosmetic, remove manually in GSC (SA lacks delete permission)`);
  }

  return {
    staleOrphanSitemap: Boolean(orphan),
    count: sitemaps.length,
    sitemaps: sitemaps.map(sm => ({
      path: sm.path,
      errors: sm.errors || 0,
      warnings: sm.warnings || 0,
      lastSubmitted: sm.lastSubmitted,
      lastDownloaded: sm.lastDownloaded,
    })),
  };
}

// --- Check: New Page Indexing ---

async function checkNewPages(token) {
  console.log('\n--- New Page Indexing ---');

  let shows;
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    shows = data.shows || data;
  } catch (err) {
    console.log('  Could not read shows.json, skipping new page check');
    return { checked: 0, indexed: 0, resubmitted: 0 };
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  const newShows = shows.filter(s => {
    if (!s.openingDate) return false;
    const d = new Date(s.openingDate);
    return d >= sevenDaysAgo && d <= twoDaysAgo;
  });

  if (newShows.length === 0) {
    console.log('  No shows opened in the last 2-7 days');
    return { checked: 0, indexed: 0, resubmitted: 0 };
  }

  console.log(`  ${newShows.length} show(s) opened recently, checking index status...`);

  let indexed = 0;
  let resubmitted = 0;
  const siteUrl = SITE_URL_GSC;

  for (const show of newShows) {
    const url = `${SITE_HOST}/show/${show.slug}`;
    try {
      const result = await fetch(
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inspectionUrl: url, siteUrl }),
        }
      );

      if (!result.ok) continue;
      const data = await result.json();
      const verdict = data.inspectionResult?.indexStatusResult?.verdict;

      if (verdict === 'PASS') {
        console.log(`  OK ${show.title} — indexed`);
        indexed++;
      } else {
        console.log(`  MISS ${show.title} — not indexed (${verdict}), requesting crawl...`);
        if (!dryRun) {
          const remaining = getQuotaRemaining();
          if (remaining > 0) {
            try {
              const indexToken = await getAccessToken(loadServiceAccount(), SCOPE_INDEXING);
              const submitRes = await fetch(
                'https://indexing.googleapis.com/v3/urlNotifications:publish',
                {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${indexToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url, type: 'URL_UPDATED' }),
                }
              );
              if (submitRes.ok) {
                recordQuotaUsage(url, 'new-page-check');
                resubmitted++;
              }
            } catch { /* non-critical */ }
          }
        }
      }
      await new Promise(r => setTimeout(r, 200));
    } catch { /* non-critical */ }
  }

  return { checked: newShows.length, indexed, resubmitted };
}

// --- Check: Stale Pages ---

async function checkStalePages(token) {
  console.log('\n--- Stale Page Detection ---');

  let shows;
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    shows = data.shows || data;
  } catch {
    console.log('  Could not read shows.json, skipping stale check');
    return { sampled: 0, stale: 0, resubmitted: 0 };
  }

  const activeShows = shows.filter(s => s.status === 'open' || s.status === 'previews');
  const urls = activeShows.map(s => `${SITE_HOST}/show/${s.slug}`);
  urls.push(
    `${SITE_HOST}/`, `${SITE_HOST}/rankings`, `${SITE_HOST}/critics`,
    `${SITE_HOST}/lotteries`, `${SITE_HOST}/box-office`, `${SITE_HOST}/biz`,
  );

  const sampleSize = Math.min(100, urls.length);
  const shuffled = urls.sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, sampleSize);

  console.log(`  Sampling ${sampleSize} URLs from ${urls.length} active pages...`);

  let stale = 0;
  let resubmitted = 0;
  const staleUrls = [];
  const siteUrl = SITE_URL_GSC;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  for (const url of sample) {
    try {
      const result = await fetch(
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inspectionUrl: url, siteUrl }),
        }
      );

      if (result.status === 429) {
        console.log(`  Rate limited. Stopping sample.`);
        break;
      }
      if (!result.ok) continue;

      const data = await result.json();
      const lastCrawl = data.inspectionResult?.indexStatusResult?.lastCrawlTime;
      if (lastCrawl && new Date(lastCrawl) < thirtyDaysAgo) {
        stale++;
        staleUrls.push(url);
      }
      await new Promise(r => setTimeout(r, 200));
    } catch { /* continue */ }
  }

  console.log(`  ${stale} stale pages found (last crawled >30 days ago)`);

  if (staleUrls.length > 0 && !dryRun) {
    const remaining = getQuotaRemaining();
    const budget = Math.min(staleUrls.length, remaining, 50);
    if (budget > 0) {
      console.log(`  Re-submitting ${budget} stale pages (${remaining} quota remaining)...`);
      try {
        const indexToken = await getAccessToken(loadServiceAccount(), SCOPE_INDEXING);
        for (let i = 0; i < budget; i++) {
          const res = await fetch(
            'https://indexing.googleapis.com/v3/urlNotifications:publish',
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${indexToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: staleUrls[i], type: 'URL_UPDATED' }),
            }
          );
          if (res.status === 429) {
            console.log(`  Rate limited at ${i}/${budget}. Stopping.`);
            break;
          }
          if (res.ok) {
            recordQuotaUsage(staleUrls[i], 'stale-check');
            resubmitted++;
          }
          await new Promise(r => setTimeout(r, 150));
        }
      } catch { /* non-critical */ }
    }
  }

  return { sampled: sample.length, stale, resubmitted };
}

// --- Check: High-Value Page Submission (use remaining quota) ---

async function submitHighValuePages(token) {
  console.log('\n--- High-Value Page Submission ---');

  const remaining = getQuotaRemaining();
  if (remaining < 10 || dryRun) {
    console.log(`  Skipping (${remaining} quota remaining${dryRun ? ', dry run' : ''})`);
    return { submitted: 0, skipped: 0 };
  }

  let shows;
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    shows = data.shows || data;
  } catch {
    console.log('  Could not read shows.json, skipping');
    return { submitted: 0, skipped: 0 };
  }

  // Load submission history for backoff
  const ledger = readQuotaLedger();
  const submissionCounts = {};
  for (const sub of (ledger.submissions || [])) {
    submissionCounts[sub.url] = (submissionCounts[sub.url] || 0) + 1;
  }

  // Priority: open/previews shows, then key hub pages
  const highValueUrls = [
    // Active shows first
    ...shows
      .filter(s => s.status === 'open' || s.status === 'previews')
      .map(s => `${SITE_HOST}/show/${s.slug}`),
    // Key landing pages
    `${SITE_HOST}/`,
    `${SITE_HOST}/rankings`,
    `${SITE_HOST}/best-value`,
    `${SITE_HOST}/lotteries`,
    `${SITE_HOST}/rush`,
    `${SITE_HOST}/box-office`,
    `${SITE_HOST}/tony-awards`,
    `${SITE_HOST}/west-end`,
    `${SITE_HOST}/off-broadway`,
  ];

  // Filter out pages submitted 3+ times (backoff)
  const candidates = highValueUrls.filter(url => {
    const count = submissionCounts[url] || 0;
    return count < 3;
  });

  const budget = Math.min(candidates.length, remaining, 50);
  if (budget === 0) {
    console.log('  No candidates remaining (all at backoff limit)');
    return { submitted: 0, skipped: highValueUrls.length - candidates.length };
  }

  console.log(`  Submitting up to ${budget} high-value pages (${candidates.length} eligible, ${highValueUrls.length - candidates.length} at backoff limit)...`);

  let submitted = 0;
  try {
    const indexToken = await getAccessToken(loadServiceAccount(), SCOPE_INDEXING);
    for (let i = 0; i < budget; i++) {
      const res = await fetch(
        'https://indexing.googleapis.com/v3/urlNotifications:publish',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${indexToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: candidates[i], type: 'URL_UPDATED' }),
        }
      );
      if (res.status === 429) {
        console.log(`  Rate limited at ${i}/${budget}. Stopping.`);
        break;
      }
      if (res.ok) {
        recordQuotaUsage(candidates[i], 'high-value');
        submitted++;
      }
      await new Promise(r => setTimeout(r, 150));
    }
  } catch { /* non-critical */ }

  console.log(`  Submitted ${submitted} high-value pages`);
  return { submitted, skipped: highValueUrls.length - candidates.length };
}

// --- Check: Target Keyword Rankings ---

async function checkTargetKeywords(token) {
  console.log('\n--- Target Keyword Rankings ---');
  const siteUrl = encodeURIComponent(SITE_URL_GSC);

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 3);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 7);
  const fmt = d => d.toISOString().slice(0, 10);

  const rankings = [];

  try {
    const data = await gscFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
      token,
      {
        method: 'POST',
        // GSC API doesn't support OR filter groups — fetch all queries, filter client-side
        body: JSON.stringify({
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ['query'],
          rowLimit: 5000,
        }),
      }
    );

    const rows = data.rows || [];
    const targetSet = new Set(TARGET_KEYWORDS);
    const foundKeywords = new Set();

    for (const row of rows) {
      const keyword = row.keys[0];
      if (!targetSet.has(keyword)) continue;
      foundKeywords.add(keyword);
      rankings.push({
        keyword,
        position: Math.round(row.position * 10) / 10,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: Math.round(row.ctr * 10000) / 10000,
      });
    }

    for (const kw of TARGET_KEYWORDS) {
      if (!foundKeywords.has(kw)) {
        rankings.push({ keyword: kw, position: null, clicks: 0, impressions: 0, ctr: 0 });
      }
    }

    rankings.sort((a, b) => {
      if (a.position === null && b.position === null) return 0;
      if (a.position === null) return 1;
      if (b.position === null) return -1;
      return a.position - b.position;
    });

    const ranked = rankings.filter(r => r.position !== null);
    console.log(`  ${ranked.length}/${TARGET_KEYWORDS.length} keywords ranking`);
    for (const r of ranked.slice(0, 10)) {
      console.log(`  ${r.keyword}: pos ${r.position} (${r.clicks} clicks, ${r.impressions} imp)`);
    }
  } catch (err) {
    console.log(`  Error fetching keyword rankings: ${err.message}`);
  }

  return rankings;
}

// --- Check: Core Web Vitals (via PageSpeed Insights API) ---

async function checkCoreWebVitals() {
  console.log('\n--- Core Web Vitals ---');
  const results = [];

  // PageSpeed without an API key shares a tiny anonymous per-consumer quota that is
  // routinely exhausted (429 "Queries per day"), so CWV silently came back empty.
  // With PAGESPEED_API_KEY set, calls bill to our project's quota (25k/day) and work.
  const psKey = (process.env.PAGESPEED_API_KEY || '').trim();
  if (!psKey) {
    console.log('  WARN: PAGESPEED_API_KEY not set — using anonymous quota (often 429, CWV may be empty)');
  }

  for (const url of CWV_PAGES) {
    try {
      const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=PERFORMANCE&strategy=MOBILE${psKey ? `&key=${psKey}` : ''}`;
      const response = await fetch(apiUrl);

      if (!response.ok) {
        if (response.status === 429) {
          console.log(`  Rate limited on PageSpeed API. Stopping CWV check.`);
          break;
        }
        console.log(`  Failed for ${url}: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const crux = data.loadingExperience?.metrics || {};
      const lighthouse = data.lighthouseResult?.audits || {};

      const cwv = {
        url,
        lcp: crux.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
        fid: crux.FIRST_INPUT_DELAY_MS?.percentile ?? null,
        cls: crux.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
          ? crux.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
          : null,
        inp: crux.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
        performanceScore: data.lighthouseResult?.categories?.performance?.score != null
          ? Math.round(data.lighthouseResult.categories.performance.score * 100)
          : null,
        lcpLab: lighthouse['largest-contentful-paint']?.numericValue
          ? Math.round(lighthouse['largest-contentful-paint'].numericValue)
          : null,
        clsLab: lighthouse['cumulative-layout-shift']?.numericValue ?? null,
        tbt: lighthouse['total-blocking-time']?.numericValue
          ? Math.round(lighthouse['total-blocking-time'].numericValue)
          : null,
      };

      results.push(cwv);
      console.log(`  ${url}:`);
      if (cwv.performanceScore !== null) console.log(`    Lighthouse Score: ${cwv.performanceScore}/100`);
      if (cwv.lcp !== null) console.log(`    LCP (field): ${cwv.lcp}ms`);
      if (cwv.inp !== null) console.log(`    INP (field): ${cwv.inp}ms`);
      if (cwv.cls !== null) console.log(`    CLS (field): ${cwv.cls}`);
      if (cwv.lcpLab !== null) console.log(`    LCP (lab): ${cwv.lcpLab}ms`);
      if (cwv.tbt !== null) console.log(`    TBT (lab): ${cwv.tbt}ms`);
    } catch (err) {
      console.log(`  Error for ${url}: ${err.message}`);
    }
  }

  return results;
}

// --- Anomaly Detection ---

function detectAnomalies(currentMetrics, history) {
  const issues = [];

  if (history.length < 4) {
    console.log('\n--- Anomaly Detection: Skipping (need 4+ weeks of baseline) ---');
    return issues;
  }

  console.log('\n--- Anomaly Detection ---');

  const recent4 = history.slice(-4);
  const avgClicks = recent4.reduce((s, w) => s + w.clicks, 0) / 4;
  const avgImpressions = recent4.reduce((s, w) => s + w.impressions, 0) / 4;
  const avgPosition = recent4.reduce((s, w) => s + w.position, 0) / 4;

  const clicksDrop = avgClicks > 0 ? (avgClicks - currentMetrics.clicks) / avgClicks : 0;
  const impressionsDrop = avgImpressions > 0 ? (avgImpressions - currentMetrics.impressions) / avgImpressions : 0;
  const positionIncrease = currentMetrics.position - avgPosition;

  let seasonallyExpected = false;
  if (history.length >= 52) {
    const lastYear = history[history.length - 52];
    if (lastYear) {
      const lastYearClicksDiff = Math.abs(currentMetrics.clicks - lastYear.clicks) / Math.max(lastYear.clicks, 1);
      if (lastYearClicksDiff < 0.3) {
        seasonallyExpected = true;
      }
    }
  }

  if (clicksDrop > 0.25) {
    // Event-recede guard: a clicks drop while impressions are at/above the 4-week
    // avg and position is stable/improving is a CTR/query-mix effect, not a ranking
    // loss. This is what happens the week after a traffic spike recedes (Tony Awards,
    // Oliviers, big opening nights inflate the baseline with high-CTR event queries;
    // the next normal week then reads as a "drop"). A real SEO regression — deindexing,
    // a penalty, lost rankings — moves impressions DOWN and/or position WORSE, so this
    // guard never suppresses those. The seasonal (YoY) check above only fires at 52+
    // weeks of history; this covers the gap before then.
    const impressionsHealthy = avgImpressions > 0 && currentMetrics.impressions >= avgImpressions;
    const positionHealthy = positionIncrease <= 2;
    if (seasonallyExpected) {
      console.log(`  Clicks down ${Math.round(clicksDrop * 100)}% vs 4-week avg, but matches seasonal pattern — suppressed`);
    } else if (impressionsHealthy && positionHealthy) {
      console.log(`  Clicks down ${Math.round(clicksDrop * 100)}% vs 4-week avg, but impressions (${currentMetrics.impressions} vs avg ${Math.round(avgImpressions)}) and position (${currentMetrics.position} vs avg ${avgPosition.toFixed(1)}) are healthy — CTR/query-mix shift, suppressed`);
    } else {
      issues.push({ type: 'clicks_drop', severity: 'error', message: `Clicks down ${Math.round(clicksDrop * 100)}% vs 4-week avg (${currentMetrics.clicks} vs avg ${Math.round(avgClicks)})` });
      console.log(`  ALERT: ${issues[issues.length - 1].message}`);
    }
  }

  if (impressionsDrop > 0.30) {
    // Clicks + position guard: an impressions drop with stable clicks and stable
    // position usually means Google stopped showing low-CTR long-tail queries —
    // healthy churn, not an SEO problem. Only alert when click outcomes also moved.
    const clicksHealthy = clicksDrop < 0.15;
    const positionHealthy = positionIncrease <= 2;
    if (seasonallyExpected) {
      console.log(`  Impressions down ${Math.round(impressionsDrop * 100)}% vs 4-week avg, but matches seasonal pattern — suppressed`);
    } else if (clicksHealthy && positionHealthy) {
      console.log(`  Impressions down ${Math.round(impressionsDrop * 100)}% vs 4-week avg, but clicks (${currentMetrics.clicks} vs avg ${Math.round(avgClicks)}, ${Math.round(clicksDrop * 100)}% drop) and position (${currentMetrics.position} vs avg ${avgPosition.toFixed(1)}) are stable — suppressed`);
    } else {
      issues.push({ type: 'impressions_drop', severity: 'error', message: `Impressions down ${Math.round(impressionsDrop * 100)}% vs 4-week avg (${currentMetrics.impressions} vs avg ${Math.round(avgImpressions)})` });
      console.log(`  ALERT: ${issues[issues.length - 1].message}`);
    }
  }

  if (positionIncrease > 5) {
    issues.push({ type: 'position_worse', severity: 'warning', message: `Avg position worsened by ${positionIncrease.toFixed(1)} spots (${currentMetrics.position} vs avg ${avgPosition.toFixed(1)})` });
    console.log(`  ALERT: ${issues[issues.length - 1].message}`);
  }

  if (issues.length === 0) {
    console.log('  No anomalies detected');
  }

  return issues;
}

function detectCWVAnomalies(currentCWV, history) {
  const issues = [];
  if (!currentCWV || currentCWV.length === 0) return issues;

  // Absolute threshold checks (always run, even without history)
  for (const current of currentCWV) {
    const shortUrl = current.url.replace(SITE_HOST, '');
    if (current.lcp && current.lcp > CWV_ABSOLUTE.lcp) {
      issues.push({ type: 'cwv_lcp_absolute', severity: 'warning', message: `LCP exceeds Good threshold on ${shortUrl}: ${current.lcp}ms (limit: ${CWV_ABSOLUTE.lcp}ms)` });
    }
    if (current.cls != null && current.cls > CWV_ABSOLUTE.cls) {
      issues.push({ type: 'cwv_cls_absolute', severity: 'warning', message: `CLS exceeds Good threshold on ${shortUrl}: ${current.cls} (limit: ${CWV_ABSOLUTE.cls})` });
    }
    if (current.inp && current.inp > CWV_ABSOLUTE.inp) {
      issues.push({ type: 'cwv_inp_absolute', severity: 'warning', message: `INP exceeds Good threshold on ${shortUrl}: ${current.inp}ms (limit: ${CWV_ABSOLUTE.inp}ms)` });
    }
    if (current.performanceScore != null && current.performanceScore < CWV_ABSOLUTE.lighthouseMin) {
      // Lab Lighthouse is a synthetic, heavily-throttled score (slow-4G + 4x CPU). A
      // low value while field/CrUX data is healthy means real users are fine — escalate
      // to error (CRITICAL email) ONLY when field LCP also breaches Good; otherwise warn
      // (digest). Prevents weekly CRITICAL pages for borderline lab scores (e.g. homepage
      // lab 69 with field LCP 797ms) while still emailing when real users are hurt.
      const fieldUnhealthy = current.lcp != null && current.lcp > CWV_ABSOLUTE.lcp;
      issues.push({
        type: 'cwv_lighthouse_low',
        severity: fieldUnhealthy ? 'error' : 'warning',
        message: `Lighthouse score below ${CWV_ABSOLUTE.lighthouseMin} on ${shortUrl}: ${current.performanceScore}/100${fieldUnhealthy ? ` + field LCP ${current.lcp}ms over ${CWV_ABSOLUTE.lcp}ms` : ' (lab only — field CWV healthy)'}`,
      });
    }
  }

  // Relative regression checks (need history)
  if (history.length < 2) return issues;
  const priorWeek = history[history.length - 1];
  if (!priorWeek.coreWebVitals || priorWeek.coreWebVitals.length === 0) return issues;

  for (const current of currentCWV) {
    const prior = priorWeek.coreWebVitals.find(p => p.url === current.url);
    if (!prior) continue;

    const shortUrl = current.url.replace(SITE_HOST, '');
    if (current.lcp && prior.lcp && current.lcp - prior.lcp > 500) {
      issues.push({ type: 'cwv_lcp_regression', severity: 'warning', message: `LCP regressed on ${shortUrl}: ${current.lcp}ms (was ${prior.lcp}ms)` });
    }
    if (current.cls != null && prior.cls != null && current.cls - prior.cls > 0.05) {
      issues.push({ type: 'cwv_cls_regression', severity: 'warning', message: `CLS regressed on ${shortUrl}: ${current.cls} (was ${prior.cls})` });
    }
    if (current.performanceScore != null && prior.performanceScore != null && prior.performanceScore - current.performanceScore > 10) {
      issues.push({ type: 'cwv_lighthouse_drop', severity: 'warning', message: `Lighthouse score dropped on ${shortUrl}: ${current.performanceScore} (was ${prior.performanceScore})` });
    }
  }

  return issues;
}

// --- Persistence ---

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveSnapshot(healthData, performanceData) {
  const dir = path.dirname(HEALTH_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(HEALTH_PATH, JSON.stringify(healthData, null, 2) + '\n');
  console.log(`\nSaved health snapshot to ${HEALTH_PATH}`);

  const history = loadHistory();
  history.push({
    date: healthData.lastChecked,
    clicks: performanceData.clicks,
    impressions: performanceData.impressions,
    ctr: performanceData.ctr,
    position: performanceData.position,
    topQueries: performanceData.topQueries.slice(0, 10),
    topPages: performanceData.topPages.slice(0, 10),
    targetKeywords: healthData.targetKeywords || [],
    coreWebVitals: healthData.coreWebVitals || [],
  });
  while (history.length > 52) history.shift();
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
  console.log(`Saved performance history (${history.length} weeks) to ${HISTORY_PATH}`);
}

// --- Alerting ---

async function sendAlerts(healthData, anomalies) {
  if (dryRun) {
    console.log('\n[Dry run] Would send alerts for:', anomalies.length, 'issue(s)');
    return;
  }

  if (anomalies.length === 0) return;

  try {
    const { sendAlert } = require('./lib/discord-notify');

    const hasErrors = anomalies.some(a => a.severity === 'error');
    const fields = anomalies.map(a => ({
      name: a.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      value: a.message,
      inline: false,
    }));

    if (healthData.indexCoverage) {
      fields.push({ name: 'Index Coverage', value: `${healthData.indexCoverage.rate}% (${healthData.indexCoverage.indexed}/${healthData.indexCoverage.total})`, inline: true });
    }

    await sendAlert({
      title: `SEO Health Check — ${anomalies.length} Issue${anomalies.length > 1 ? 's' : ''} Detected`,
      description: hasErrors
        ? 'Significant search performance changes detected. Review GSC for details.'
        : 'Minor SEO issues detected.',
      severity: hasErrors ? 'error' : 'warning',
      email: hasErrors,
      fields: fields.slice(0, 10),
    });
  } catch (err) {
    console.error('[Alert] Failed to send:', err.message);
  }
}

// Show pages to monitor for rich results verdict (confirmed verdict:FAIL before 2026-06-07 fix)
const RICH_RESULTS_SLUGS = [
  'schmigadoon',
  'the-lost-boys',
  'cats-the-jellicle-ball',
  'death-of-a-salesman-2024',
  'dog-day-afternoon',
];

async function checkRichResults(token) {
  console.log('\n--- Rich Results Verdict ---');
  const results = [];
  for (const slug of RICH_RESULTS_SLUGS) {
    const inspectionUrl = `${SITE_HOST}/show/${slug}`;
    try {
      const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
        method: 'POST',
        // NO X-Goog-User-Project header: service-account JWT auth bills quota to the
        // SA's own project. Pointing the header at a different project (cowriter-27499)
        // the SA isn't a member of returns 403 on every call — this check never worked
        // since it was added. The other urlInspection calls above omit it and succeed.
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inspectionUrl, siteUrl: SITE_URL_GSC }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.log(`  ${slug}: ERROR ${res.status} — ${text.slice(0, 80)}`);
        results.push({ slug, verdict: 'ERROR', error: `${res.status}` });
        continue;
      }
      const data = await res.json();
      const verdict = data.inspectionResult?.richResultsResult?.verdict || 'UNKNOWN';
      const detectedItems = data.inspectionResult?.richResultsResult?.detectedItems || [];
      const types = detectedItems.map(i => i.richResultType).join(', ') || 'none';
      console.log(`  ${slug}: ${verdict} (types: ${types})`);
      results.push({ slug, verdict, types });
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`  ${slug}: FETCH_ERROR — ${err.message}`);
      results.push({ slug, verdict: 'ERROR', error: err.message });
    }
  }
  const passing = results.filter(r => r.verdict === 'PASS').length;
  const failing = results.filter(r => r.verdict === 'FAIL').length;
  console.log(`  Result: ${passing} PASS, ${failing} FAIL, ${results.length - passing - failing} other`);
  return { results, passing, failing };
}

// --- Main ---

async function main() {
  console.log('=== Weekly SEO Health Check ===\n');

  const serviceAccount = loadServiceAccount();

  if (testAuthOnly) {
    const ok = await testAuth(serviceAccount);
    process.exit(ok ? 0 : 1);
  }

  let wmToken;
  try {
    wmToken = await getAccessToken(serviceAccount, SCOPE_WEBMASTERS);
    console.log('Authenticated with Google (webmasters scope).');
  } catch (err) {
    console.error(`Authentication failed: ${err.message}`);
    console.error('Ensure GOOGLE_INDEXING_KEY is set and Search Console API is enabled in GCP.');
    process.exit(1);
  }

  try {
    const siteUrl = encodeURIComponent(SITE_URL_GSC);
    const testRes = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/sitemaps`,
      { headers: { Authorization: `Bearer ${wmToken}` } }
    );
    if (!testRes.ok) {
      const text = await testRes.text();
      console.error(`GSC API access denied (${testRes.status}): ${text}`);
      console.error('Check that Search Console API is enabled and service account has access.');
      process.exit(1);
    }
    console.log('GSC API access verified.\n');
  } catch (err) {
    console.error(`GSC API test failed: ${err.message}`);
    process.exit(1);
  }

  // Run all checks
  const performance = await checkSearchPerformance(wmToken);
  const sitemapStatus = await checkSitemapStatus(wmToken);

  let sampleUrls;
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = data.shows || data;
    const showUrls = shows.map(s => `${SITE_HOST}/show/${s.slug}`);
    const shuffled = showUrls.sort(() => Math.random() - 0.5);
    sampleUrls = shuffled.slice(0, 50);
  } catch {
    sampleUrls = [`${SITE_HOST}/`, `${SITE_HOST}/show/hamilton`];
  }

  const indexCoverage = await checkIndexCoverage(wmToken, sampleUrls);
  const newPages = await checkNewPages(wmToken);
  const stalePages = await checkStalePages(wmToken);
  const highValuePages = await submitHighValuePages(wmToken);
  const targetKeywords = await checkTargetKeywords(wmToken);
  const coreWebVitals = await checkCoreWebVitals();
  const richResults = await checkRichResults(wmToken);

  // Anomaly detection
  const history = loadHistory();
  const anomalies = [
    ...detectAnomalies(performance, history),
    ...detectCWVAnomalies(coreWebVitals, history),
  ];

  // Build health snapshot
  const healthData = {
    lastChecked: new Date().toISOString().slice(0, 10),
    performance: {
      clicks: performance.clicks,
      impressions: performance.impressions,
      ctr: performance.ctr,
      position: performance.position,
      priorClicks: performance.priorClicks,
      priorImpressions: performance.priorImpressions,
    },
    indexCoverage,
    sitemapStatus,
    newPages,
    stalePages,
    targetKeywords: targetKeywords.filter(r => r.position !== null).slice(0, 20),
    coreWebVitals,
    anomalies,
    quotaUsedToday: readQuotaLedger().used,
    richResults: richResults.results,
  };

  // Alert if any monitored show page is still FAIL after the 2026-06-07 @graph fix
  if (richResults.failing > 0) {
    anomalies.push({
      type: 'rich_results_fail',
      severity: 'warning',
      message: `${richResults.failing} show page(s) still have verdict:FAIL in Google rich results`,
      pages: richResults.results.filter(r => r.verdict === 'FAIL').map(r => r.slug),
    });
  }

  if (!dryRun) {
    saveSnapshot(healthData, performance);
  } else {
    console.log('\n[Dry run] Skipping file saves');
  }

  await sendAlerts(healthData, anomalies);

  // Summary
  console.log('\n=== Summary ===');
  console.log(`  Performance: ${performance.clicks} clicks, ${performance.impressions} impressions`);
  console.log(`  Index Coverage: ${indexCoverage.rate}% (${indexCoverage.indexed}/${indexCoverage.total})`);
  console.log(`  Sitemaps: ${sitemapStatus.count}`);
  console.log(`  New Pages: ${newPages.checked} checked, ${newPages.indexed} indexed`);
  console.log(`  Stale Pages: ${stalePages.stale}/${stalePages.sampled} stale, ${stalePages.resubmitted} resubmitted`);
  console.log(`  High-Value Submissions: ${highValuePages.submitted} submitted, ${highValuePages.skipped} at backoff limit`);
  console.log(`  Target Keywords: ${targetKeywords.filter(r => r.position !== null).length}/${TARGET_KEYWORDS.length} ranking`);
  console.log(`  Core Web Vitals: ${coreWebVitals.length} pages checked`);
  console.log(`  Rich Results: ${richResults.passing}/${RICH_RESULTS_SLUGS.length} PASS${richResults.failing > 0 ? ` ⚠ ${richResults.failing} FAIL` : ''}`);
  console.log(`  Anomalies: ${anomalies.length}`);
  console.log(`  Indexing Quota Used: ${readQuotaLedger().used}/200`);

  if (anomalies.some(a => a.severity === 'error')) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('SEO health check failed:', err);
    process.exit(1);
  });
}

module.exports = { detectAnomalies, detectCWVAnomalies };
