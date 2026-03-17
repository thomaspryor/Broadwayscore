#!/usr/bin/env node

/**
 * Weekly URL Health Check
 *
 * Samples review URLs + all ticket platform URLs for open shows.
 * Uses GET (not HEAD — many outlets 403 on HEAD).
 * Excludes known-blocked domains from alert thresholds.
 *
 * Report: data/audit/url-health-report.json
 * Alerts: Discord #alerts if >5% dead ticket links or >10% dead review URLs
 *
 * Usage: node scripts/health-check-urls.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { sendAlert } = require('./lib/discord-notify');
const { getDomain } = require('./lib/url-utils');

const DRY_RUN = process.argv.includes('--dry-run');
const DATA_DIR = path.join(__dirname, '..', 'data');
const REPORT_PATH = path.join(DATA_DIR, 'audit', 'url-health-report.json');

// Domains that block all HTTP (Akamai, JS-only, etc.) — exclude from alert thresholds
const KNOWN_BLOCKED_DOMAINS = new Set([
  'telecharge.com',
  'ticketmaster.com',
]);

// Review URL sample size
const REVIEW_SAMPLE_SIZE = 50;

// Concurrency limit for HTTP requests
const CONCURRENCY = 5;

// ── Helpers ──

function isKnownBlocked(url) {
  const domain = getDomain(url);
  if (!domain) return false;
  return KNOWN_BLOCKED_DOMAINS.has(domain) || KNOWN_BLOCKED_DOMAINS.has('www.' + domain);
}

/**
 * Deterministic seed from ISO week — same URLs checked each week for trend consistency
 */
function getWeeklySeed() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return now.getFullYear() * 100 + weekNum;
}

/**
 * Deterministic shuffle using seed (Fisher-Yates with seeded PRNG)
 */
function seededShuffle(arr, seed) {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * HTTP GET with timeout — returns { status, redirectUrl, error }
 */
function checkUrl(url, timeout = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ status: 'timeout', code: 0 });
    }, timeout);

    try {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      const req = client.get(url, {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0; health-check)',
          'Accept': 'text/html',
        },
      }, (res) => {
        // Consume body to free socket
        res.on('data', () => {});
        res.on('end', () => {});

        clearTimeout(timer);
        const code = res.statusCode;

        if (code >= 200 && code < 300) {
          resolve({ status: 'ok', code });
        } else if (code >= 300 && code < 400) {
          resolve({ status: 'redirected', code, redirectUrl: res.headers.location });
        } else if (code === 403 || code === 503) {
          resolve({ status: 'blocked', code });
        } else if (code === 404 || code === 410) {
          resolve({ status: 'dead', code });
        } else {
          resolve({ status: 'error', code });
        }
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        resolve({ status: 'error', code: 0, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timer);
        resolve({ status: 'timeout', code: 0 });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ status: 'error', code: 0, error: err.message });
    }
  });
}

/**
 * Run promises with concurrency limit
 */
async function withConcurrency(items, fn, limit) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ── Collect URLs ──

function getTicketUrls() {
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
  const shows = data.shows || data;
  const urls = [];

  for (const [key, show] of Object.entries(shows)) {
    if (show.status !== 'open' && show.status !== 'previews') continue;

    // TodayTix URL
    if (show.todaytixUrl) {
      urls.push({ url: show.todaytixUrl, platform: 'TodayTix', showId: show.id || key, showTitle: show.title });
    }

    // ticketLinks array
    if (Array.isArray(show.ticketLinks)) {
      for (const link of show.ticketLinks) {
        if (link.url) {
          urls.push({ url: link.url, platform: link.platform || 'unknown', showId: show.id || key, showTitle: show.title });
        }
      }
    }

    // officialUrl
    if (show.officialUrl) {
      urls.push({ url: show.officialUrl, platform: 'official', showId: show.id || key, showTitle: show.title });
    }
  }

  return urls;
}

function getReviewUrlSample() {
  const reviewDir = path.join(DATA_DIR, 'review-texts');
  if (!fs.existsSync(reviewDir)) return [];

  // Collect all review file paths
  const allFiles = [];
  for (const showDir of fs.readdirSync(reviewDir)) {
    const showPath = path.join(reviewDir, showDir);
    if (!fs.statSync(showPath).isDirectory()) continue;
    for (const file of fs.readdirSync(showPath)) {
      if (file.endsWith('.json')) {
        allFiles.push(path.join(showPath, file));
      }
    }
  }

  // Deterministic sample
  const seed = getWeeklySeed();
  const shuffled = seededShuffle(allFiles, seed);
  const sampled = shuffled.slice(0, REVIEW_SAMPLE_SIZE);

  const urls = [];
  for (const filePath of sampled) {
    try {
      const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (review.url) {
        urls.push({
          url: review.url,
          showId: review.showId || path.basename(path.dirname(filePath)),
          outlet: review.outletId || review.outlet || 'unknown',
          filePath: path.relative(DATA_DIR, filePath),
        });
      }
    } catch {
      // Skip malformed files
    }
  }

  return urls;
}

// ── Main ──

async function main() {
  console.log('URL Health Check starting...');

  const ticketUrls = getTicketUrls();
  const reviewUrls = getReviewUrlSample();

  console.log(`Checking ${ticketUrls.length} ticket URLs + ${reviewUrls.length} review URLs`);

  // Check ticket URLs
  console.log('\n--- Ticket Platform URLs ---');
  const ticketResults = await withConcurrency(ticketUrls, async (item, i) => {
    const result = await checkUrl(item.url);
    const blocked = isKnownBlocked(item.url);
    const icon = result.status === 'ok' ? '✓' : result.status === 'blocked' && blocked ? '⊘' : '✗';
    console.log(`  ${icon} [${item.platform}] ${item.showTitle}: ${result.status} (${result.code})`);
    return { ...item, ...result, knownBlocked: blocked };
  }, CONCURRENCY);

  // Check review URLs
  console.log('\n--- Review URLs (sample) ---');
  const reviewResults = await withConcurrency(reviewUrls, async (item, i) => {
    const result = await checkUrl(item.url);
    const blocked = isKnownBlocked(item.url);
    const icon = result.status === 'ok' ? '✓' : result.status === 'blocked' ? '⊘' : '✗';
    console.log(`  ${icon} [${item.outlet}] ${item.showId}: ${result.status} (${result.code})`);
    return { ...item, ...result, knownBlocked: blocked };
  }, CONCURRENCY);

  // Summarize
  const ticketSummary = summarize(ticketResults, 'ticket');
  const reviewSummary = summarize(reviewResults, 'review');

  console.log('\n--- Summary ---');
  console.log(`Ticket URLs: ${ticketSummary.ok} ok, ${ticketSummary.dead} dead, ${ticketSummary.redirected} redirected, ${ticketSummary.blocked} blocked (${ticketSummary.knownBlocked} known-blocked), ${ticketSummary.timeout} timeout, ${ticketSummary.error} error`);
  console.log(`Review URLs: ${reviewSummary.ok} ok, ${reviewSummary.dead} dead, ${reviewSummary.redirected} redirected, ${reviewSummary.blocked} blocked, ${reviewSummary.timeout} timeout, ${reviewSummary.error} error`);

  // Write report
  const report = {
    timestamp: new Date().toISOString(),
    seed: getWeeklySeed(),
    ticket: {
      total: ticketResults.length,
      ...ticketSummary,
      deadUrls: ticketResults.filter(r => r.status === 'dead' && !r.knownBlocked).map(r => ({ url: r.url, platform: r.platform, showId: r.showId, showTitle: r.showTitle, code: r.code })),
    },
    review: {
      total: reviewResults.length,
      ...reviewSummary,
      deadUrls: reviewResults.filter(r => r.status === 'dead').map(r => ({ url: r.url, showId: r.showId, outlet: r.outlet, code: r.code })),
    },
  };

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport written to ${path.relative(process.cwd(), REPORT_PATH)}`);
  }

  // Alert check (excluding known-blocked from thresholds)
  const ticketCheckable = ticketResults.filter(r => !r.knownBlocked);
  const ticketDeadRate = ticketCheckable.length > 0
    ? ticketCheckable.filter(r => r.status === 'dead').length / ticketCheckable.length
    : 0;
  const reviewDeadRate = reviewResults.length > 0
    ? reviewResults.filter(r => r.status === 'dead').length / reviewResults.length
    : 0;

  const alerts = [];
  if (ticketDeadRate > 0.05) {
    alerts.push(`Ticket links: ${(ticketDeadRate * 100).toFixed(1)}% dead (threshold: 5%)`);
  }
  if (reviewDeadRate > 0.10) {
    alerts.push(`Review URLs: ${(reviewDeadRate * 100).toFixed(1)}% dead (threshold: 10%)`);
  }

  if (alerts.length > 0) {
    console.log('\n⚠️  Alert thresholds exceeded:');
    alerts.forEach(a => console.log(`  - ${a}`));

    if (!DRY_RUN && process.env.DISCORD_WEBHOOK_ALERTS) {
      const deadTickets = ticketResults.filter(r => r.status === 'dead' && !r.knownBlocked);
      const deadReviews = reviewResults.filter(r => r.status === 'dead');

      await sendAlert({
        title: 'URL Health Check: Dead Links Detected',
        description: alerts.join('\n'),
        severity: 'warning',
        fields: [
          ...(deadTickets.length > 0 ? [{ name: 'Dead Ticket Links', value: deadTickets.slice(0, 5).map(r => `${r.showTitle} (${r.platform})`).join(', ') }] : []),
          ...(deadReviews.length > 0 ? [{ name: 'Dead Review URLs', value: deadReviews.slice(0, 5).map(r => `${r.showId} (${r.outlet})`).join(', ') }] : []),
        ],
      });
      console.log('Discord alert sent.');
    }
  } else {
    console.log('\n✓ All within thresholds.');
  }
}

function summarize(results, type) {
  const summary = { ok: 0, dead: 0, redirected: 0, blocked: 0, knownBlocked: 0, timeout: 0, error: 0 };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
    if (r.knownBlocked) summary.knownBlocked++;
  }
  return summary;
}

main().catch(err => {
  console.error('URL health check failed:', err);
  process.exit(1);
});
