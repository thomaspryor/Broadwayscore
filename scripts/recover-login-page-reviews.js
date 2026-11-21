#!/usr/bin/env node
/**
 * One-time recovery script for wrongFullText login-page reviews.
 *
 * Finds review files where wrongFullText contains a login/paywall page
 * (not the actual review), and re-fetches them using local cookie files.
 *
 * Usage: node scripts/recover-login-page-reviews.js [--dry-run] [--outlet=vulture]
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { chooseArticleBody } = require('./lib/jsonld-body-choice');
const { extractFromJsonLd, extractParagraphText } = require('./lib/html-article-text');
const { extractVarietyBody } = require('./lib/article-extractor');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const COOKIES_DIR = path.join(__dirname, '..', 'data', 'cookies');

// Cookie domain mapping (subset of collect-review-texts.js)
const COOKIE_DOMAIN_MAP = {
  'vulture.com': 'vulture',
  'nymag.com': 'vulture',
  'thestage.co.uk': 'thestage',
  'nydailynews.com': 'nydailynews',
  'standard.co.uk': 'standard',
  'hollywoodreporter.com': 'hollywoodreporter',
  'nytimes.com': 'nytimes',
  'newyorker.com': 'newyorker',
  'wsj.com': 'wsj',
  'variety.com': 'variety',
};

const _cookieCache = {};

function loadCookiesForDomain(domain) {
  if (_cookieCache[domain]) return _cookieCache[domain];
  const fileKey = COOKIE_DOMAIN_MAP[domain];
  if (!fileKey) return null;
  const cookiePath = path.join(COOKIES_DIR, `${fileKey}.json`);
  if (!fs.existsSync(cookiePath)) return null;
  try {
    const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
    _cookieCache[domain] = cookies;
    return cookies;
  } catch (e) {
    return null;
  }
}

function buildCookieHeader(url) {
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  // Find matching domain
  let matchedDomain = null;
  for (const domain of Object.keys(COOKIE_DOMAIN_MAP)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      matchedDomain = domain;
      break;
    }
  }
  if (!matchedDomain) return null;

  const cookies = loadCookiesForDomain(matchedDomain);
  if (!cookies) return null;

  return cookies
    .filter(c => c.name && c.value && c.domain)
    .filter(c => {
      const d = c.domain.replace(/^\./, '');
      return hostname === d || hostname.endsWith('.' + d) || d === hostname || d.endsWith('.' + hostname);
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function extractTextFromHtml(html, url) {
  if (!html || typeof html !== 'string') return '';

  // Variety first: the dedicated extractor strips the mid-article promo
  // modules the generic paragraph scrape picks up, and its JSON-LD body is a
  // 100-300 char teaser (BRO-5222).
  if (url && url.includes('variety.com')) {
    const varietyText = extractVarietyBody(html);
    if (varietyText && varietyText.length > 500) return varietyText;
  }

  // Then JSON-LD. A short body can be a teaser of the page prose:
  // chooseArticleBody prefers the page text only when it is the same
  // article, clearly longer.
  const jsonLdText = extractFromJsonLd(html);
  if (jsonLdText && jsonLdText.length > 500) {
    return chooseArticleBody(jsonLdText, extractParagraphText(html)).text;
  }
  return extractParagraphText(html);
}

function isLoginPage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    text.length < 1500 && (
      (lower.includes('sign in') && lower.includes('password')) ||
      (lower.includes('log in') && lower.includes('password')) ||
      (lower.includes('subscriber') && lower.includes('sign in')) ||
      (lower.includes('create an account') && lower.includes('sign in')) ||
      lower.includes('subscribe to continue') ||
      lower.includes('to continue reading')
    )
  );
}

async function fetchWithCookies(url) {
  const cookieHeader = buildCookieHeader(url);
  if (!cookieHeader) throw new Error('No cookies for this domain');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Cookie': cookieHeader,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `https://${new URL(url).hostname}/`,
        'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="122", "Chromium";v="122"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.status === 403 || resp.status === 401) {
      throw new Error(`Auth rejected (HTTP ${resp.status})`);
    }
    if (resp.status === 404) {
      throw new Error('404 Not Found');
    }
    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const html = await resp.text();
    const text = extractTextFromHtml(html, url);

    if (!text || text.length < 200) {
      throw new Error(`Insufficient text: ${text?.length || 0} chars`);
    }

    // Verify it's not still a login page
    if (isLoginPage(text)) {
      throw new Error('Still got login page content');
    }

    return text;
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') throw new Error('Timeout (30s)');
    throw error;
  }
}

async function fetchFromArchiveOrg(url) {
  // Check CDX API for snapshots
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=5&fl=timestamp,statuscode&filter=statuscode:200&sort=reverse`;

  const cdxResp = await fetch(cdxUrl, { signal: AbortSignal.timeout(60000) });
  if (!cdxResp.ok) throw new Error('Archive.org CDX failed');

  const cdxData = await cdxResp.json();
  if (cdxData.length < 2) throw new Error('No archive snapshots');

  // Try most recent snapshot
  const timestamp = cdxData[1][0]; // Skip header row
  const archiveUrl = `https://web.archive.org/web/${timestamp}id_/${url}`;

  const resp = await fetch(archiveUrl, {
    signal: AbortSignal.timeout(60000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  if (!resp.ok) throw new Error(`Archive fetch failed: ${resp.status}`);

  let html = await resp.text();
  // Strip Wayback toolbar
  html = html.replace(/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi, '');

  const text = extractTextFromHtml(html, url);
  if (!text || text.length < 200) throw new Error(`Archive text too short: ${text?.length || 0}`);

  return text;
}

function determineContentTier(text) {
  if (!text) return 'invalid';
  const words = text.split(/\s+/).length;
  if (words >= 300) return 'complete';
  if (words >= 150) return 'truncated';
  if (words >= 50) return 'excerpt';
  if (words >= 20) return 'stub';
  return 'invalid';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const outletFilter = args.find(a => a.startsWith('--outlet='))?.split('=')[1];

  console.log(`\n=== Paywall Cookie Recovery ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (outletFilter) console.log(`Outlet filter: ${outletFilter}`);
  console.log('');

  // Find all target files
  const targets = [];
  const dirs = listShowDirs(REVIEW_TEXTS_DIR);

  for (const dir of dirs) {
    const files = fs.readdirSync(path.join(REVIEW_TEXTS_DIR, dir)).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = path.join(REVIEW_TEXTS_DIR, dir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.wrongFullText || data.fullText) continue;
        if (!isLoginPage(data.wrongFullText)) continue;
        if (!data.url) continue;
        if (outletFilter && !data.outlet?.toLowerCase().includes(outletFilter.toLowerCase())) continue;
        targets.push({ filePath, data, showDir: dir, fileName: file });
      } catch (e) { /* skip */ }
    }
  }

  console.log(`Found ${targets.length} recovery targets\n`);

  const results = { recovered: 0, failed: 0, noUrl: 0, skipped: 0, errors: [] };

  for (let i = 0; i < targets.length; i++) {
    const { filePath, data, showDir, fileName } = targets[i];
    const shortPath = `${showDir}/${fileName}`;
    process.stdout.write(`[${i + 1}/${targets.length}] ${shortPath} (${data.outlet})... `);

    if (dryRun) {
      console.log(`WOULD FETCH: ${data.url}`);
      continue;
    }

    let text = null;
    let source = null;

    // Try 1: Direct HTTP with cookies
    try {
      text = await fetchWithCookies(data.url);
      source = 'cookies';
    } catch (e) {
      // Try 2: Archive.org
      try {
        text = await fetchFromArchiveOrg(data.url);
        source = 'archive.org';
      } catch (e2) {
        const errMsg = `${e.message} → archive: ${e2.message}`;
        console.log(`FAILED: ${errMsg}`);
        results.failed++;
        results.errors.push({ file: shortPath, error: errMsg });
        // Rate limit
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
    }

    if (text) {
      const tier = determineContentTier(text);
      const words = text.split(/\s+/).length;

      // Update the review file
      data.fullText = text;
      delete data.wrongFullText;
      data.contentTier = tier;
      data.recoveredAt = new Date().toISOString();
      data.recoveredFrom = source;
      // Update incomplete reason if it was partial_text
      if (data.incompleteReason === 'partial_text' && tier === 'complete') {
        delete data.incompleteReason;
        delete data.incompleteDetail;
      }
      // Clear stale verification-session fields, preserve classification fields (wrongProduction, isFilmTv, etc.)
      if (data.contentVerification) {
        const VERIFICATION_SESSION_FIELDS = ['wrongArticle', 'verifiedAt', 'verifiedBy', 'reasoning'];
        for (const field of VERIFICATION_SESSION_FIELDS) {
          delete data.contentVerification[field];
        }
      }

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      console.log(`RECOVERED (${source}): ${words} words, tier=${tier}`);
      results.recovered++;
    }

    // Rate limit: 1.5s between requests
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n=== Results ===`);
  console.log(`Recovered: ${results.recovered}`);
  console.log(`Failed: ${results.failed}`);
  if (results.errors.length > 0) {
    console.log(`\nFailed files:`);
    for (const e of results.errors) {
      console.log(`  ${e.file}: ${e.error}`);
    }
  }
}

module.exports = { extractTextFromHtml, isLoginPage };

if (require.main === module) {
  main().catch(console.error);
}
