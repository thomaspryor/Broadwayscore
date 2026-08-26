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
const { findCWVFieldAcknowledgment } = require('./lib/seo-cwv-ack');
const { summarizeBotQueries, botDropExplainsDecline, isBotQueryRow } = require('./lib/seo-bot-query-signature');
const { annotateFieldScope, scopeChanged } = require('./lib/seo-cwv-field-scope');

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

// Static key pages to check Core Web Vitals for (covers main page types).
// Show pages are appended dynamically — see sampleShowPages() below.
const CWV_STATIC_PAGES = [
  `${SITE_HOST}/`,
  // /browse/best-broadway-musicals now 308-redirects to /guides/best-broadway-musicals
  // (guides feature migration) — PSI/Lighthouse was scoring the redirect stub, not the
  // real page, which is a plausible contributor to the erratic scores that triggered
  // card #311 (2026-07-21 CWV regression false-alarm investigation).
  `${SITE_HOST}/guides/best-broadway-musicals`,
  `${SITE_HOST}/west-end`,
  `${SITE_HOST}/off-broadway`,
];

// Show pages are ~2800 of ~2900 routes and the heaviest page type on the site,
// but CWV_PAGES used to hardcode exactly one of them (/show/hamilton) — so the
// same single page got checked every week and every other show page's CWV was
// unmonitored. Card #419: hamilton was found carrying 645KB of RSC payload;
// sibling show pages had the identical defect with nothing to catch it.
//
// sampleShowPages() picks a rotating, stratified sample instead: bucketed by
// category (broadway/off-broadway/west-end/off-west-end/regional, so every
// market segment is represented every run) and rotated by a monotonically
// increasing week index (days-since-epoch / 7, NOT the 1-53 ISO week-of-year —
// that would reset every January and re-visit the same ~10 shows per category
// forever), so re-running within the same week is reproducible (stable for
// tests/debugging) while successive weeks work through the full catalog.
const SHOW_PAGE_SAMPLE_SIZE = 12;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

function getRotationIndex(date = new Date()) {
  return Math.floor(date.getTime() / MS_PER_WEEK);
}

function sampleShowPages(shows, { sampleSize = SHOW_PAGE_SAMPLE_SIZE, weekIndex = getRotationIndex() } = {}) {
  const eligible = (Array.isArray(shows) ? shows : []).filter(s => s && typeof s.slug === 'string' && s.slug);
  if (eligible.length === 0) return [];

  const byCategory = new Map();
  for (const show of eligible) {
    const cat = typeof show.category === 'string' && show.category ? show.category : 'unknown';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(show);
  }
  // Stable sort within each bucket so the rotation is reproducible run to run.
  for (const list of byCategory.values()) list.sort((a, b) => a.slug.localeCompare(b.slug));

  const categories = [...byCategory.keys()].sort();
  const perCategory = Math.max(1, Math.floor(sampleSize / categories.length));
  const picks = [];
  for (const cat of categories) {
    const list = byCategory.get(cat);
    for (let i = 0; i < perCategory; i++) {
      picks.push(list[(weekIndex * perCategory + i) % list.length].slug);
    }
  }
  // De-dupe (small categories can wrap onto the same slug twice in one run).
  // The cap is the larger of sampleSize and categories.length so that having
  // more categories than the sample budget (perCategory floors to 1 each)
  // never truncates away whichever categories sort last — every category
  // picked above must survive into the result.
  return [...new Set(picks)].slice(0, Math.max(sampleSize, categories.length));
}

function buildCWVPages(shows) {
  const showPages = sampleShowPages(shows).map(slug => `${SITE_HOST}/show/${slug}`);
  return [...CWV_STATIC_PAGES, ...showPages];
}

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

// Node's fetch has NO default timeout: a stalled external API (PageSpeed, GSC) would
// otherwise hang the entire weekly run until GitHub's 360-min job ceiling — the check
// silently never completes and never alerts. Wrap every outbound call with an
// AbortController so one dead connection can't stall the whole run. (Observed
// 2026-06-21: a run sat 20+ min on the script step before being cancelled.)
async function fetchT(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await globalThis.fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function gscFetch(url, token, options = {}) {
  const response = await fetchT(url, {
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
    const res = await fetchT(
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

  // Bot-shaped query census for this week and the prior one. Rank-trackers and
  // scrapers issue `site:` / stacked-exact-phrase queries that earn thousands of
  // impressions and zero clicks; when such a cluster switches on or off, site
  // impressions swing 30%+ with no change in click outcomes. Measuring it here
  // is what lets detectPerformanceAnomalies() tell that apart from a real
  // ranking loss instead of paging the owner (card #530).
  // 25000 is the API maximum. The previous 5000 sat only 3% above the real row
  // count for a 7-day window (4,867 on 2026-07-01..08), so one busy week would
  // have silently truncated the census — and a truncated census corrupts BOTH
  // the bot figure and the organic figure it is compared against, turning the
  // suppression into a measurement of which rows came back. We record whether
  // the cap was hit and refuse to suppress on a truncated sample.
  const QUERY_ROW_LIMIT = 25000;
  let botSignature = null;
  try {
    const [curQ, priorQ] = await Promise.all([
      gscFetch(
        `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
        token,
        { method: 'POST', body: JSON.stringify({ startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ['query'], rowLimit: QUERY_ROW_LIMIT }) }
      ),
      gscFetch(
        `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
        token,
        { method: 'POST', body: JSON.stringify({ startDate: fmt(priorStart), endDate: fmt(priorEnd), dimensions: ['query'], rowLimit: QUERY_ROW_LIMIT }) }
      ),
    ]);
    const curRows = curQ.rows || [];
    const priorRows = priorQ.rows || [];
    const curBots = summarizeBotQueries(curRows);
    const priorBots = summarizeBotQueries(priorRows);
    // An empty row set on either side is not a zero census, it is a missing one.
    const missing = curRows.length === 0 || priorRows.length === 0;
    const truncated = curRows.length >= QUERY_ROW_LIMIT || priorRows.length >= QUERY_ROW_LIMIT || missing;
    botSignature = {
      botImpressions: curBots.botImpressions,
      botQueries: curBots.botQueries,
      botShare: Math.round(curBots.botShare * 10000) / 10000,
      namedImpressions: curBots.totalImpressions,
      organicImpressions: curBots.organicImpressions,
      priorBotImpressions: priorBots.botImpressions,
      priorOrganicImpressions: priorBots.organicImpressions,
      truncated,
      examples: curBots.examples.length ? curBots.examples : priorBots.examples,
    };
    console.log(`  Bot-shaped queries: ${curBots.botQueries} queries / ${curBots.botImpressions} impressions (was ${priorBots.botImpressions}), ${(curBots.botShare * 100).toFixed(1)}% of named impressions`);
    console.log(`  Organic (named) impressions: ${curBots.organicImpressions} (was ${priorBots.organicImpressions})${truncated ? ' — CENSUS UNUSABLE (row cap hit or empty response)' : ''}`);
  } catch { /* non-critical — alerting falls back to the clicks+position guard */ }

  return {
    period: { start: fmt(startDate), end: fmt(endDate) },
    clicks: cur.clicks,
    impressions: cur.impressions,
    ctr: Math.round(cur.ctr * 10000) / 10000,
    position: Math.round(cur.position * 10) / 10,
    priorClicks: prev.clicks,
    priorImpressions: prev.impressions,
    botSignature,
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
      const result = await fetchT(
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
      const result = await fetchT(
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
              const submitRes = await fetchT(
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

  // 30, not 100: each URL is a sequential urlInspection call (~200ms gap + API
  // latency). On slow-API days 100 stale + 50 index samples pushed the whole run to
  // ~25 min (against the 25-min job cap). 30 random samples still surfaces systemic
  // staleness while keeping the weekly run comfortably under budget.
  const sampleSize = Math.min(30, urls.length);
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
      const result = await fetchT(
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
          const res = await fetchT(
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
      const res = await fetchT(
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

// --- Check: Review-Intent Query Rankings (the de-branded truth) ---

// Position buckets — competition-rank semantics, lower = better.
function rankBucketOf(pos) {
  if (pos <= 3) return 'top3';
  if (pos <= 10) return 'page1';   // 4-10
  if (pos <= 20) return 'page2';   // 11-20
  return 'beyond';                  // 21+
}

// The site-wide average position is brand-skewed and misleading: "broadway
// scorecard" ranks #1 and is ~19% of all clicks, dragging the mean to ~9.6 while
// real "[show] reviews" queries actually sit at ~14.7 (71% on page 2 or worse).
// Reporting the headline number as "strong" is exactly the false-confidence trap
// this check exists to prevent — so we track the de-branded review-intent
// distribution explicitly. No NEW alert (avoids more false positives); this is a
// tracked metric surfaced in the summary + snapshot so the honest number is always
// in front of whoever reads the report.
async function checkReviewIntentRankings(token) {
  console.log('\n--- Review-Intent Query Rankings (de-branded) ---');
  const siteUrl = encodeURIComponent(SITE_URL_GSC);

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 3);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28); // 28d for a stable sample of long-tail show queries
  const fmt = d => d.toISOString().slice(0, 10);

  let rows = [];
  try {
    const data = await gscFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
      token,
      { method: 'POST', body: JSON.stringify({ startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ['query'], rowLimit: 25000 }) }
    );
    rows = data.rows || [];
  } catch (err) {
    console.log(`  Error fetching queries: ${err.message}`);
    return null;
  }

  // Exclude bot-shaped zero-click queries before averaging. This is the metric
  // memory/feedback_seo_site_avg_position_is_brand_skewed.md says to trust for
  // ranking quality, precisely because the site-wide average is junk — so it is
  // the one number that must not be quietly corrupted the way the site average
  // was in 2026-07 (task #530). Today's scraper queries carry "show score", not
  // "review", so nothing is filtered out yet; this keeps it that way if the next
  // one uses review-intent phrasing.
  const botRows = rows.filter(isBotQueryRow).length;
  const reviewRows = rows
    .filter(r => /\breviews?\b/i.test(r.keys[0]))
    .filter(r => !isBotQueryRow(r))
    .map(r => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position }));
  if (botRows > 0) console.log(`  (excluded ${botRows} bot-shaped zero-click quer${botRows === 1 ? 'y' : 'ies'} from the corpus before filtering)`);

  if (reviewRows.length === 0) {
    console.log('  No review-intent queries found');
    return { queries: 0 };
  }

  const buckets = { top3: 0, page1: 0, page2: 0, beyond: 0 };
  let totImp = 0, wPos = 0, totClicks = 0;
  for (const r of reviewRows) {
    buckets[rankBucketOf(r.position)]++;
    totImp += r.impressions;
    wPos += r.position * r.impressions;
    totClicks += r.clicks;
  }
  const avgPosition = totImp > 0 ? Math.round((wPos / totImp) * 10) / 10 : 0;
  const page1Share = Math.round(((buckets.top3 + buckets.page1) / reviewRows.length) * 100);

  // Top page-2+ opportunities with real demand — the actionable fix list.
  const opportunities = reviewRows
    .filter(r => r.position > 10 && r.impressions >= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)
    .map(r => ({ query: r.query, position: Math.round(r.position * 10) / 10, impressions: r.impressions, clicks: r.clicks }));

  console.log(`  ${reviewRows.length} review-intent queries | impression-weighted avg position ${avgPosition} | ${page1Share}% on page 1`);
  console.log(`  Buckets: top3 ${buckets.top3} | page1(4-10) ${buckets.page1} | page2(11-20) ${buckets.page2} | beyond(21+) ${buckets.beyond}`);
  console.log(`  ${opportunities.length} page-2+ opportunities with real demand (≥20 imp)`);

  return {
    queries: reviewRows.length,
    avgPosition,
    page1Share,
    buckets,
    clicks: totClicks,
    impressions: totImp,
    topOpportunities: opportunities,
  };
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

  // Single-run lab metrics (performanceScore/lcpLab/tbt) are noisy — one PSI
  // call swung /show/hamilton between 64 and 81 week over week with no code
  // change (card #311, 2026-07-21), triggering false-alarm "regression"
  // anomalies. lighthouse-post-deploy.yml already runs 3x and takes the best
  // score for its URLs; mirror that here, but ONLY when an API key is set —
  // the anonymous quota is already scarce (routine 429s), so tripling those
  // calls would just burn it 3x faster for no benefit.
  const RUNS_PER_URL = psKey ? 3 : 1;

  let shows = [];
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    shows = data.shows || data;
  } catch (err) {
    console.log('  Could not read shows.json, skipping show-page CWV sampling');
  }
  const cwvPages = buildCWVPages(shows);

  const fetchOnce = async (url) => {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=PERFORMANCE&strategy=MOBILE${psKey ? `&key=${psKey}` : ''}`;
    // PageSpeed runs a full Lighthouse audit server-side; legitimately slow. Give it
    // 60s (vs the 30s default) before aborting so we don't false-timeout a real result.
    const response = await fetchT(apiUrl, {}, 60000);

    if (!response.ok) {
      if (response.status === 429) return { rateLimited: true };
      console.log(`  Failed for ${url}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const crux = data.loadingExperience?.metrics || {};
    const lighthouse = data.lighthouseResult?.audits || {};

    return {
      url,
      // PSI silently swaps in the ORIGIN's field data when this URL has too few
      // CrUX samples, with no difference in response shape. Capture the marker so
      // downstream anomalies can say whose number this is (see seo-cwv-field-scope.js).
      originFallback: typeof data.loadingExperience?.origin_fallback === 'boolean'
        ? data.loadingExperience.origin_fallback
        : undefined,
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
  };

  for (const url of cwvPages) {
    try {
      let best = null;
      let rateLimited = false;
      for (let i = 0; i < RUNS_PER_URL; i++) {
        const attempt = await fetchOnce(url);
        if (attempt?.rateLimited) { rateLimited = true; break; }
        if (attempt && (best === null || (attempt.performanceScore ?? -1) > (best.performanceScore ?? -1))) {
          best = attempt;
        }
      }
      if (rateLimited) {
        console.log(`  Rate limited on PageSpeed API. Stopping CWV check.`);
        break;
      }
      if (!best) continue;

      const cwv = best;
      results.push(cwv);
      console.log(`  ${url}:`);
      if (cwv.performanceScore !== null) console.log(`    Lighthouse Score: ${cwv.performanceScore}/100 (best of ${RUNS_PER_URL})`);
      if (cwv.lcp !== null) console.log(`    LCP (field): ${cwv.lcp}ms`);
      if (cwv.inp !== null) console.log(`    INP (field): ${cwv.inp}ms`);
      if (cwv.cls !== null) console.log(`    CLS (field): ${cwv.cls}`);
      if (cwv.lcpLab !== null) console.log(`    LCP (lab): ${cwv.lcpLab}ms`);
      if (cwv.tbt !== null) console.log(`    TBT (lab): ${cwv.tbt}ms`);
    } catch (err) {
      console.log(`  Error for ${url}: ${err.message}`);
    }
  }

  // Stamp page-level vs origin-fallback onto every record before it is persisted,
  // so history carries the scope and next week's comparison can tell a real LCP
  // change apart from a measurement swap.
  return annotateFieldScope(results);
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

  // A departing zero-click bot-query cluster takes impressions with it AND drags
  // average position the wrong way, because those impressions sat at good
  // positions. Both movements are one event, so neither is independent evidence
  // of a ranking loss — but the impressions guard's `positionHealthy` clause and
  // the position_worse warning below each read them as such, which is how card
  // #530 ("34% impressions drop", 2026-07-26) got raised over a third-party
  // scraper switching off on 2026-07-15 while clicks were UP 13%.
  const bot = currentMetrics.botSignature;
  const botImpressionsDelta = bot ? (bot.priorBotImpressions || 0) - (bot.botImpressions || 0) : 0;
  const organicImpressionsDelta = bot ? (bot.priorOrganicImpressions || 0) - (bot.organicImpressions || 0) : 0;
  const botDropExplains = bot ? botDropExplainsDecline({
    impressionsDelta: avgImpressions - currentMetrics.impressions,
    botImpressionsDelta,
    organicImpressionsDelta,
    priorOrganicImpressions: bot.priorOrganicImpressions,
    truncated: bot.truncated,
  }) : false;
  // Clicks must be FLAT OR UP, not merely "down less than 15%". In the real
  // event clicks ROSE 13%. A 14% click decline alongside a 35% impressions
  // decline sits under both the old 0.15 bar and the separate clicks_drop
  // threshold of 0.25, so the two guards between them would have said nothing
  // at all (ship-check reviewer scenario S2).
  const clicksFlatOrUp = clicksDrop <= 0.05;

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
    } else if (clicksFlatOrUp && botDropExplains) {
      console.log(`  Impressions down ${Math.round(impressionsDrop * 100)}% vs 4-week avg with clicks flat/up (${currentMetrics.clicks} vs avg ${Math.round(avgClicks)}); zero-click bot-shaped queries fell ${botImpressionsDelta} impressions while organic held (${bot.priorOrganicImpressions} -> ${bot.organicImpressions}), e.g. ${JSON.stringify(bot.examples?.[0] || '')} — scraper churn, suppressed`);
    } else {
      issues.push({ type: 'impressions_drop', severity: 'error', message: `Impressions down ${Math.round(impressionsDrop * 100)}% vs 4-week avg (${currentMetrics.impressions} vs avg ${Math.round(avgImpressions)})` });
      console.log(`  ALERT: ${issues[issues.length - 1].message}`);
    }
  }

  if (positionIncrease > 5) {
    // Also require the impressions event itself: bot churn can only explain a
    // position shift if it actually took a meaningful share of impressions with
    // it. Position collapsing while impressions barely move is a different
    // problem and must stay loud.
    if (botDropExplains && clicksFlatOrUp && impressionsDrop > 0.10) {
      console.log(`  Avg position worsened by ${positionIncrease.toFixed(1)} spots, but ${botImpressionsDelta} zero-click bot-shaped impressions left the mix while organic impressions and clicks held — averaging artefact, suppressed`);
    } else {
      issues.push({ type: 'position_worse', severity: 'warning', message: `Avg position worsened by ${positionIncrease.toFixed(1)} spots (${currentMetrics.position} vs avg ${avgPosition.toFixed(1)})` });
      console.log(`  ALERT: ${issues[issues.length - 1].message}`);
    }
  }

  if (issues.length === 0) {
    console.log('  No anomalies detected');
  }

  return issues;
}

// `today` (YYYY-MM-DD) is injectable purely so tests can pin the CWV
// acknowledgment window. The acks in seo-cwv-ack.js expire by design, so a test
// that exercises "an acknowledged regression downgrades to warning" against the
// real clock silently flips to failing on the ack's expiry date — a
// calendar-triggered CI failure with no commit behind it (the exact class that
// held main red for 8 days in Aug 2026; found by
// scripts/audit-time-bomb-tests.js six days before this one was due to fire on
// 2026-08-18). Production callers omit it and get today's real date.
function detectCWVAnomalies(currentCWV, history, today) {
  const issues = [];
  if (!currentCWV || currentCWV.length === 0) return issues;

  // Field metrics are page-level only when the URL clears CrUX's sampling floor;
  // otherwise PSI hands back the ORIGIN's numbers under the same field names. Every
  // origin-scoped URL in a run therefore carries one identical measurement, so the
  // field-threshold checks below must fire ONCE for the origin rather than once per
  // page — five CRITICALs for one site-wide number is the alert storm this prevents.
  const scoped = annotateFieldScope(currentCWV);
  const originScoped = scoped.filter(r => r.fieldScope === 'origin');
  // Read each origin metric as the worst non-null value across the cohort rather
  // than whatever the FIRST origin record happens to hold. Inference groups records
  // by an identical triple so they agree, but PSI's own origin_fallback marker
  // bypasses that grouping — so record[0] can legitimately carry a null LCP and
  // silence a real breach reported by its sibling.
  const worstOrigin = (metric) => {
    const vals = originScoped.map(r => r[metric]).filter(v => v != null);
    return vals.length ? Math.max(...vals) : null;
  };
  const originRep = originScoped.length
    ? { lcp: worstOrigin('lcp'), cls: worstOrigin('cls'), inp: worstOrigin('inp') }
    : null;
  const originPages = originScoped.map(r => r.url.replace(SITE_HOST, '') || '/');
  // Origin-level breaches are reported against the origin, so the acknowledgment
  // registry is consulted at origin scope too — a url-scoped ack (#368's /west-end
  // entry) deliberately does NOT silence a site-wide number it never described.
  const originAck = (metric) => findCWVFieldAcknowledgment(SITE_HOST, metric, today);
  // Every message leads with its scope — "SITE-WIDE:" or the page path — so the
  // owner can triage "the whole site got slower for real visitors" (serious) from
  // "one page scored badly on a simulated test" (usually ignorable) without
  // reading past the first word. The page list is capped: past three names it
  // stops being scannable and becomes a wall of slashes.
  const listPages = originPages.length > 3
    ? `${originPages.slice(0, 3).join(', ')}, +${originPages.length - 3} more`
    : originPages.join(', ');
  const originSuffix = ` — whole-site measurement; ${originPages.length} audited page(s) have too little traffic to measure on their own (${listPages})`;
  // Same "lab low + field bad = real users hurt" escalation the per-URL check uses,
  // evaluated once at origin scope instead of once per affected page.
  const originLabLow = originScoped.some(
    r => r.performanceScore != null && r.performanceScore < CWV_ABSOLUTE.lighthouseMin
  );

  if (originRep) {
    if (originRep.lcp && originRep.lcp > CWV_ABSOLUTE.lcp) {
      const ack = originAck('lcp');
      issues.push({
        type: 'cwv_lcp_absolute',
        severity: originLabLow && !ack ? 'error' : 'warning',
        scope: 'origin',
        message: `SITE-WIDE: real visitors' LCP is ${originRep.lcp}ms, over the ${CWV_ABSOLUTE.lcp}ms target${originSuffix}${ack ? ` — acknowledged: ${ack.reason} [expires ${ack.expires}]` : ''}`,
      });
    }
    if (originRep.cls != null && originRep.cls > CWV_ABSOLUTE.cls) {
      issues.push({ type: 'cwv_cls_absolute', severity: 'warning', scope: 'origin', message: `SITE-WIDE: real visitors' CLS is ${originRep.cls}, over the ${CWV_ABSOLUTE.cls} target${originSuffix}` });
    }
    if (originRep.inp && originRep.inp > CWV_ABSOLUTE.inp) {
      issues.push({ type: 'cwv_inp_absolute', severity: 'warning', scope: 'origin', message: `SITE-WIDE: real visitors' INP is ${originRep.inp}ms, over the ${CWV_ABSOLUTE.inp}ms target${originSuffix}` });
    }
  }

  // Absolute threshold checks (always run, even without history)
  for (const current of scoped) {
    const shortUrl = current.url.replace(SITE_HOST, '');
    const isOrigin = current.fieldScope === 'origin';
    // Field-metric breaches for origin-scoped URLs were already emitted once above.
    if (!isOrigin && current.lcp && current.lcp > CWV_ABSOLUTE.lcp) {
      const ack = findCWVFieldAcknowledgment(current.url, 'lcp', today);
      issues.push({
        type: 'cwv_lcp_absolute',
        severity: 'warning',
        scope: 'url',
        message: `${shortUrl}: real visitors' LCP is ${current.lcp}ms, over the ${CWV_ABSOLUTE.lcp}ms target${ack ? ` — acknowledged: ${ack.reason} [expires ${ack.expires}]` : ''}`,
      });
    }
    if (!isOrigin && current.cls != null && current.cls > CWV_ABSOLUTE.cls) {
      issues.push({ type: 'cwv_cls_absolute', severity: 'warning', scope: 'url', message: `${shortUrl}: real visitors' CLS is ${current.cls}, over the ${CWV_ABSOLUTE.cls} target` });
    }
    if (!isOrigin && current.inp && current.inp > CWV_ABSOLUTE.inp) {
      issues.push({ type: 'cwv_inp_absolute', severity: 'warning', scope: 'url', message: `${shortUrl}: real visitors' INP is ${current.inp}ms, over the ${CWV_ABSOLUTE.inp}ms target` });
    }
    if (current.performanceScore != null && current.performanceScore < CWV_ABSOLUTE.lighthouseMin) {
      // Lab Lighthouse is a synthetic, heavily-throttled score (slow-4G + 4x CPU). A
      // low value while field/CrUX data is healthy means real users are fine — escalate
      // to error (CRITICAL email) ONLY when field LCP also breaches Good; otherwise warn
      // (digest). Prevents weekly CRITICAL pages for borderline lab scores (e.g. homepage
      // lab 69 with field LCP 797ms) while still emailing when real users are hurt.
      const fieldUnhealthy = current.lcp != null && current.lcp > CWV_ABSOLUTE.lcp;
      // A field-LCP acknowledgment (fix shipped, CrUX 28-day window still trailing)
      // downgrades this back to warning — the digest still shows it as tracked-warn
      // (not silently dropped) instead of paging daily for already-fixed work (#368).
      // Only consult the url-scoped ack when the number really is this page's.
      // Appending "acknowledged: fix shipped on /west-end" to a message that just
      // said the value is NOT /west-end's reads as the system contradicting itself.
      const ack = fieldUnhealthy && !isOrigin ? findCWVFieldAcknowledgment(current.url, 'lcp', today) : null;
      // When the field number is the origin's, it says nothing about THIS page, so it
      // cannot escalate this page — the single origin-scoped anomaly above owns that
      // escalation. Naming the scope also stops the next reader from chasing a
      // page-specific LCP fix for a site-wide measurement (what card #419 asked for).
      const escalates = fieldUnhealthy && !ack && !isOrigin;
      const fieldClause = !fieldUnhealthy
        ? ' — simulated test only; real visitors are fine, usually ignorable'
        : isOrigin
          ? ' — simulated test only for this page; the site-wide slowdown is reported separately and is not this page\'s'
          : ` AND real visitors' LCP is ${current.lcp}ms over the ${CWV_ABSOLUTE.lcp}ms target — this one is real`;
      issues.push({
        type: 'cwv_lighthouse_low',
        severity: escalates ? 'error' : 'warning',
        message: `${shortUrl}: scored ${current.performanceScore}/100 on a simulated phone test (below ${CWV_ABSOLUTE.lighthouseMin})${fieldClause}${ack ? ` — acknowledged: ${ack.reason} [expires ${ack.expires}]` : ''}`,
      });
    }
  }

  // Relative regression checks (need history)
  if (history.length < 2) return issues;
  const priorWeek = history[history.length - 1];
  if (!priorWeek.coreWebVitals || priorWeek.coreWebVitals.length === 0) return issues;

  // Prior snapshots written before this change carry no fieldScope, so re-derive it
  // from that week's own batch rather than treating the gap as "same scope".
  const priorScoped = annotateFieldScope(priorWeek.coreWebVitals);

  // Origin-scoped field metrics are one shared measurement, so a week-over-week
  // field regression on them is ONE event — reporting it per page turns a single
  // site-wide change into five identical digest lines. Emit it once here, then skip
  // the field comparisons for those pages below. (Lighthouse score is genuinely
  // per-page lab data, so cwv_lighthouse_drop stays per-URL.)
  const originFieldReported = new Set();
  if (originScoped.length) {
    const priorOriginScoped = priorScoped.filter(p => p.fieldScope === 'origin');
    const priorWorst = (metric) => {
      const vals = priorOriginScoped.map(p => p[metric]).filter(v => v != null);
      return vals.length ? Math.max(...vals) : null;
    };
    const priorLcp = priorWorst('lcp');
    const priorCls = priorWorst('cls');
    if (originRep?.lcp != null && priorLcp != null && originRep.lcp - priorLcp > 500) {
      issues.push({ type: 'cwv_lcp_regression', severity: 'warning', scope: 'origin', message: `SITE-WIDE: real visitors' LCP got worse — ${originRep.lcp}ms (was ${priorLcp}ms)` });
    }
    if (originRep?.cls != null && priorCls != null && originRep.cls - priorCls > 0.05) {
      issues.push({ type: 'cwv_cls_regression', severity: 'warning', scope: 'origin', message: `SITE-WIDE: real visitors' CLS got worse — ${originRep.cls} (was ${priorCls})` });
    }
    // Only suppress the per-page comparison when there WAS an origin cohort last
    // week to compare against; otherwise these pages fall through to the scope-switch
    // guard below, which is the correct handling for a cohort that just appeared.
    if (priorOriginScoped.length) originScoped.forEach(r => originFieldReported.add(r.url));
  }

  for (const current of scoped) {
    const prior = priorScoped.find(p => p.url === current.url);
    if (!prior) continue;

    const shortUrl = current.url.replace(SITE_HOST, '');
    // A page crossing the CrUX sampling floor swaps a page-level measurement for an
    // origin-level one (or back). /west-end did exactly that on 2026-08-02: 2275ms →
    // 1467ms with nothing about the page changed. Comparing across that swap invents
    // a several-hundred-ms delta, which clears the 500ms bar on its own.
    const swapped = scopeChanged(current.fieldScope, prior.fieldScope)
      || originFieldReported.has(current.url);
    if (swapped && scopeChanged(current.fieldScope, prior.fieldScope)) {
      console.log(`  ${shortUrl}: field data switched ${prior.fieldScope} → ${current.fieldScope} — field regression comparison skipped (not comparable)`);
    }
    if (!swapped && current.lcp && prior.lcp && current.lcp - prior.lcp > 500) {
      issues.push({ type: 'cwv_lcp_regression', severity: 'warning', message: `${shortUrl}: real visitors' LCP got worse — ${current.lcp}ms (was ${prior.lcp}ms)` });
    }
    if (!swapped && current.cls != null && prior.cls != null && current.cls - prior.cls > 0.05) {
      issues.push({ type: 'cwv_cls_regression', severity: 'warning', message: `${shortUrl}: real visitors' CLS got worse — ${current.cls} (was ${prior.cls})` });
    }
    if (current.performanceScore != null && prior.performanceScore != null && prior.performanceScore - current.performanceScore > 10) {
      issues.push({ type: 'cwv_lighthouse_drop', severity: 'warning', message: `${shortUrl}: simulated-test score dropped to ${current.performanceScore} (was ${prior.performanceScore})` });
    }
  }

  return issues;
}

// --- Persistence ---

function loadHistory() {
  try {
    const rows = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (!Array.isArray(rows)) return [];
    // Detection reads this too, and every threshold compares against
    // slice(-4). A duplicated date silently reweights the baseline (the live
    // file carried a duplicate 2026-06-21 for six weeks), and out-of-order rows
    // put the wrong four weeks in that window. Normalise on the way in so the
    // read path is safe even against a file some other writer left messy.
    const byDate = new Map();
    for (const row of rows) {
      if (row && row.date) byDate.set(row.date, row);
    }
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  } catch {
    return [];
  }
}

function saveSnapshot(healthData, performanceData) {
  const dir = path.dirname(HEALTH_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(HEALTH_PATH, JSON.stringify(healthData, null, 2) + '\n');
  console.log(`\nSaved health snapshot to ${HEALTH_PATH}`);

  // Every alert threshold in detectPerformanceAnomalies() is a comparison against
  // the trailing 4-week average, so a duplicated week silently reweights all of
  // them. A rerun of the weekly workflow (or two runs landing in one calendar
  // day) used to blind-append a second row for the same date — data/audit/
  // seo-performance-history.json carried a duplicate 2026-06-21 for six weeks.
  // Replace-by-date instead of appending.
  const history = loadHistory().filter(row => row.date !== healthData.lastChecked);
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
    // De-branded review-intent ranking — tracked over time so a real ranking decline
    // is visible even while the brand-skewed site avg stays flat.
    reviewIntentAvgPosition: healthData.reviewIntentRankings?.avgPosition ?? null,
    reviewIntentPage1Share: healthData.reviewIntentRankings?.page1Share ?? null,
  });
  // Re-sort before trimming: a backfilled or re-run older date would otherwise
  // sit at the end of the array, so slice(-4) and the 52-row trim would both
  // operate on insertion order rather than chronology.
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
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
      const res = await fetchT('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
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
    const testRes = await fetchT(
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
    sampleUrls = shuffled.slice(0, 30); // 30, not 50 — each is a sequential urlInspection call; keeps runtime under the job cap
  } catch {
    sampleUrls = [`${SITE_HOST}/`, `${SITE_HOST}/show/hamilton`];
  }

  const indexCoverage = await checkIndexCoverage(wmToken, sampleUrls);
  const newPages = await checkNewPages(wmToken);
  const stalePages = await checkStalePages(wmToken);
  const highValuePages = await submitHighValuePages(wmToken);
  const reviewIntentRankings = await checkReviewIntentRankings(wmToken);
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
      // Persisted so a suppressed impressions_drop leaves an audit trail in
      // seo-health.json rather than only in the workflow log. Without this the
      // next investigation has to re-derive the bot census by hand, which is
      // what made card #530 cost a whole session.
      botSignature: performance.botSignature,
    },
    indexCoverage,
    sitemapStatus,
    newPages,
    stalePages,
    targetKeywords: targetKeywords.filter(r => r.position !== null).slice(0, 20),
    reviewIntentRankings,
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
  console.log(`  Performance: ${performance.clicks} clicks, ${performance.impressions} impressions (avg position ${performance.position} — BRAND-SKEWED, not a ranking-quality signal)`);
  if (reviewIntentRankings && reviewIntentRankings.queries > 0) {
    console.log(`  Review-Intent Rankings (the real signal): avg position ${reviewIntentRankings.avgPosition}, ${reviewIntentRankings.page1Share}% on page 1 across ${reviewIntentRankings.queries} "[show] reviews" queries`);
  }
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

module.exports = { detectAnomalies, detectCWVAnomalies, sampleShowPages, buildCWVPages };
