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
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SITE_HOST = 'https://broadwayscorecard.com';
const INDEXING_API_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/indexing';

// Parse args
const args = process.argv.slice(2);
let specificUrls = [];
let specificShows = [];
let notificationType = 'URL_UPDATED';

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
  } else if (args[i] === '--help') {
    console.log(`
Google Indexing API URL Submission

Usage:
  node scripts/submit-google-indexing.js --urls /path1,/path2
  node scripts/submit-google-indexing.js --shows show-id-1,show-id-2
  node scripts/submit-google-indexing.js --type URL_DELETED --urls /old-page

Options:
  --urls <paths>    Comma-separated URL paths
  --shows <ids>     Comma-separated show slugs (submits show page + homepage)
  --type <type>     URL_UPDATED (default) or URL_DELETED
  --help            Show this help message

Environment:
  GOOGLE_INDEXING_KEY   Base64-encoded service account JSON key
`);
    process.exit(0);
  }
}

/**
 * Create a JWT and exchange it for an access token
 */
async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope: SCOPE,
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

async function main() {
  // Load service account key
  const keyBase64 = process.env.GOOGLE_INDEXING_KEY;
  if (!keyBase64) {
    console.error('GOOGLE_INDEXING_KEY environment variable not set.');
    console.error('Set it to the base64-encoded service account JSON key.');
    console.error('See script header for setup instructions.');
    process.exit(1);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(Buffer.from(keyBase64, 'base64').toString('utf8'));
  } catch {
    console.error('Failed to parse GOOGLE_INDEXING_KEY. Ensure it is valid base64-encoded JSON.');
    process.exit(1);
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
    console.error('No URLs specified. Use --urls or --shows.');
    process.exit(1);
  }

  console.log(`Submitting ${urls.length} URLs to Google Indexing API (${notificationType})...`);

  // Get access token
  const accessToken = await getAccessToken(serviceAccount);
  console.log('Authenticated with Google.');

  // Google Indexing API has a quota of 200 URLs/day
  if (urls.length > 200) {
    console.warn(`Warning: ${urls.length} URLs exceeds daily quota of 200. Submitting first 200.`);
    urls = urls.slice(0, 200);
  }

  // Submit URLs with 100ms delay between requests
  let success = 0;
  let failed = 0;

  for (const url of urls) {
    const result = await submitUrl(accessToken, url, notificationType);
    if (result.success) {
      console.log(`  ✓ ${url}`);
      success++;
    } else {
      console.error(`  ✗ ${url}: ${result.error}`);
      failed++;
    }
    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone: ${success} succeeded, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
