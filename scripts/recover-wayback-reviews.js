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
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

// Shared libraries
const { classifyContentTier, isGarbageContent, validateShowMentioned, countWords } = require('./lib/content-quality');
const { cleanText, stripTrailingJunk } = require('./lib/text-cleaning');
const { extractScore } = require('./lib/score-extractors');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  reviewTextsDir: path.join(__dirname, '..', 'data', 'review-texts'),
  failedFetchesPath: path.join(__dirname, '..', 'data', 'review-texts', 'failed-fetches.json'),
  showsPath: path.join(__dirname, '..', 'data', 'shows.json'),
  reportPath: path.join(__dirname, '..', 'data', 'audit', 'wayback-recovery-report.json'),

  // Rate limiting
  cdxDelayMs: 2000,
  snapshotDelayMs: 2000,
  archiveTodayDelayMs: 3000,
  requestTimeoutMs: 20000,

  // Quality thresholds
  minTextLength: 300,
  maxSnapshotsToTry: 5,

  // Checkpointing
  checkpointInterval: 25,

  // Circuit breaker
  maxConsecutiveFailures: 10,
  cooldownAfterFailures: 60000, // 60s

  // CLI overrides
  maxUrls: parseInt(process.env.MAX_URLS || '0') || Infinity,
  dryRun: process.env.DRY_RUN === 'true',
  tierFilter: process.env.TIER_FILTER || '',
  domainFilter: process.env.DOMAIN_FILTER ? process.env.DOMAIN_FILTER.split(',').map(d => d.trim()) : [],
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

async function queryCDX(url) {
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=10&from=2005&to=2026`;

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

  return extractParagraphs(text);
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
// Checkpointing (CI only)
// ============================================================================

function checkpoint(stats) {
  if (!process.env.GITHUB_ACTIONS) {
    console.log(`  [Checkpoint] Skipped (not in CI) — ${stats.recovered} recovered so far`);
    return;
  }

  try {
    execSync('git add data/review-texts/ data/audit/', { stdio: 'pipe', cwd: path.join(__dirname, '..') });

    // Check if there are staged changes
    try {
      execSync('git diff --staged --quiet', { stdio: 'pipe', cwd: path.join(__dirname, '..') });
      return; // No changes
    } catch {} // Non-zero exit = there ARE changes

    const msg = `feat: Wayback recovery checkpoint - ${stats.recovered} reviews recovered [T1:${stats.recoveredByTier[1]},T2:${stats.recoveredByTier[2]},T3:${stats.recoveredByTier[3]}]`;
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

  const candidates = loadCandidates();
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
  const recoveredReviewIds = []; // Track for batch cleanup of failed-fetches.json

  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 1: CDX Discovery + Fetch\n');

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const progress = `[${i + 1}/${candidates.length}]`;

    console.log(`${progress} T${c.tier} ${c.domain} — ${c.showId} (${c.criticName})`);
    console.log(`  URL: ${c.url}`);

    // Circuit breaker
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
            console.log(`  ✓ RECOVERED via archive.today (${atResult.text.length} chars)`);

            if (stats.recovered % CONFIG.checkpointInterval === 0) {
              checkpoint(stats);
            }
            continue;
          }
        }
      }

      stats.notInArchive++;
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
          console.log(`  ✓ RECOVERED (${text.length} chars, snapshot ${snapshot.timestamp})`);
          recovered = true;

          if (stats.recovered % CONFIG.checkpointInterval === 0) {
            checkpoint(stats);
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
          console.log(`  ✓ RECOVERED via archive.today (${atResult.text.length} chars)`);

          if (stats.recovered % CONFIG.checkpointInterval === 0) {
            checkpoint(stats);
          }
        }
      }
    }
  }

  // Batch cleanup of failed-fetches.json (at end to avoid rebase conflicts)
  if (!CONFIG.dryRun && recoveredReviewIds.length > 0) {
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

  // Read current source file
  const data = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));

  // Update with recovered text
  data.fullText = cleanedText;
  data.isFullReview = cleanedText.length > 1500;
  data.textWordCount = countWords(cleanedText);
  data.textFetchedAt = new Date().toISOString();
  data.fetchMethod = 'wayback-recovery';

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

  // Score extraction from recovered HTML
  if (html) {
    try {
      const scoreResult = extractScore(html, cleanedText, candidate.outletId);
      if (scoreResult && scoreResult.originalScore) {
        data.originalScore = scoreResult.originalScore;
        data.originalScoreNormalized = scoreResult.normalizedScore;
        console.log(`    Found original score: ${scoreResult.originalScore}`);
      }
    } catch {}
  }

  // Flag for LLM rescoring if previously scored on excerpt
  if (data.llmScore && data.llmScore.score) {
    data.needsRescore = true;
    data.rescoreReason = 'fullText recovered from Wayback Machine';
    data.previousLlmScore = data.llmScore.score;
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
