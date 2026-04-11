#!/usr/bin/env node

/**
 * Recover review full text from the Wayback Machine for dead-URL reviews.
 *
 * Targets reviews in failed-fetches.json with failureReason 'url_dead_404'
 * that are currently excerpt-only (no fullText). Queries archive.org CDX API
 * to find snapshots, fetches oldest-first (pre-paywall), extracts text,
 * and updates source files.
 *
 * Usage:
 *   node scripts/recover-wayback-reviews.js
 *
 * Environment variables:
 *   MAX_URLS=100        Limit number of URLs to process (0 = all)
 *   DRY_RUN=true        CDX discovery only, no file writes
 *   TIER_FILTER=1       Only process Tier 1 outlets (1, 2, 3, or empty)
 *   DOMAIN_FILTER=x,y   Only process specific domains (comma-separated)
 *   SOURCE_MODE=reviews-json  Process reviews from reviews.json that have URLs but no review-text files
 *   SOURCE_MODE=not_attempted Process review files with incompleteReason='not_attempted' (URLs never scraped)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

// Shared libraries
const { classifyContentTier, isGarbageContent, validateShowMentioned, countWords } = require('./lib/content-quality');
const { cleanText, stripTrailingJunk } = require('./lib/text-cleaning');
const { extractExplicitScore } = require('./lib/llm-score-extractor');
const { generateReviewFilename } = require('./lib/review-normalization');
const { setExtractedScore } = require('./lib/score-routing');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  reviewTextsDir: path.join(__dirname, '..', 'data', 'review-texts'),
  failedFetchesPath: path.join(__dirname, '..', 'data', 'review-texts', 'failed-fetches.json'),
  reviewsJsonPath: path.join(__dirname, '..', 'data', 'reviews.json'),
  showsPath: path.join(__dirname, '..', 'data', 'shows.json'),
  reportPath: path.join(__dirname, '..', 'data', 'audit', 'wayback-recovery-report.json'),

  // Rate limiting (configurable via env vars for large runs)
  // Tested Feb 19 2026: CDX safe at 1s (60/min), snapshots safe at 1s.
  // Using 1.5s as default for CI (shared GitHub Actions IPs). See memory/archive-org-rate-limits.md
  cdxDelayMs: parseInt(process.env.CDX_DELAY_MS || '1500'),
  snapshotDelayMs: parseInt(process.env.SNAPSHOT_DELAY_MS || '1500'),
  archiveTodayDelayMs: parseInt(process.env.ARCHIVE_TODAY_DELAY_MS || '3000'),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000'),

  // Exhausted URLs tracker — categorized reasons why archive recovery failed
  skipListPath: path.join(__dirname, '..', 'data', 'audit', 'wayback-exhausted.json'),

  // Quality thresholds
  minTextLength: 300,
  maxSnapshotsToTry: 5,

  // Checkpointing (every N recoveries)
  checkpointInterval: parseInt(process.env.CHECKPOINT_INTERVAL || '10'),

  // Circuit breaker
  maxConsecutiveFailures: 10,
  cooldownAfterFailures: 60000, // 60s

  // CLI overrides
  maxUrls: parseInt(process.env.MAX_URLS || '0') || Infinity,
  dryRun: process.env.DRY_RUN === 'true',
  tierFilter: process.env.TIER_FILTER || '',
  domainFilter: process.env.DOMAIN_FILTER ? process.env.DOMAIN_FILTER.split(',').map(d => d.trim()) : [],
  sourceMode: process.env.SOURCE_MODE || 'failed-fetches',
};

// ============================================================================
// Domain-to-tier mapping (from src/config/scoring.ts OUTLET_TIERS)
// ============================================================================

const DOMAIN_TO_TIER = {
  'nytimes.com': 1, 'washingtonpost.com': 1, 'wsj.com': 1,
  'variety.com': 1, 'hollywoodreporter.com': 1, 'vulture.com': 1,
  'nymag.com': 1, 'theguardian.com': 1, 'timeout.com': 1,
  'newyorker.com': 1, 'latimes.com': 1,
  'usatoday.com': 2, 'nydailynews.com': 2, 'nypost.com': 2,
  'ew.com': 2, 'observer.com': 2, 'deadline.com': 2,
  'huffpost.com': 2, 'huffingtonpost.com': 2, 'rollingstone.com': 2,
  'time.com': 2, 'thedailybeast.com': 2, 'dailybeast.com': 2,
  'indiewire.com': 2, 'backstage.com': 2, 'villagevoice.com': 2,
  'newsday.com': 2, 'slate.com': 2, 'billboard.com': 2,
  'northjersey.com': 2, 'amny.com': 2,
};

function getTierForDomain(domain) {
  domain = domain.replace(/^www\./, '');
  return DOMAIN_TO_TIER[domain] || 3;
}

function getTierForUrl(url) {
  try {
    return getTierForDomain(new URL(url).hostname);
  } catch {
    return 3;
  }
}

// ============================================================================
// HTTP helper
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGet(url, timeoutMs = CONFIG.requestTimeoutMs) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        httpGet(redirectUrl, timeoutMs).then(resolve).catch(reject);
        res.resume();
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// ============================================================================
// Wayback Machine CDX API
// ============================================================================

/**
 * Normalize URL for CDX lookup — strip tracking params that prevent archive matches.
 */
function normalizeUrlForCDX(url) {
  try {
    const u = new URL(url);
    // Remove common tracking query params that break CDX matching
    const trackingParams = ['gaa_at', 'gaa_n', 'gaa_ts', 'gaa_sig', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'mod', 'reflink', 'ref'];
    for (const p of trackingParams) u.searchParams.delete(p);
    // If all params were tracking, strip the ? entirely
    return u.searchParams.toString() ? u.toString() : u.origin + u.pathname;
  } catch {
    return url;
  }
}

async function queryCDX(url) {
  const cleanUrl = normalizeUrlForCDX(url);
  if (cleanUrl !== url) {
    console.log(`  CDX normalized: ${cleanUrl.substring(0, 100)}...`);
  }
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(cleanUrl)}&output=json&limit=10&from=2005&to=2026`;

  const response = await httpGet(cdxUrl, 30000);
  if (response.statusCode !== 200) {
    throw new Error(`CDX API returned ${response.statusCode}`);
  }

  let rows;
  try {
    rows = JSON.parse(response.data);
  } catch {
    throw new Error('CDX API returned invalid JSON');
  }

  if (!Array.isArray(rows) || rows.length < 2) {
    return []; // No snapshots
  }

  // First row is header: [urlkey, timestamp, original, mimetype, statuscode, digest, length]
  return rows.slice(1)
    .filter(row => row[4] === '200' && (row[3] || '').includes('text/html'))
    .sort((a, b) => a[1].localeCompare(b[1])) // oldest-first (pre-paywall)
    .map(row => ({
      timestamp: row[1],
      originalUrl: row[2],
      archiveUrl: `https://web.archive.org/web/${row[1]}/${row[2]}`,
    }));
}

// ============================================================================
// Text extraction from HTML
// ============================================================================

/**
 * Strip Wayback Machine toolbar and injections from archived HTML.
 * Must run BEFORE any text extraction or quality gates.
 */
function stripWaybackToolbar(html) {
  if (!html) return html;

  // Remove Wayback Machine toolbar insert
  html = html.replace(/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi, '');

  // Remove Wayback Machine script injections
  html = html.replace(/<script[^>]*src="[^"]*(?:archive\.org|web-static)[^"]*"[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove Wayback Machine <link> injections
  html = html.replace(/<link[^>]*href="[^"]*(?:archive\.org|web-static)[^"]*"[^>]*\/?>/gi, '');

  // Remove wombat.js/analytics
  html = html.replace(/<script[^>]*>[\s\S]*?(?:__wm\.|wombat|WB_wombat|_wmr)[\s\S]*?<\/script>/gi, '');

  // Remove their <style> overrides
  html = html.replace(/<style[^>]*type="text\/css"[^>]*>#wm-ib[\s\S]*?<\/style>/gi, '');

  // Remove Wayback <div id="wm-ib"> container
  html = html.replace(/<div[^>]*id="wm-ib"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');

  return html;
}

/**
 * Extract readable text from HTML, adapted from collect-review-texts.js:3513.
 */
function extractTextFromHtml(html, url) {
  if (!html || typeof html !== 'string') return '';

  // Step 1: Strip Wayback toolbar FIRST
  html = stripWaybackToolbar(html);

  // Step 2: Try JSON-LD articleBody (most reliable when available)
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const jsonContent = match.replace(/<\/?script[^>]*>/gi, '');
        const parsed = JSON.parse(jsonContent);
        const articleBody = parsed.articleBody ||
          (parsed['@graph'] && parsed['@graph'].find(item => item.articleBody)?.articleBody);
        if (articleBody && articleBody.length > 200) {
          return articleBody;
        }
      } catch {}
    }
  }

  // Step 3: Try article-scoped extraction first (much cleaner than whole-page)
  // Match <article> tags, or common article container classes
  const articlePatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*story-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*post-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*review-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*itemprop="articleBody"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of articlePatterns) {
    const articleMatch = html.match(pattern);
    if (articleMatch) {
      const articleHtml = articleMatch[1];
      const articleText = extractParagraphs(articleHtml);
      if (articleText.length > 200) {
        return articleText;
      }
    }
  }

  // Step 4: Fallback — remove noise elements and extract from whole page
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  const pText = extractParagraphs(text);
  if (pText.length > 200) return pText;

  // Step 5: Fallback for old-style HTML (e.g., CurtainUp) using <br> paragraph breaks
  // These sites use bare text with <br><br> instead of <p> tags
  return extractBrSeparatedText(text);
}

/**
 * Extract paragraph text from HTML fragment.
 */
function extractParagraphs(html) {
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(html)) !== null) {
    const pText = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '')).trim();

    if (pText.length > 30 &&
        !pText.toLowerCase().includes('cookie') &&
        !pText.toLowerCase().includes('subscribe') &&
        !pText.toLowerCase().includes('sign up for') &&
        !pText.toLowerCase().includes('advertisement')) {
      paragraphs.push(pText);
    }
  }

  return paragraphs.join('\n\n');
}

/**
 * Extract text from HTML that uses <br> tags instead of <p> tags (old-style sites).
 * Treats <br><br> as paragraph breaks.
 */
function extractBrSeparatedText(html) {
  // Strip remaining HTML tags but preserve <br> as paragraph markers
  let text = html
    .replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '\n\n')  // double br → paragraph break
    .replace(/<br\s*\/?>/gi, '\n')                    // single br → newline
    .replace(/<[^>]+>/g, ' ')                         // strip other tags
    .replace(/[ \t]+/g, ' ');                         // normalize spaces

  text = decodeHtmlEntities(text);

  // Split into paragraphs, filter for content
  const paragraphs = text.split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => {
      if (p.length < 40) return false;
      const lower = p.toLowerCase();
      if (lower.includes('cookie') || lower.includes('subscribe') ||
          lower.includes('sign up for') || lower.includes('advertisement') ||
          lower.includes('back to') || lower.includes('search curtainup') ||
          lower.includes('production notes')) return false;
      return true;
    });

  return paragraphs.join('\n\n');
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8216;/g, '\u2018')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8221;/g, '\u201D')
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#8212;/g, '\u2014')
    .replace(/&#\d+;/g, '');
}

// ============================================================================
// Archive.today fallback
// ============================================================================

async function tryArchiveToday(url) {
  const checkUrl = `https://archive.ph/newest/${url}`;

  try {
    const resp = await httpGet(checkUrl, 15000);
    if (resp.statusCode === 404 || resp.data.length < 500) {
      return null;
    }

    const html = stripWaybackToolbar(resp.data); // archive.today has its own toolbar
    const text = extractTextFromHtml(html, url);

    if (text && text.length >= CONFIG.minTextLength) {
      return { text, html, archiveUrl: checkUrl };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Load candidates
// ============================================================================

function loadCandidates() {
  console.log('Loading candidates...\n');

  const failedFetches = JSON.parse(fs.readFileSync(CONFIG.failedFetchesPath, 'utf8'));
  const deadUrls = failedFetches.filter(f => f.failureReason === 'url_dead_404');
  console.log(`  Total url_dead_404 entries: ${deadUrls.length}`);

  // Load shows for opening dates (for sort priority)
  let shows = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(CONFIG.showsPath, 'utf8'));
    for (const s of (showsData.shows || showsData)) {
      shows[s.id || s.slug] = s;
    }
  } catch {}

  const candidates = [];
  let skippedHasText = 0;
  let skippedNoFile = 0;

  for (const entry of deadUrls) {
    const reviewId = entry.reviewId || `${entry.showId}/${entry.file}`;
    const filePath = path.join(CONFIG.reviewTextsDir, reviewId);

    if (!fs.existsSync(filePath)) {
      skippedNoFile++;
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip if already has fullText
      if (data.fullText && data.fullText.length > 300) {
        skippedHasText++;
        continue;
      }

      // Skip wrongShow/wrongProduction
      if (data.wrongShow || data.wrongProduction) continue;

      const url = data.url || entry.url;
      if (!url) continue;

      const tier = getTierForUrl(url);
      const domain = (() => {
        try { return new URL(url).hostname.replace(/^www\./, ''); }
        catch { return 'unknown'; }
      })();

      // Apply filters
      if (CONFIG.tierFilter && tier !== parseInt(CONFIG.tierFilter)) continue;
      if (CONFIG.domainFilter.length > 0 && !CONFIG.domainFilter.includes(domain)) continue;

      const show = shows[data.showId] || {};
      const openingDate = show.openingDate || '2000-01-01';

      candidates.push({
        reviewId,
        filePath,
        url,
        showId: data.showId,
        outlet: data.outlet || 'unknown',
        outletId: data.outletId || 'unknown',
        criticName: data.criticName || 'unknown',
        tier,
        domain,
        openingDate,
      });
    } catch {}
  }

  // Sort: Tier 1 first, then 2, then 3. Within tier, newest shows first.
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.openingDate.localeCompare(a.openingDate);
  });

  // Apply max limit
  const limited = candidates.slice(0, CONFIG.maxUrls);

  console.log(`  Skipped (already has fullText): ${skippedHasText}`);
  console.log(`  Skipped (no source file): ${skippedNoFile}`);
  console.log(`  Candidates after filters: ${limited.length}`);

  // Tier breakdown
  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const c of limited) tierCounts[c.tier]++;
  console.log(`  Tier 1: ${tierCounts[1]}, Tier 2: ${tierCounts[2]}, Tier 3: ${tierCounts[3]}`);

  // Top domains
  const domainCounts = {};
  for (const c of limited) domainCounts[c.domain] = (domainCounts[c.domain] || 0) + 1;
  const topDomains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`  Top domains: ${topDomains.map(([d, c]) => `${d}(${c})`).join(', ')}`);

  return limited;
}

// ============================================================================
// Load incomplete review candidates (for SOURCE_MODE=incomplete)
// Scans review-texts/ for truncated/excerpt/stub reviews to upgrade via archive
// ============================================================================

function loadIncompleteCandidates() {
  console.log('Loading incomplete review candidates...\n');

  let shows = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(CONFIG.showsPath, 'utf8'));
    for (const s of (showsData.shows || showsData)) {
      shows[s.id || s.slug] = s;
    }
  } catch {}

  // Load exhausted URLs — only skip non-retryable ones (paywalled snapshots, quality failures)
  let skipSet = new Set();
  try {
    const exhaustedData = JSON.parse(fs.readFileSync(CONFIG.skipListPath, 'utf8'));
    const entries = exhaustedData.urls || {};
    for (const [url, info] of Object.entries(entries)) {
      if (!info.retryable) skipSet.add(url);
    }
    console.log(`  Loaded exhausted list: ${Object.keys(entries).length} total, ${skipSet.size} non-retryable (skipped)\n`);
  } catch {}

  const candidates = [];
  let skippedComplete = 0, skippedNoUrl = 0, skippedAlreadyArchived = 0, skippedFlagged = 0, skippedBySkipList = 0, totalScanned = 0;

  const showDirs = fs.readdirSync(CONFIG.reviewTextsDir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  for (const showDir of showDirs) {
    const showPath = path.join(CONFIG.reviewTextsDir, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      totalScanned++;
      const filePath = path.join(showPath, file);
      const reviewId = `${showDir}/${file}`;

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (data.contentTier === 'complete') { skippedComplete++; continue; }
        if (!['truncated', 'excerpt', 'stub'].includes(data.contentTier)) continue;
        if (data.wrongShow || data.wrongProduction) { skippedFlagged++; continue; }

        const url = data.url;
        if (!url) { skippedNoUrl++; continue; }
        if (data.archiveOrgUrl) { skippedAlreadyArchived++; continue; }
        if (skipSet.has(url)) { skippedBySkipList++; continue; }

        const tier = getTierForUrl(url);
        const domain = (() => {
          try { return new URL(url).hostname.replace(/^www\./, ''); }
          catch { return 'unknown'; }
        })();

        if (CONFIG.tierFilter && tier !== parseInt(CONFIG.tierFilter)) continue;
        if (CONFIG.domainFilter.length > 0 && !CONFIG.domainFilter.includes(domain)) continue;

        const show = shows[data.showId] || {};
        const openingDate = show.openingDate || '2000-01-01';

        candidates.push({
          reviewId,
          filePath,
          url,
          showId: data.showId,
          outlet: data.outlet || 'unknown',
          outletId: data.outletId || 'unknown',
          criticName: data.criticName || 'unknown',
          tier,
          domain,
          openingDate,
          existingTextLength: (data.fullText || '').length,
        });
      } catch {}
    }
  }

  // Sort: Tier 1 first, then 2, then 3. Within tier, newest shows first.
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.openingDate.localeCompare(a.openingDate);
  });

  const limited = candidates.slice(0, CONFIG.maxUrls);

  console.log(`  Total review files scanned: ${totalScanned}`);
  console.log(`  Skipped (complete): ${skippedComplete}`);
  console.log(`  Skipped (no URL): ${skippedNoUrl}`);
  console.log(`  Skipped (already archived): ${skippedAlreadyArchived}`);
  console.log(`  Skipped (flagged wrong): ${skippedFlagged}`);
  console.log(`  Skipped (skip-list): ${skippedBySkipList}`);
  console.log(`  Candidates after filters: ${limited.length}${CONFIG.maxUrls < Infinity ? ` (limited from ${candidates.length})` : ''}`);

  // Tier breakdown
  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const c of limited) tierCounts[c.tier]++;
  console.log(`  Tier 1: ${tierCounts[1]}, Tier 2: ${tierCounts[2]}, Tier 3: ${tierCounts[3]}`);

  // Top domains
  const domainCounts = {};
  for (const c of limited) domainCounts[c.domain] = (domainCounts[c.domain] || 0) + 1;
  const topDomains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`  Top domains: ${topDomains.map(([d, c]) => `${d}(${c})`).join(', ')}`);

  if (candidates.length > 500 && CONFIG.maxUrls === Infinity) {
    console.log(`\n  WARNING: ${candidates.length} candidates found. Consider using DOMAIN_FILTER or MAX_URLS to limit scope.`);
  }

  return limited;
}

// ============================================================================
// Load reviews-json candidates (for SOURCE_MODE=reviews-json)
// Finds reviews in reviews.json that have URLs but no review-text files
// ============================================================================

function loadReviewsJsonCandidates() {
  console.log('Loading reviews-json candidates (reviews with URLs but no files)...\n');

  let shows = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(CONFIG.showsPath, 'utf8'));
    for (const s of (showsData.shows || showsData)) {
      shows[s.id || s.slug] = s;
    }
  } catch {}

  const reviewsData = JSON.parse(fs.readFileSync(CONFIG.reviewsJsonPath, 'utf8'));
  const allReviews = reviewsData.reviews || [];
  console.log(`  Total reviews in reviews.json: ${allReviews.length}`);

  const candidates = [];
  let skippedNoUrl = 0, skippedFileExists = 0, skippedFlagged = 0;

  for (const review of allReviews) {
    if (!review.url) { skippedNoUrl++; continue; }
    if (review.wrongShow || review.wrongProduction) { skippedFlagged++; continue; }
    // Skip if already has full text
    if (review.fullText && review.fullText.length > 300) continue;

    const showId = review.showId;
    if (!showId) continue;

    // Generate expected file path
    const filename = generateReviewFilename(review.outlet || review.outletId, review.criticName);
    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const filePath = path.join(showDir, filename);

    // Skip if file already exists (other modes handle those)
    if (fs.existsSync(filePath)) { skippedFileExists++; continue; }

    const url = review.url;
    const tier = getTierForUrl(url);
    const domain = (() => {
      try { return new URL(url).hostname.replace(/^www\./, ''); }
      catch { return 'unknown'; }
    })();

    if (CONFIG.tierFilter && tier !== parseInt(CONFIG.tierFilter)) continue;
    if (CONFIG.domainFilter.length > 0 && !CONFIG.domainFilter.includes(domain)) continue;

    const show = shows[showId] || {};
    const openingDate = show.openingDate || '2000-01-01';

    candidates.push({
      reviewId: `${showId}/${filename}`,
      filePath,
      url,
      showId,
      outlet: review.outlet || 'unknown',
      outletId: review.outletId || 'unknown',
      criticName: review.criticName || 'unknown',
      tier,
      domain,
      openingDate,
      isNewFile: true, // Flag: no existing review-text file
      reviewsJsonData: {
        outlet: review.outlet,
        outletId: review.outletId,
        criticName: review.criticName,
        showId: review.showId,
        url: review.url,
        publishDate: review.publishDate,
        source: review.source,
      },
    });
  }

  // Sort: Tier 1 first, then newest shows
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.openingDate.localeCompare(a.openingDate);
  });

  const limited = candidates.slice(0, CONFIG.maxUrls);

  console.log(`  Skipped (no URL): ${skippedNoUrl}`);
  console.log(`  Skipped (file already exists): ${skippedFileExists}`);
  console.log(`  Skipped (flagged wrong): ${skippedFlagged}`);
  console.log(`  Candidates after filters: ${limited.length}${CONFIG.maxUrls < Infinity ? ` (limited from ${candidates.length})` : ''}`);

  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const c of limited) tierCounts[c.tier]++;
  console.log(`  Tier 1: ${tierCounts[1]}, Tier 2: ${tierCounts[2]}, Tier 3: ${tierCounts[3]}`);

  const domainCounts = {};
  for (const c of limited) domainCounts[c.domain] = (domainCounts[c.domain] || 0) + 1;
  const topDomains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`  Top domains: ${topDomains.map(([d, c]) => `${d}(${c})`).join(', ')}`);

  return limited;
}

// ============================================================================
// Load not-attempted candidates (for SOURCE_MODE=not_attempted)
// Scans review-texts/ for files with incompleteReason='not_attempted' (URLs never scraped)
// ============================================================================

function loadNotAttemptedCandidates() {
  console.log('Loading not-attempted review candidates...\n');

  let shows = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(CONFIG.showsPath, 'utf8'));
    for (const s of (showsData.shows || showsData)) {
      shows[s.id || s.slug] = s;
    }
  } catch {}

  // Load exhausted URLs — skip ALL entries (not just non-retryable) for not_attempted mode
  // because no_archive_coverage entries are written with retryable: false
  let skipSet = new Set();
  try {
    const exhaustedData = JSON.parse(fs.readFileSync(CONFIG.skipListPath, 'utf8'));
    const entries = exhaustedData.urls || {};
    for (const [url] of Object.entries(entries)) {
      skipSet.add(url);
    }
    console.log(`  Loaded exhausted list: ${Object.keys(entries).length} URLs (all skipped in not_attempted mode)\n`);
  } catch {}

  // Also load incomplete-reason classifier for files without incompleteReason set
  let classifyIncompleteReason;
  try {
    classifyIncompleteReason = require('./lib/incomplete-reason').classifyIncompleteReason;
  } catch {}

  const candidates = [];
  let skippedComplete = 0, skippedNoUrl = 0, skippedAlreadyArchived = 0, skippedFlagged = 0;
  let skippedBySkipList = 0, skippedInvalidUrl = 0, totalScanned = 0;

  const showDirs = fs.readdirSync(CONFIG.reviewTextsDir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  for (const showDir of showDirs) {
    const showPath = path.join(CONFIG.reviewTextsDir, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      totalScanned++;
      const filePath = path.join(showPath, file);
      const reviewId = `${showDir}/${file}`;

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Check incompleteReason — either explicitly set or classify on-the-fly
        let reason = data.incompleteReason;
        if (!reason && classifyIncompleteReason) {
          try { reason = classifyIncompleteReason(data, null); } catch {}
        }
        if (reason !== 'not_attempted') continue;

        // Skip already complete
        if (data.contentTier === 'complete') { skippedComplete++; continue; }
        if (data.wrongShow || data.wrongProduction) { skippedFlagged++; continue; }

        const url = data.url;
        if (!url) { skippedNoUrl++; continue; }

        // Skip non-HTTP URLs
        if (!url.startsWith('http://') && !url.startsWith('https://')) { skippedInvalidUrl++; continue; }

        // Skip already recovered via archive
        if (data.archiveOrgUrl) { skippedAlreadyArchived++; continue; }
        if (skipSet.has(url)) { skippedBySkipList++; continue; }

        const tier = getTierForUrl(url);
        const domain = (() => {
          try { return new URL(url).hostname.replace(/^www\./, ''); }
          catch { return 'unknown'; }
        })();

        if (CONFIG.tierFilter && tier !== parseInt(CONFIG.tierFilter)) continue;
        if (CONFIG.domainFilter.length > 0 && !CONFIG.domainFilter.includes(domain)) continue;

        const show = shows[data.showId] || {};
        const openingDate = show.openingDate || '2000-01-01';

        candidates.push({
          reviewId,
          filePath,
          url,
          showId: data.showId,
          outlet: data.outlet || 'unknown',
          outletId: data.outletId || 'unknown',
          criticName: data.criticName || 'unknown',
          tier,
          domain,
          openingDate,
          existingTextLength: (data.fullText || '').length,
        });
      } catch {}
    }
  }

  // Sort: Tier 1 first, then 2, then 3. Within tier, newest shows first.
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.openingDate.localeCompare(a.openingDate);
  });

  const limited = candidates.slice(0, CONFIG.maxUrls);

  console.log(`  Total review files scanned: ${totalScanned}`);
  console.log(`  Skipped (complete): ${skippedComplete}`);
  console.log(`  Skipped (no URL): ${skippedNoUrl}`);
  console.log(`  Skipped (invalid URL): ${skippedInvalidUrl}`);
  console.log(`  Skipped (already archived): ${skippedAlreadyArchived}`);
  console.log(`  Skipped (flagged wrong): ${skippedFlagged}`);
  console.log(`  Skipped (exhausted list): ${skippedBySkipList}`);
  console.log(`  Candidates after filters: ${limited.length}${CONFIG.maxUrls < Infinity ? ` (limited from ${candidates.length})` : ''}`);

  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const c of limited) tierCounts[c.tier]++;
  console.log(`  Tier 1: ${tierCounts[1]}, Tier 2: ${tierCounts[2]}, Tier 3: ${tierCounts[3]}`);

  const domainCounts = {};
  for (const c of limited) domainCounts[c.domain] = (domainCounts[c.domain] || 0) + 1;
  const topDomains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`  Top domains: ${topDomains.map(([d, c]) => `${d}(${c})`).join(', ')}`);

  if (candidates.length > 500 && CONFIG.maxUrls === Infinity) {
    console.log(`\n  WARNING: ${candidates.length} candidates found. Consider using DOMAIN_FILTER or MAX_URLS to limit scope.`);
  }

  return limited;
}

// ============================================================================
// Checkpointing (CI only)
// ============================================================================

function checkpoint(stats) {
  if (!process.env.GITHUB_ACTIONS) {
    console.log(`  [Checkpoint] Skipped (not in CI) — ${stats.recovered} recovered so far`);
    return;
  }

  try {
    execSync('git add data/audit/', { stdio: 'pipe', cwd: path.join(__dirname, '..') });

    // Check if there are staged changes
    try {
      execSync('git diff --staged --quiet', { stdio: 'pipe', cwd: path.join(__dirname, '..') });
      return; // No changes
    } catch {} // Non-zero exit = there ARE changes

    const modeTag = CONFIG.sourceMode !== 'failed-fetches' ? ` (${CONFIG.sourceMode})` : '';
    const msg = `feat: Wayback recovery checkpoint${modeTag} - ${stats.recovered} reviews recovered [T1:${stats.recoveredByTier[1]},T2:${stats.recoveredByTier[2]},T3:${stats.recoveredByTier[3]}]`;
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe', cwd: path.join(__dirname, '..') });

    // Push with retry
    for (let i = 0; i < 5; i++) {
      try {
        execSync('git pull --rebase -X theirs origin main && git push origin main', {
          stdio: 'pipe',
          cwd: path.join(__dirname, '..'),
          timeout: 30000,
        });
        console.log(`  [Checkpoint] Committed and pushed (${stats.recovered} recovered)`);
        return;
      } catch (e) {
        console.log(`  [Checkpoint] Push attempt ${i + 1}/5 failed, retrying...`);
        try { execSync('git rebase --abort', { stdio: 'pipe', cwd: path.join(__dirname, '..') }); } catch {}
        sleep(3000 + Math.random() * 5000);
      }
    }
    console.log('  [Checkpoint] WARNING: Could not push after 5 attempts');
  } catch (e) {
    console.log(`  [Checkpoint] Error: ${e.message}`);
  }
}

// ============================================================================
// Main recovery loop
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       Wayback Machine Review Recovery               ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (CONFIG.dryRun) console.log('*** DRY RUN — no files will be modified ***\n');
  if (CONFIG.sourceMode !== 'failed-fetches') console.log(`Source mode: ${CONFIG.sourceMode}\n`);

  const candidates = CONFIG.sourceMode === 'incomplete'
    ? loadIncompleteCandidates()
    : CONFIG.sourceMode === 'reviews-json'
    ? loadReviewsJsonCandidates()
    : CONFIG.sourceMode === 'not_attempted'
    ? loadNotAttemptedCandidates()
    : loadCandidates();
  if (candidates.length === 0) {
    console.log('\nNo candidates to process.');
    return;
  }

  const stats = {
    totalCandidates: candidates.length,
    cdxFound: 0,
    cdxNotFound: 0,
    recovered: 0,
    recoveredByTier: { 1: 0, 2: 0, 3: 0 },
    recoveredByDomain: {},
    tooShort: 0,
    garbage: 0,
    wrongShow: 0,
    archiveTodayRecovered: 0,
    errors: 0,
    notInArchive: 0,
  };

  let consecutiveFailures = 0;
  let lastCheckpointTime = Date.now();
  const recoveredReviewIds = []; // Track for batch cleanup of failed-fetches.json
  const exhaustedUrls = {}; // Track per-URL failure reasons for wayback-exhausted.json

  // Domain circuit breaker — skip domains with too many consecutive failures
  const domainFailures = {};  // { 'cititour.com': 5, ... }
  const skippedDomains = new Set();
  let domainSkipCount = 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 1: CDX Discovery + Fetch\n');

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const progress = `[${i + 1}/${candidates.length}]`;

    console.log(`${progress} T${c.tier} ${c.domain} — ${c.showId} (${c.criticName})`);
    console.log(`  URL: ${c.url}`);

    // Domain circuit breaker — skip domains with 5+ consecutive failures
    if (skippedDomains.has(c.domain)) {
      console.log(`  → Skipped (domain ${c.domain} circuit-broken)`);
      domainSkipCount++;
      continue;
    }

    // Global circuit breaker
    if (consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
      console.log(`\n  ⚠ Circuit breaker: ${consecutiveFailures} consecutive failures. Pausing ${CONFIG.cooldownAfterFailures / 1000}s...`);
      await sleep(CONFIG.cooldownAfterFailures);
      consecutiveFailures = 0;
    }

    // Step 1: Query CDX
    let snapshots = [];
    try {
      await sleep(CONFIG.cdxDelayMs);
      snapshots = await queryCDX(c.url);
      consecutiveFailures = 0;
    } catch (err) {
      console.log(`  ✗ CDX error: ${err.message}`);
      consecutiveFailures++;
      stats.errors++;
      continue;
    }

    if (snapshots.length === 0) {
      console.log(`  → No archive.org snapshots`);
      stats.cdxNotFound++;

      // Try archive.today as fallback
      if (!CONFIG.dryRun) {
        console.log(`  → Trying archive.today...`);
        await sleep(CONFIG.archiveTodayDelayMs);
        const atResult = await tryArchiveToday(c.url);
        if (atResult) {
          const updateResult = await processRecoveredText(c, atResult.text, atResult.html, {
            archiveUrl: atResult.archiveUrl,
            source: 'archive.today',
          });
          if (updateResult) {
            stats.archiveTodayRecovered++;
            stats.recovered++;
            stats.recoveredByTier[c.tier]++;
            stats.recoveredByDomain[c.domain] = (stats.recoveredByDomain[c.domain] || 0) + 1;
            recoveredReviewIds.push(c.reviewId);
            domainFailures[c.domain] = 0; // Reset domain circuit breaker on success
            console.log(`  ✓ RECOVERED via archive.today (${atResult.text.length} chars)`);

            if (stats.recovered % CONFIG.checkpointInterval === 0) {
              checkpoint(stats);
              lastCheckpointTime = Date.now();
            }
            continue;
          }
        }
      }

      stats.notInArchive++;
      exhaustedUrls[c.url] = { reason: 'no_archive_coverage', lastAttempt: new Date().toISOString(), retryable: false };

      // Domain failure tracking
      domainFailures[c.domain] = (domainFailures[c.domain] || 0) + 1;
      if (domainFailures[c.domain] >= 5) {
        skippedDomains.add(c.domain);
        console.log(`  ⚠ Domain ${c.domain} circuit-broken after ${domainFailures[c.domain]} consecutive failures`);
      }
      continue;
    }

    console.log(`  → CDX: ${snapshots.length} snapshots (oldest: ${snapshots[0].timestamp})`);
    stats.cdxFound++;

    if (CONFIG.dryRun) continue;

    // Step 2: Try snapshots oldest-first
    let recovered = false;
    const maxTries = Math.min(snapshots.length, CONFIG.maxSnapshotsToTry);

    for (let j = 0; j < maxTries; j++) {
      const snapshot = snapshots[j];
      console.log(`  → Trying snapshot ${snapshot.timestamp}...`);

      try {
        await sleep(CONFIG.snapshotDelayMs);
        const response = await httpGet(snapshot.archiveUrl);

        if (response.statusCode !== 200) {
          console.log(`    HTTP ${response.statusCode}, trying next...`);
          continue;
        }

        const text = extractTextFromHtml(response.data, snapshot.originalUrl);

        if (!text || text.length < CONFIG.minTextLength) {
          console.log(`    Only ${text?.length || 0} chars, trying next...`);
          stats.tooShort++;
          continue;
        }

        const updateResult = await processRecoveredText(c, text, response.data, {
          timestamp: snapshot.timestamp,
          archiveUrl: snapshot.archiveUrl,
          source: 'archive.org',
        });

        if (updateResult) {
          stats.recovered++;
          stats.recoveredByTier[c.tier]++;
          stats.recoveredByDomain[c.domain] = (stats.recoveredByDomain[c.domain] || 0) + 1;
          recoveredReviewIds.push(c.reviewId);
          domainFailures[c.domain] = 0; // Reset domain circuit breaker on success
          console.log(`  ✓ RECOVERED (${text.length} chars, snapshot ${snapshot.timestamp})`);
          recovered = true;

          if (stats.recovered % CONFIG.checkpointInterval === 0) {
            checkpoint(stats);
            lastCheckpointTime = Date.now();
          }
          break;
        }
      } catch (err) {
        console.log(`    Error: ${err.message}`);
        // Exponential backoff on rate limiting
        if (err.message.includes('429') || err.message.includes('Too Many')) {
          const backoff = Math.min(120000, 5000 * Math.pow(3, j));
          console.log(`    Rate limited, waiting ${backoff / 1000}s...`);
          await sleep(backoff);
        }
      }
    }

    if (!recovered && !CONFIG.dryRun) {
      // Try archive.today as last resort
      console.log(`  → All snapshots failed, trying archive.today...`);
      await sleep(CONFIG.archiveTodayDelayMs);
      const atResult = await tryArchiveToday(c.url);
      if (atResult) {
        const updateResult = await processRecoveredText(c, atResult.text, atResult.html, {
          archiveUrl: atResult.archiveUrl,
          source: 'archive.today',
        });
        if (updateResult) {
          stats.archiveTodayRecovered++;
          stats.recovered++;
          stats.recoveredByTier[c.tier]++;
          stats.recoveredByDomain[c.domain] = (stats.recoveredByDomain[c.domain] || 0) + 1;
          recoveredReviewIds.push(c.reviewId);
          domainFailures[c.domain] = 0; // Reset domain circuit breaker on success
          console.log(`  ✓ RECOVERED via archive.today (${atResult.text.length} chars)`);

          if (stats.recovered % CONFIG.checkpointInterval === 0) {
            checkpoint(stats);
            lastCheckpointTime = Date.now();
          }
        } else {
          exhaustedUrls[c.url] = { reason: 'content_quality_failed', lastAttempt: new Date().toISOString(), retryable: false };
          domainFailures[c.domain] = (domainFailures[c.domain] || 0) + 1;
          if (domainFailures[c.domain] >= 5 && !skippedDomains.has(c.domain)) {
            skippedDomains.add(c.domain);
            console.log(`  ⚠ Domain ${c.domain} circuit-broken after ${domainFailures[c.domain]} consecutive failures`);
          }
        }
      } else {
        exhaustedUrls[c.url] = { reason: 'snapshots_paywalled', lastAttempt: new Date().toISOString(), retryable: false };
        domainFailures[c.domain] = (domainFailures[c.domain] || 0) + 1;
        if (domainFailures[c.domain] >= 5 && !skippedDomains.has(c.domain)) {
          skippedDomains.add(c.domain);
          console.log(`  ⚠ Domain ${c.domain} circuit-broken after ${domainFailures[c.domain]} consecutive failures`);
        }
      }
    }

    // Time-based checkpoint: save every 5 minutes regardless of recovery count
    if (stats.recovered > 0 && !CONFIG.dryRun && Date.now() - lastCheckpointTime > 5 * 60 * 1000) {
      console.log(`\n  [Time checkpoint] 5+ min since last save, checkpointing...`);
      checkpoint(stats);
      lastCheckpointTime = Date.now();
    }
  }

  // Batch cleanup of failed-fetches.json (at end to avoid rebase conflicts)
  // Skip in incomplete mode — those reviews aren't in failed-fetches.json
  if (!CONFIG.dryRun && recoveredReviewIds.length > 0 && CONFIG.sourceMode === 'failed-fetches') {
    console.log(`\nCleaning up failed-fetches.json (removing ${recoveredReviewIds.length} recovered entries)...`);
    try {
      const ff = JSON.parse(fs.readFileSync(CONFIG.failedFetchesPath, 'utf8'));
      const recoveredSet = new Set(recoveredReviewIds);
      const filtered = ff.filter(f => {
        const id = f.reviewId || `${f.showId}/${f.file}`;
        return !recoveredSet.has(id);
      });
      fs.writeFileSync(CONFIG.failedFetchesPath, JSON.stringify(filtered, null, 2) + '\n');
      console.log(`  Removed ${ff.length - filtered.length} entries (${filtered.length} remaining)`);
    } catch (e) {
      console.log(`  Error cleaning failed-fetches.json: ${e.message}`);
    }
  }

  // Save exhausted URL list (merge with existing, preserve per-URL reasons)
  if (!CONFIG.dryRun && Object.keys(exhaustedUrls).length > 0) {
    try {
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(CONFIG.skipListPath, 'utf8')).urls || {}; } catch {}
      const merged = { ...existing, ...exhaustedUrls };
      const skipDir = path.dirname(CONFIG.skipListPath);
      if (!fs.existsSync(skipDir)) fs.mkdirSync(skipDir, { recursive: true });

      const reasonCounts = {};
      for (const info of Object.values(merged)) {
        reasonCounts[info.reason] = (reasonCounts[info.reason] || 0) + 1;
      }

      fs.writeFileSync(CONFIG.skipListPath, JSON.stringify({
        urls: merged,
        lastUpdated: new Date().toISOString(),
        totalCount: Object.keys(merged).length,
        byReason: reasonCounts,
      }, null, 2) + '\n');

      const newCount = Object.keys(exhaustedUrls).length;
      const existingCount = Object.keys(existing).length;
      console.log(`\nExhausted list updated: ${newCount} new + ${existingCount} existing = ${Object.keys(merged).length} total`);
      console.log(`  By reason: ${Object.entries(reasonCounts).map(([r, c]) => `${r}(${c})`).join(', ')}`);
    } catch (e) {
      console.log(`\nError saving exhausted list: ${e.message}`);
    }
  }

  // Add domain circuit breaker stats
  stats.domainSkipped = domainSkipCount;
  stats.circuitBrokenDomains = Array.from(skippedDomains);

  // Write report
  console.log('\nWriting report...');
  const reportDir = path.dirname(CONFIG.reportPath);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(CONFIG.reportPath, JSON.stringify(stats, null, 2) + '\n');

  // Final checkpoint
  if (!CONFIG.dryRun && stats.recovered > 0) {
    checkpoint(stats);
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log(`║ Candidates:        ${String(stats.totalCandidates).padStart(34)} ║`);
  console.log(`║ CDX snapshots found:${String(stats.cdxFound).padStart(33)} ║`);
  console.log(`║ CDX not found:     ${String(stats.cdxNotFound).padStart(34)} ║`);
  console.log(`║ ────────────────────────────────────────────────── ║`);
  console.log(`║ RECOVERED:         ${String(stats.recovered).padStart(34)} ║`);
  console.log(`║   Tier 1:          ${String(stats.recoveredByTier[1]).padStart(34)} ║`);
  console.log(`║   Tier 2:          ${String(stats.recoveredByTier[2]).padStart(34)} ║`);
  console.log(`║   Tier 3:          ${String(stats.recoveredByTier[3]).padStart(34)} ║`);
  console.log(`║   via archive.today:${String(stats.archiveTodayRecovered).padStart(33)} ║`);
  console.log(`║ Not in archive:    ${String(stats.notInArchive).padStart(34)} ║`);
  console.log(`║ Too short:         ${String(stats.tooShort).padStart(34)} ║`);
  console.log(`║ Garbage:           ${String(stats.garbage).padStart(34)} ║`);
  console.log(`║ Wrong show:        ${String(stats.wrongShow).padStart(34)} ║`);
  console.log(`║ Errors:            ${String(stats.errors).padStart(34)} ║`);
  if (domainSkipCount > 0) {
    console.log(`║ Domain-skipped:    ${String(domainSkipCount).padStart(34)} ║`);
    console.log(`║ Broken domains:    ${String(skippedDomains.size).padStart(34)} ║`);
  }
  console.log('╚══════════════════════════════════════════════════════╝');

  if (Object.keys(stats.recoveredByDomain).length > 0) {
    console.log('\nRecoveries by domain:');
    const sorted = Object.entries(stats.recoveredByDomain).sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted) {
      console.log(`  ${domain}: ${count}`);
    }
  }
}

// ============================================================================
// Process recovered text — quality gate + file update
// ============================================================================

async function processRecoveredText(candidate, text, html, archiveData) {
  // Clean the text
  let cleanedText = cleanText(text);
  cleanedText = stripTrailingJunk(cleanedText, candidate.outletId);

  if (cleanedText.length < CONFIG.minTextLength) {
    console.log(`    Too short after cleaning: ${cleanedText.length} chars`);
    return false;
  }

  // Garbage check — use isGarbageContent for actual garbage patterns (error pages,
  // paywalls, navigation junk). Skip assessTextQuality which is too aggressive for
  // Wayback recovery — critics routinely reference other shows for comparison.
  const garbageCheck = isGarbageContent(cleanedText);
  if (garbageCheck.isGarbage) {
    console.log(`    Garbage content: ${garbageCheck.reason}`);
    return false;
  }

  // Show-mention check — validateShowMentioned returns {valid, confidence, reason}
  const showTitle = candidate.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
  const mentionResult = validateShowMentioned(cleanedText, showTitle, candidate.showId);
  if (!mentionResult.valid) {
    console.log(`    Show not mentioned in text: "${showTitle}"`);
    return false;
  }

  // Read current source file or create new one for reviews-json mode
  let data;
  if (candidate.isNewFile) {
    // Create new review-text file from reviews.json metadata
    const showDir = path.dirname(candidate.filePath);
    if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });
    data = {
      showId: candidate.showId,
      outlet: candidate.outlet,
      outletId: candidate.outletId,
      criticName: candidate.criticName,
      url: candidate.url,
      publishDate: candidate.reviewsJsonData?.publishDate || null,
      source: 'wayback-recovery',
    };
    console.log(`    Creating new review-text file: ${candidate.reviewId}`);
  } else {
    data = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));
  }

  // Length guard for incomplete mode — only accept if meaningfully longer
  if (CONFIG.sourceMode === 'incomplete' && data.fullText) {
    const existingLen = data.fullText.length;
    if (cleanedText.length <= existingLen || (cleanedText.length < existingLen * 1.5 && cleanedText.length < existingLen + 300)) {
      console.log(`    Archive text (${cleanedText.length}) not meaningfully longer than existing (${existingLen}), skip`);
      return false;
    }
    console.log(`    Upgrading: ${existingLen} -> ${cleanedText.length} chars (+${Math.round((cleanedText.length / existingLen - 1) * 100)}%)`);
  }

  // Update with recovered text
  data.fullText = cleanedText;
  data.isFullReview = cleanedText.length > 1500;
  data.textWordCount = countWords(cleanedText);
  data.textFetchedAt = new Date().toISOString();
  data.fetchMethod = 'wayback-recovery';

  // Clear incomplete status — prevents re-processing before next rebuild
  delete data.incompleteReason;
  delete data.incompleteDetail;

  if (archiveData.source === 'archive.org') {
    data.archiveOrgTimestamp = archiveData.timestamp;
    data.archiveOrgUrl = archiveData.archiveUrl;
    data.sourceMethod = 'archive-recovery';
  } else {
    data.archiveTodayUrl = archiveData.archiveUrl;
    data.sourceMethod = 'archive-today-recovery';
  }

  // Content tier reclassification
  const tierResult = classifyContentTier(data);
  data.contentTier = tierResult.contentTier || tierResult.tier;
  data.contentTierReason = tierResult.tierReason || tierResult.reason || 'Recovered from Wayback Machine';

  // Score extraction from recovered HTML via LLM
  if (html || cleanedText) {
    try {
      const scoreResult = await extractExplicitScore({
        text: cleanedText || '',
        html: html || '',
        outletId: candidate.outletId
      });
      if (scoreResult) {
        // Routes to originalScore unless EITHER the incoming source OR the
        // file's existing scoreSource is an aggregator. See lib/score-routing.js.
        // Wayback recovery often hits files already tagged by an aggregator
        // scrape (lbo-css-stars, show-score-stars, …) — without this routing
        // the recovered text-extracted score contaminates originalScore.
        const { field } = setExtractedScore(data, {
          value: scoreResult.originalScore,
          normalizedValue: scoreResult.normalizedScore,
          source: scoreResult.source,
        });
        console.log(`    Found ${field}: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100)`);
      }
    } catch {}
  }

  // Flag for LLM rescoring if previously scored on excerpt
  if (data.llmScore && data.llmScore.score) {
    data.needsRescore = true;
    data.rescoreReason = 'fullText recovered from Wayback Machine';
  }

  // Write updated file
  fs.writeFileSync(candidate.filePath, JSON.stringify(data, null, 2) + '\n');
  return true;
}

// ============================================================================
// Entry point
// ============================================================================

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
