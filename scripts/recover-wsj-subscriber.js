#!/usr/bin/env node

/**
 * Recover WSJ review full text using subscriber cookies + plain HTTP.
 *
 * DEPRECATED as of task #779 (2026-08-02) — use scripts/recover-wsj-browser.js
 * instead. Verified live: a plain fetch() with genuinely valid session
 * cookies now gets HTTP 401 (WSJ appears to gate on TLS/request fingerprint,
 * not just the Cookie header), so the "NOVEL APPROACH" below no longer
 * works. Kept for reference/history; not wired into any cron.
 *
 * NOVEL APPROACH: All previous WSJ attempts used browser automation (Playwright,
 * Browserbase) which triggers PerimeterX/DataDome bot detection. This script
 * uses plain HTTP requests with subscriber session cookies — no browser, no JS
 * execution, no bot detection to fight.
 *
 * WSJ serves full article data in __NEXT_DATA__ JSON for authenticated sessions.
 * We extract flattenedBody and convert to clean text.
 *
 * Usage:
 *   node scripts/recover-wsj-subscriber.js
 *
 * Environment variables:
 *   MAX_URLS=100        Limit number of URLs to process (0 = all)
 *   DRY_RUN=true        Discovery only, no file writes
 *   WSJ_COOKIES         Base64-encoded JSON cookie array (CI)
 *   CHECKPOINT_INTERVAL Recoveries between checkpoints (default: 10)
 *   DELAY_MS=2000       Delay between requests in ms (default: 2000)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Shared libraries
const { classifyContentTier, isGarbageContent, validateShowMentioned, countWords } = require('./lib/content-quality');
const { cleanText, stripTrailingJunk } = require('./lib/text-cleaning');
const { loadCookiesForDomain } = require('./lib/cookie-loader');
const { hasHelpFlag } = require('./lib/cli-help');
const { markRescoreFlagged } = require('./lib/rescore-lifecycle');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/recover-wsj-subscriber.js');
  console.log('');
  console.log('DEPRECATED (task #779) — plain fetch() with valid cookies now gets HTTP 401.');
  console.log('Use scripts/recover-wsj-browser.js instead (real browser navigation).');
  process.exit(0);
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  reviewTextsDir: path.join(__dirname, '..', 'data', 'review-texts'),
  showsPath: path.join(__dirname, '..', 'data', 'shows.json'),
  cookiePath: path.join(__dirname, '..', 'data', 'cookies', 'wsj.json'),
  reportPath: path.join(__dirname, '..', 'data', 'audit', 'wsj-subscriber-recovery-report.json'),

  // Rate limiting — be respectful, we're an authenticated subscriber
  // DataDome triggers at ~7 requests with 2s delay; 8-15s with jitter avoids detection
  delayMinMs: parseInt(process.env.DELAY_MIN_MS || '8000'),
  delayMaxMs: parseInt(process.env.DELAY_MAX_MS || '15000'),
  // Legacy: DELAY_MS sets a fixed delay (overrides min/max)
  delayFixedMs: process.env.DELAY_MS ? parseInt(process.env.DELAY_MS) : null,
  requestTimeoutMs: 30000,

  // Browsing break: pause every N requests to look more human
  browsingBreakInterval: parseInt(process.env.BROWSING_BREAK_INTERVAL || '25'),
  browsingBreakMs: 45000, // 45s pause

  // Quality thresholds
  minTextLength: 300,

  // Checkpointing
  checkpointInterval: parseInt(process.env.CHECKPOINT_INTERVAL || '10'),

  // Circuit breaker — DataDome retries instead of hard stop
  maxDataDomeRetries: 3,
  dataDomeCooldownMs: 180000, // 3 minutes
  maxConsecutiveFailures: 10,
  cooldownAfterFailures: 60000,

  // CLI overrides
  maxUrls: parseInt(process.env.MAX_URLS || '0') || Infinity,
  dryRun: process.env.DRY_RUN === 'true',
};

// Cookie loading delegated to shared cookie-loader.js
function loadCookies() {
  return loadCookiesForDomain('wsj.com');
}

function buildCookieHeader(cookies) {
  return cookies
    .filter(c => c.domain && (c.domain.includes('wsj.com') || c.domain.includes('dowjones.com')))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ============================================================================
// HTTP fetch with cookies
// ============================================================================

async function fetchArticle(url, cookieHeader) {
  // Strip Google tracking params
  url = url.split('?gaa_')[0];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Cookie': cookieHeader,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.wsj.com/',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.status !== 200) {
      return { error: `HTTP ${resp.status}`, status: resp.status };
    }

    const html = await resp.text();

    // Check for DataDome challenge
    if (html.includes('captcha-delivery.com') || html.includes('interstitial')) {
      return { error: 'DataDome challenge detected', status: resp.status };
    }

    // Extract __NEXT_DATA__
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) {
      // May be an old URL format without Next.js
      return { error: 'No __NEXT_DATA__ (old URL format?)', status: resp.status, htmlLength: html.length };
    }

    const nextData = JSON.parse(nextDataMatch[1]);
    const pageProps = nextData.props?.pageProps;

    if (!pageProps) {
      return { error: 'No pageProps in __NEXT_DATA__', status: resp.status };
    }

    const articleData = pageProps.articleData;
    if (!articleData?.flattenedBody) {
      return { error: 'No flattenedBody', status: resp.status };
    }

    // Check if we got authenticated access
    const isUnlocked = pageProps.isServerUnlockedContent || pageProps.isFreeArticle;
    if (!isUnlocked) {
      return { error: 'Not authenticated — cookies may be expired', status: resp.status, paywallIndex: pageProps.paywallIndex };
    }

    // Extract text from flattenedBody
    const fullText = extractTextFromBody(articleData.flattenedBody);

    return {
      status: resp.status,
      headline: articleData.headline?.text || articleData.headline,
      published: articleData.publishedDateTimeUtc,
      isUnlocked,
      paywallIndex: pageProps.paywallIndex,
      fullText,
    };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      return { error: 'Request timeout' };
    }
    return { error: e.message };
  }
}

function extractTextFromBody(flattenedBody) {
  if (!Array.isArray(flattenedBody)) return '';

  const extractNode = (node) => {
    if (typeof node === 'string') return node;
    if (node.content) return node.content.map(extractNode).join('');
    if (node.text) return node.text;
    return '';
  };

  let text = '';
  for (const item of flattenedBody) {
    if (item.content) {
      const paragraph = item.content.map(extractNode).join('');
      if (paragraph.trim()) {
        text += paragraph.trim() + '\n\n';
      }
    }
  }

  return text.trim();
}

// ============================================================================
// Load candidates
// ============================================================================

function loadCandidates() {
  console.log('Loading WSJ review candidates...\n');

  let shows = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(CONFIG.showsPath, 'utf8'));
    for (const s of (showsData.shows || showsData)) {
      shows[s.id || s.slug] = s;
    }
  } catch {}

  const candidates = [];
  let skippedComplete = 0;
  let skippedWrongShow = 0;
  let skippedNoUrl = 0;

  const showDirs = fs.readdirSync(CONFIG.reviewTextsDir);
  for (const showDir of showDirs) {
    const showPath = path.join(CONFIG.reviewTextsDir, showDir);
    let stat;
    try { stat = fs.statSync(showPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const files = fs.readdirSync(showPath);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(showPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Only WSJ URLs
        if (!data.url || !data.url.includes('wsj.com')) continue;

        // Skip if already complete
        if (data.contentTier === 'complete') {
          skippedComplete++;
          continue;
        }

        // Skip wrong show/production
        if (data.wrongShow || data.wrongProduction) {
          skippedWrongShow++;
          continue;
        }

        if (!data.url) {
          skippedNoUrl++;
          continue;
        }

        const show = shows[data.showId] || {};
        const openingDate = show.openingDate || '2000-01-01';

        candidates.push({
          reviewId: `${showDir}/${file}`,
          filePath,
          url: data.url,
          showId: data.showId || showDir,
          outlet: data.outlet || 'WSJ',
          outletId: data.outletId || 'wsj',
          criticName: data.criticName || 'unknown',
          contentTier: data.contentTier || 'unknown',
          existingChars: (data.fullText || '').length,
          openingDate,
        });
      } catch {}
    }
  }

  // Sort: newest shows first (most likely to have valid cookies + URLs)
  candidates.sort((a, b) => b.openingDate.localeCompare(a.openingDate));

  // Apply max limit
  const limited = candidates.slice(0, CONFIG.maxUrls);

  console.log(`  Total WSJ reviews found: ${candidates.length + skippedComplete}`);
  console.log(`  Already complete: ${skippedComplete}`);
  console.log(`  Wrong show/production: ${skippedWrongShow}`);
  console.log(`  Candidates to recover: ${limited.length}`);

  // Content tier breakdown
  const tierCounts = {};
  for (const c of limited) tierCounts[c.contentTier] = (tierCounts[c.contentTier] || 0) + 1;
  console.log(`  By tier: ${Object.entries(tierCounts).map(([t, c]) => `${t}(${c})`).join(', ')}`);

  return limited;
}

// ============================================================================
// Process recovered text — update source file
// ============================================================================

function processRecoveredText(candidate, text) {
  // Clean the text
  let cleanedText = cleanText(text);
  cleanedText = stripTrailingJunk(cleanedText, candidate.outletId);

  if (cleanedText.length < CONFIG.minTextLength) {
    console.log(`    Too short after cleaning: ${cleanedText.length} chars`);
    return false;
  }

  // Garbage check
  const garbageCheck = isGarbageContent(cleanedText);
  if (garbageCheck.isGarbage) {
    console.log(`    Garbage content: ${garbageCheck.reason}`);
    return false;
  }

  // Show-mention check
  const showTitle = candidate.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
  const mentionResult = validateShowMentioned(cleanedText, showTitle, candidate.showId);
  if (!mentionResult.valid) {
    console.log(`    Show not mentioned in text: "${showTitle}"`);
    return false;
  }

  // Read current source file
  const data = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));

  // Length guard — only accept if meaningfully longer than existing
  if (data.fullText && data.fullText.length > 0) {
    const existingLen = data.fullText.length;
    if (cleanedText.length <= existingLen) {
      console.log(`    New text (${cleanedText.length}) not longer than existing (${existingLen}), skip`);
      return false;
    }
    console.log(`    Upgrading: ${existingLen} -> ${cleanedText.length} chars (+${Math.round((cleanedText.length / existingLen - 1) * 100)}%)`);
  }

  // Update with recovered text
  data.fullText = cleanedText;
  data.isFullReview = cleanedText.length > 1500;
  data.textWordCount = countWords(cleanedText);
  data.textFetchedAt = new Date().toISOString();
  data.fetchMethod = 'wsj-subscriber-cookie';
  data.sourceMethod = 'wsj-subscriber-recovery';

  // Content tier reclassification
  const tierResult = classifyContentTier(data);
  data.contentTier = tierResult.contentTier || tierResult.tier;
  data.contentTierReason = tierResult.tierReason || tierResult.reason || 'Recovered via WSJ subscriber cookies';

  // Flag for LLM rescoring if previously scored on excerpt
  if (data.llmScore && data.llmScore.score) {
    data.needsRescore = true;
    data.rescoreReason = 'fullText recovered via WSJ subscriber session';
    markRescoreFlagged(data);
  }

  // Write updated file
  fs.writeFileSync(candidate.filePath, JSON.stringify(data, null, 2) + '\n');
  return true;
}

// ============================================================================
// Checkpoint — commit & push progress
// ============================================================================

function checkpoint(stats) {
  if (CONFIG.dryRun) return;

  try {
    execSync('git add data/audit/', { stdio: 'pipe', cwd: path.join(__dirname, '..') });

    // Check if there are staged changes
    try {
      execSync('git diff --staged --quiet', { stdio: 'pipe', cwd: path.join(__dirname, '..') });
      return; // No changes
    } catch {} // Non-zero exit = there ARE changes

    const msg = `feat: WSJ subscriber recovery - ${stats.recovered} reviews recovered [${stats.upgraded} upgraded, ${stats.newText} new text]`;
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe', cwd: path.join(__dirname, '..') });

    // Push with retry
    for (let i = 0; i < 5; i++) {
      try {
        execSync('git pull --rebase -X theirs origin main', {
          stdio: 'pipe',
          cwd: path.join(__dirname, '..'),
          timeout: 30000,
        });
        // -X theirs lets a stale checkout's version beat origin's richer one
        // (Trainspotting The Stage clobber, 2026-07-23). Reconcile protected
        // fields both directions before pushing — same call every other
        // rebase site makes.
        try {
          execSync(`node "${path.join(__dirname, 'lib', 'restore-protected-fields.js')}" origin/main`, {
            stdio: 'pipe',
            cwd: path.join(__dirname, '..'),
          });
          execSync('git add -A && git diff --staged --quiet || git commit --amend --no-edit', {
            stdio: 'pipe',
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, GIT_EDITOR: 'true' },
          });
        } catch { /* non-fatal — push what we have */ }
        execSync('git push origin main', {
          stdio: 'pipe',
          cwd: path.join(__dirname, '..'),
          timeout: 30000,
        });
        console.log(`  [Checkpoint] Committed and pushed (${stats.recovered} recovered)`);
        return;
      } catch {
        console.log(`  [Checkpoint] Push attempt ${i + 1}/5 failed, retrying...`);
        try { execSync('git rebase --abort', { stdio: 'pipe', cwd: path.join(__dirname, '..') }); } catch {}
        const delay = 3000 + Math.random() * 5000;
        const start = Date.now();
        while (Date.now() - start < delay) {} // sync sleep
      }
    }
    console.log('  [Checkpoint] WARNING: Could not push after 5 attempts');
  } catch (e) {
    console.log(`  [Checkpoint] Error: ${e.message}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('====================================================');
  console.log('  WSJ Subscriber Cookie Recovery');
  console.log('  (Plain HTTP — no browser automation)');
  console.log('====================================================\n');

  if (CONFIG.dryRun) console.log('*** DRY RUN — no files will be modified ***\n');

  // Load cookies
  const cookies = loadCookies();
  if (!cookies) {
    console.error('ERROR: No WSJ cookies available. Set WSJ_COOKIES env var or place cookies in data/cookies/wsj.json');
    process.exit(1);
  }

  const cookieHeader = buildCookieHeader(cookies);
  console.log(`  Cookie header: ${cookieHeader.length} chars\n`);

  // Quick auth test
  console.log('Testing authentication...');
  const testUrl = 'https://www.wsj.com/articles/a-beautiful-noise-the-neil-diamond-musical-review-broadway-jukebox-will-swenson-11670022072';
  const testResult = await fetchArticle(testUrl, cookieHeader);
  if (testResult.error) {
    console.error(`Auth test FAILED: ${testResult.error}`);
    console.error('Cookies may be expired. Re-export from Safari and update WSJ_COOKIES.');
    process.exit(1);
  }
  if (!testResult.isUnlocked) {
    console.error('Auth test FAILED: Not authenticated (isServerUnlockedContent is false)');
    console.error('Cookies may be expired. Re-export from Safari and update WSJ_COOKIES.');
    process.exit(1);
  }
  console.log(`  Auth test PASSED — ${testResult.fullText.length} chars, headline: "${testResult.headline}"\n`);

  // Load candidates
  const candidates = loadCandidates();
  if (candidates.length === 0) {
    console.log('\nNo candidates to process.');
    return;
  }

  const stats = {
    totalCandidates: candidates.length,
    recovered: 0,
    upgraded: 0,
    newText: 0,
    http401: 0,
    noNextData: 0,
    notAuthenticated: 0,
    tooShort: 0,
    garbage: 0,
    errors: 0,
  };

  let consecutiveFailures = 0;
  let lastCheckpointTime = Date.now();

  console.log(`\n${'='.repeat(60)}`);
  console.log('Recovery Loop\n');

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const progress = `[${i + 1}/${candidates.length}]`;

    console.log(`${progress} ${c.showId} (${c.criticName}) — ${c.contentTier}, ${c.existingChars} chars`);

    // Circuit breaker
    if (consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
      console.log(`\n  Circuit breaker: ${consecutiveFailures} consecutive failures. Pausing ${CONFIG.cooldownAfterFailures / 1000}s...`);
      await new Promise(r => setTimeout(r, CONFIG.cooldownAfterFailures));
      consecutiveFailures = 0;
    }

    // Rate limiting — jittered delays to avoid DataDome pattern detection
    if (i > 0) {
      const delay = CONFIG.delayFixedMs
        ? CONFIG.delayFixedMs
        : CONFIG.delayMinMs + Math.random() * (CONFIG.delayMaxMs - CONFIG.delayMinMs);
      await new Promise(r => setTimeout(r, Math.round(delay)));

      // Browsing break every N requests
      if (i % CONFIG.browsingBreakInterval === 0) {
        const breakMs = CONFIG.browsingBreakMs + Math.random() * 15000;
        console.log(`  [Browsing break] Pausing ${Math.round(breakMs / 1000)}s after ${i} requests...`);
        await new Promise(r => setTimeout(r, breakMs));
      }
    }

    // Fetch with DataDome retry
    let result;
    let dataDomeRetries = 0;

    while (true) {
      result = await fetchArticle(c.url, cookieHeader);

      if (result.error && result.error.includes('DataDome') && dataDomeRetries < CONFIG.maxDataDomeRetries) {
        dataDomeRetries++;
        const cooldown = CONFIG.dataDomeCooldownMs + Math.random() * 60000;
        console.log(`  ⚠ DataDome detected — cooling down ${Math.round(cooldown / 1000)}s (retry ${dataDomeRetries}/${CONFIG.maxDataDomeRetries})...`);
        // Checkpoint before long pause
        if (stats.recovered > 0 && !CONFIG.dryRun) checkpoint(stats);
        await new Promise(r => setTimeout(r, cooldown));
        continue;
      }
      break;
    }

    if (result.error) {
      console.log(`  ✗ ${result.error}`);
      consecutiveFailures++;

      if (result.status === 401) stats.http401++;
      else if (result.error.includes('No __NEXT_DATA__')) stats.noNextData++;
      else if (result.error.includes('Not authenticated')) stats.notAuthenticated++;
      else stats.errors++;

      // If auth failure, stop — cookies are dead
      if (result.error.includes('Not authenticated')) {
        console.log('\n  FATAL: Auth failure — cookies expired. Stopping.');
        break;
      }
      // DataDome after all retries exhausted — stop
      if (result.error.includes('DataDome')) {
        console.log('\n  FATAL: DataDome persisted after all retries. Stopping.');
        break;
      }
      continue;
    }

    consecutiveFailures = 0;

    if (CONFIG.dryRun) {
      console.log(`  ✓ [DRY RUN] Would recover ${result.fullText.length} chars (existing: ${c.existingChars})`);
      if (result.fullText.length > c.existingChars) stats.recovered++;
      continue;
    }

    // Process the recovered text
    const success = processRecoveredText(c, result.fullText);
    if (success) {
      stats.recovered++;
      if (c.existingChars > 0) stats.upgraded++;
      else stats.newText++;
      console.log(`  ✓ RECOVERED (${result.fullText.length} chars)`);

      // Checkpoint
      if (stats.recovered % CONFIG.checkpointInterval === 0) {
        checkpoint(stats);
        lastCheckpointTime = Date.now();
      }
    } else {
      stats.tooShort++;
    }

    // Time-based checkpoint every 5 minutes
    if (stats.recovered > 0 && !CONFIG.dryRun && Date.now() - lastCheckpointTime > 5 * 60 * 1000) {
      console.log(`\n  [Time checkpoint] 5+ min since last save, checkpointing...`);
      checkpoint(stats);
      lastCheckpointTime = Date.now();
    }
  }

  // Final checkpoint
  if (stats.recovered > 0 && !CONFIG.dryRun) {
    console.log('\nFinal checkpoint...');
    checkpoint(stats);
  }

  // Save report
  const report = {
    ...stats,
    timestamp: new Date().toISOString(),
    dryRun: CONFIG.dryRun,
    maxUrls: CONFIG.maxUrls === Infinity ? 'all' : CONFIG.maxUrls,
    delayMs: CONFIG.delayMs,
  };
  fs.writeFileSync(CONFIG.reportPath, JSON.stringify(report, null, 2) + '\n');

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Candidates: ${stats.totalCandidates}`);
  console.log(`  Recovered:  ${stats.recovered} (${stats.upgraded} upgraded, ${stats.newText} new text)`);
  console.log(`  HTTP 401:   ${stats.http401} (old URL format)`);
  console.log(`  No NextData:${stats.noNextData}`);
  console.log(`  Not auth'd: ${stats.notAuthenticated}`);
  console.log(`  Too short:  ${stats.tooShort}`);
  console.log(`  Errors:     ${stats.errors}`);
  console.log(`${'='.repeat(60)}`);
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
