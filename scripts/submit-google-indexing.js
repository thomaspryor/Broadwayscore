#!/usr/bin/env node
/**
 * Submit URLs to Google Indexing API for faster crawling
 *
 * Google Indexing API notifies Google to re-crawl specific URLs immediately,
 * rather than waiting for regular crawl cycles.
 *
 * Setup required:
 *   1. Create Google Cloud project with Indexing API enabled
 *   2. Create service account, download JSON key
 *   3. Add service account email as Owner in Google Search Console
 *   4. Store base64-encoded key as GOOGLE_INDEXING_KEY secret
 *
 * Usage:
 *   node scripts/submit-google-indexing.js --urls /show/hamilton,/show/wicked
 *   node scripts/submit-google-indexing.js --shows hamilton-2015,wicked-2003
 *   node scripts/submit-google-indexing.js --type URL_UPDATED   # default
 *   node scripts/submit-google-indexing.js --type URL_DELETED
 *   node scripts/submit-google-indexing.js --submit-sitemap
 *   node scripts/submit-google-indexing.js --test-auth
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetchSitemapIndexUrls } = require('./lib/sitemap-urls');

const SITE_HOST = 'https://broadwayscorecard.com';
const SITE_URL_GSC = 'sc-domain:broadwayscorecard.com'; // GSC property format
const INDEXING_API_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE_INDEXING = 'https://www.googleapis.com/auth/indexing';
const SCOPE_WEBMASTERS = 'https://www.googleapis.com/auth/webmasters.readonly';
const SCOPE_WEBMASTERS_WRITE = 'https://www.googleapis.com/auth/webmasters';
const QUOTA_LEDGER_PATH = path.join(__dirname, '../data/audit/indexing-api-usage.json');

// Parse args
const args = process.argv.slice(2);
let specificUrls = [];
let specificShows = [];
let notificationType = 'URL_UPDATED';
let submitSitemap = false;
let testAuth = false;
let source = 'manual'; // for quota ledger tracking

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--urls' && args[i + 1]) {
    specificUrls = args[i + 1].split(',').map(u => u.trim());
    i++;
  } else if (args[i] === '--shows' && args[i + 1]) {
    specificShows = args[i + 1].split(',').map(s => s.trim());
    i++;
  } else if (args[i] === '--type' && args[i + 1]) {
    notificationType = args[i + 1];
    i++;
  } else if (args[i] === '--source' && args[i + 1]) {
    source = args[i + 1];
    i++;
  } else if (args[i] === '--submit-sitemap') {
    submitSitemap = true;
  } else if (args[i] === '--test-auth') {
    testAuth = true;
  } else if (args[i] === '--help') {
    console.log(`
Google Indexing API URL Submission

Usage:
  node scripts/submit-google-indexing.js --urls /path1,/path2
  node scripts/submit-google-indexing.js --shows show-id-1,show-id-2
  node scripts/submit-google-indexing.js --type URL_DELETED --urls /old-page
  node scripts/submit-google-indexing.js --submit-sitemap
  node scripts/submit-google-indexing.js --test-auth

Options:
  --urls <paths>       Comma-separated URL paths
  --shows <ids>        Comma-separated show slugs (submits show page + homepage)
  --type <type>        URL_UPDATED (default) or URL_DELETED
  --submit-sitemap     Re-submit sitemap.xml via Search Console Sitemaps API
  --test-auth          Test authentication for both indexing + webmasters scopes
  --source <name>      Tag for quota ledger (default: manual)
  --help               Show this help message

Environment:
  GOOGLE_INDEXING_KEY   Base64-encoded service account JSON key
`);
    process.exit(0);
  }
}

/**
 * Create a JWT and exchange it for an access token
 * @param {Object} serviceAccount - Service account JSON
 * @param {string} [scope] - OAuth scope(s), space-separated. Defaults to indexing scope.
 */
async function getAccessToken(serviceAccount, scope = SCOPE_INDEXING) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signInput = `${encHeader}.${encPayload}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');

  const jwt = `${signInput}.${signature}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Submit a single URL to the Indexing API
 */
async function submitUrl(accessToken, url, type) {
  const response = await fetch(INDEXING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ url, type }),
  });

  if (!response.ok) {
    const text = await response.text();
    return { url, success: false, error: `${response.status}: ${text}` };
  }

  const data = await response.json();
  return { url, success: true, data };
}

// --- Quota Ledger ---

function readQuotaLedger() {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_LEDGER_PATH, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    if (data.date !== today) {
      // Reset for new day
      return { date: today, used: 0, submissions: [] };
    }
    return data;
  } catch {
    return { date: new Date().toISOString().slice(0, 10), used: 0, submissions: [] };
  }
}

function writeQuotaLedger(ledger) {
  const dir = path.dirname(QUOTA_LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUOTA_LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
}

function recordQuotaUsage(url, src) {
  const ledger = readQuotaLedger();
  ledger.used++;
  ledger.submissions.push({ url, source: src, time: new Date().toISOString() });
  writeQuotaLedger(ledger);
}

function getQuotaRemaining() {
  const ledger = readQuotaLedger();
  return Math.max(0, 200 - ledger.used);
}

// --- Sitemap Submission via Search Console API ---

async function submitSitemapToGSC(serviceAccount) {
  const token = await getAccessToken(serviceAccount, SCOPE_WEBMASTERS_WRITE);
  const siteUrl = encodeURIComponent(SITE_URL_GSC);

  // The sitemap is sharded (/sitemap/0.xml … /sitemap/N.xml). There is no
  // /sitemap.xml index, so resolve the real shard URLs from robots.txt rather
  // than hardcoding the dead /sitemap.xml (which would re-add a 404 sitemap to
  // GSC on every deploy). robots.txt derives the list from SITEMAP_SHARDS.
  const sitemapUrls = await fetchSitemapIndexUrls(SITE_HOST);
  if (sitemapUrls.length === 0) {
    console.error('No sitemap URLs found in robots.txt — skipping GSC submission (refusing to re-submit a hardcoded URL).');
    return false;
  }

  let allOk = true;
  for (const sitemapUrl of sitemapUrls) {
    const feedpath = encodeURIComponent(sitemapUrl);
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/sitemaps/${feedpath}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }
    );

    if (response.ok || response.status === 204) {
      console.log(`Sitemap re-submitted to Google Search Console: ${sitemapUrl}`);
    } else {
      const text = await response.text();
      console.error(`Sitemap submission failed for ${sitemapUrl}: ${response.status} ${text}`);
      allOk = false;
    }
  }
  return allOk;
}

// --- Auth Test ---

async function runAuthTest(serviceAccount) {
  console.log('Testing authentication scopes...\n');

  // Test indexing scope
  try {
    const indexingToken = await getAccessToken(serviceAccount, SCOPE_INDEXING);
    // Just verify token was obtained — no actual API call needed
    console.log(`  Indexing scope: OK (token obtained)`);
  } catch (err) {
    console.error(`  Indexing scope: FAILED — ${err.message}`);
    return false;
  }

  // Test webmasters scope via Search Analytics query
  try {
    const wmToken = await getAccessToken(serviceAccount, SCOPE_WEBMASTERS);
    const siteUrl = encodeURIComponent(SITE_URL_GSC);
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/sitemaps`,
      { headers: { Authorization: `Bearer ${wmToken}` } }
    );
    if (response.ok) {
      console.log(`  Webmasters scope: OK (sitemaps accessible)`);
    } else {
      const text = await response.text();
      console.error(`  Webmasters scope: FAILED — ${response.status} ${text}`);
      console.error('\n  Ensure "Google Search Console API" is enabled in your GCP project.');
      return false;
    }
  } catch (err) {
    console.error(`  Webmasters scope: FAILED — ${err.message}`);
    return false;
  }

  console.log('\nAll scopes verified.');
  return true;
}

// --- Main ---

function loadServiceAccount() {
  const keyBase64 = process.env.GOOGLE_INDEXING_KEY;
  if (!keyBase64) {
    console.error('GOOGLE_INDEXING_KEY environment variable not set.');
    console.error('Set it to the base64-encoded service account JSON key.');
    process.exit(1);
  }
  try {
    return JSON.parse(Buffer.from(keyBase64, 'base64').toString('utf8'));
  } catch {
    console.error('Failed to parse GOOGLE_INDEXING_KEY. Ensure it is valid base64-encoded JSON.');
    process.exit(1);
  }
}

async function main() {
  const serviceAccount = loadServiceAccount();

  // --test-auth mode
  if (testAuth) {
    const ok = await runAuthTest(serviceAccount);
    process.exit(ok ? 0 : 1);
  }

  // --submit-sitemap mode
  if (submitSitemap) {
    const ok = await submitSitemapToGSC(serviceAccount);
    process.exit(ok ? 0 : 1);
  }

  // Build URL list
  let urls = [];

  if (specificUrls.length > 0) {
    urls = specificUrls.map(u => {
      if (u.startsWith('http')) return u;
      return `${SITE_HOST}${u.startsWith('/') ? '' : '/'}${u}`;
    });
  } else if (specificShows.length > 0) {
    urls = specificShows.map(s => `${SITE_HOST}/show/${s}`);
    // Also submit homepage since listings changed
    urls.push(`${SITE_HOST}/`);
    urls.push(`${SITE_HOST}/rankings`);
  } else {
    console.error('No URLs specified. Use --urls, --shows, --submit-sitemap, or --test-auth.');
    process.exit(1);
  }

  // Check quota ledger
  const remaining = getQuotaRemaining();
  if (remaining === 0) {
    console.error('Daily Indexing API quota (200) exhausted. Try again tomorrow.');
    process.exit(1);
  }
  if (urls.length > remaining) {
    console.warn(`Warning: ${urls.length} URLs requested but only ${remaining} quota remaining. Submitting ${remaining}.`);
    urls = urls.slice(0, remaining);
  }

  console.log(`Submitting ${urls.length} URLs to Google Indexing API (${notificationType})...`);
  console.log(`Quota: ${remaining} remaining today`);

  // Get access token
  const accessToken = await getAccessToken(serviceAccount);
  console.log('Authenticated with Google.');

  // Submit URLs with 100ms delay between requests
  let success = 0;
  let failed = 0;

  for (const url of urls) {
    const result = await submitUrl(accessToken, url, notificationType);
    if (result.success) {
      console.log(`  ✓ ${url}`);
      success++;
      recordQuotaUsage(url, source);
    } else {
      // Never retry 429 — back off
      if (result.error.startsWith('429')) {
        console.error(`  ✗ ${url}: Rate limited (429). Stopping submissions.`);
        failed++;
        break;
      }
      console.error(`  ✗ ${url}: ${result.error}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone: ${success} succeeded, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

// Export for use by other scripts
module.exports = { getAccessToken, loadServiceAccount, readQuotaLedger, writeQuotaLedger, recordQuotaUsage, getQuotaRemaining, SCOPE_INDEXING, SCOPE_WEBMASTERS, SCOPE_WEBMASTERS_WRITE, SITE_HOST, SITE_URL_GSC };

// Only run main() when executed directly (not when required as module)
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
