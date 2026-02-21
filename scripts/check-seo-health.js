#!/usr/bin/env node
/**
 * Weekly SEO Health Check
 *
 * Checks index coverage, search performance, sitemap status,
 * new page indexing, and stale page detection via Google Search Console APIs.
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

  return {
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

// --- Check: New Page Indexing (Feature 3) ---

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
    return d >= sevenDaysAgo && d <= twoDaysAgo; // opened 2-7 days ago
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
        console.log(`  ✓ ${show.title} — indexed`);
        indexed++;
      } else {
        console.log(`  ✗ ${show.title} — not indexed (${verdict}), requesting crawl...`);
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

// --- Check: Stale Pages (Feature 5) ---

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

  // Build URL pool: active shows + key pages
  const activeShows = shows.filter(s => s.status === 'open' || s.status === 'previews');
  const urls = activeShows.map(s => `${SITE_HOST}/show/${s.slug}`);
  urls.push(
    `${SITE_HOST}/`, `${SITE_HOST}/rankings`, `${SITE_HOST}/critics`,
    `${SITE_HOST}/lotteries`, `${SITE_HOST}/box-office`, `${SITE_HOST}/biz`,
  );

  // Random sample of 100 (or fewer)
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

  // Re-submit stale pages via Indexing API
  if (staleUrls.length > 0 && !dryRun) {
    const remaining = getQuotaRemaining();
    const budget = Math.min(staleUrls.length, remaining, 50); // max 50/week for stale
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

// --- Anomaly Detection (Feature 4) ---

function detectAnomalies(currentMetrics, history) {
  const issues = [];

  if (history.length < 4) {
    console.log('\n--- Anomaly Detection: Skipping (need 4+ weeks of baseline) ---');
    return issues;
  }

  console.log('\n--- Anomaly Detection ---');

  // 4-week rolling average
  const recent4 = history.slice(-4);
  const avgClicks = recent4.reduce((s, w) => s + w.clicks, 0) / 4;
  const avgImpressions = recent4.reduce((s, w) => s + w.impressions, 0) / 4;
  const avgPosition = recent4.reduce((s, w) => s + w.position, 0) / 4;

  const clicksDrop = avgClicks > 0 ? (avgClicks - currentMetrics.clicks) / avgClicks : 0;
  const impressionsDrop = avgImpressions > 0 ? (avgImpressions - currentMetrics.impressions) / avgImpressions : 0;
  const positionIncrease = currentMetrics.position - avgPosition;

  // Seasonality guard: if 50+ weeks, compare to same-week-last-year
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
    if (seasonallyExpected) {
      console.log(`  Clicks down ${Math.round(clicksDrop * 100)}% vs 4-week avg, but matches seasonal pattern — suppressed`);
    } else {
      issues.push({ type: 'clicks_drop', severity: 'error', message: `Clicks down ${Math.round(clicksDrop * 100)}% vs 4-week avg (${currentMetrics.clicks} vs avg ${Math.round(avgClicks)})` });
      console.log(`  ALERT: ${issues[issues.length - 1].message}`);
    }
  }

  if (impressionsDrop > 0.30) {
    if (seasonallyExpected) {
      console.log(`  Impressions down ${Math.round(impressionsDrop * 100)}% vs 4-week avg, but matches seasonal pattern — suppressed`);
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

  // Save latest health snapshot
  fs.writeFileSync(HEALTH_PATH, JSON.stringify(healthData, null, 2) + '\n');
  console.log(`\nSaved health snapshot to ${HEALTH_PATH}`);

  // Append to history, truncate to 52 weeks
  const history = loadHistory();
  history.push({
    date: healthData.lastChecked,
    clicks: performanceData.clicks,
    impressions: performanceData.impressions,
    ctr: performanceData.ctr,
    position: performanceData.position,
    topQueries: performanceData.topQueries.slice(0, 10),
    topPages: performanceData.topPages.slice(0, 10),
  });
  // Truncate to 52 entries
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

    // Add context fields
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

// --- Main ---

async function main() {
  console.log('=== Weekly SEO Health Check ===\n');

  const serviceAccount = loadServiceAccount();

  // --test-auth mode
  if (testAuthOnly) {
    const ok = await testAuth(serviceAccount);
    process.exit(ok ? 0 : 1);
  }

  // Fail-fast auth check
  let wmToken;
  try {
    wmToken = await getAccessToken(serviceAccount, SCOPE_WEBMASTERS);
    console.log('Authenticated with Google (webmasters scope).');
  } catch (err) {
    console.error(`Authentication failed: ${err.message}`);
    console.error('Ensure GOOGLE_INDEXING_KEY is set and Search Console API is enabled in GCP.');
    process.exit(1);
  }

  // Verify API access works (fail-fast on 403)
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

  // Build sample URLs for index coverage check
  let sampleUrls;
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = data.shows || data;
    const showUrls = shows.map(s => `${SITE_HOST}/show/${s.slug}`);
    // Random sample of 50
    const shuffled = showUrls.sort(() => Math.random() - 0.5);
    sampleUrls = shuffled.slice(0, 50);
  } catch {
    sampleUrls = [`${SITE_HOST}/`, `${SITE_HOST}/show/hamilton`];
  }

  const indexCoverage = await checkIndexCoverage(wmToken, sampleUrls);
  const newPages = await checkNewPages(wmToken);
  const stalePages = await checkStalePages(wmToken);

  // Load history for anomaly detection
  const history = loadHistory();
  const anomalies = detectAnomalies(performance, history);

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
    anomalies,
    quotaUsedToday: readQuotaLedger().used,
  };

  // Save & alert
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
