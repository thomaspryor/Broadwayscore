#!/usr/bin/env node

/**
 * Recover WSJ review full text via a real authenticated browser session.
 *
 * recover-wsj-subscriber.js's plain-fetch() + __NEXT_DATA__.isServerUnlockedContent
 * approach is dead on two independent counts (verified live 2026-08-02, task #779):
 *   1. A bare Node fetch() with valid session cookies gets HTTP 401 — WSJ's edge
 *      appears to gate on TLS/request fingerprint, not just the Cookie header.
 *   2. Even inside a REAL authenticated browser, the server-rendered
 *      __NEXT_DATA__ payload stays paywall-locked (isServerUnlockedContent:
 *      false) for a genuinely active subscriber — full text only appears in
 *      the live DOM after client-side hydration resolves entitlements.
 * So recovery now requires an actual page load + DOM read, not a raw request.
 *
 * Cookies come from data/cookies/wsj.json, produced by scripts/wsj-otp-login.js
 * (the Safari-cookie-extraction replacement — see task #779).
 *
 * Usage:
 *   node scripts/recover-wsj-browser.js --auth-only         # fast health check
 *   node scripts/recover-wsj-browser.js --shows=id1,id2      # targeted re-run
 *   node scripts/recover-wsj-browser.js                      # full candidate sweep
 *
 * Env:
 *   MAX_URLS=N        Limit number of URLs processed (0 = all)
 *   DRY_RUN=true       Discovery only, no file writes
 *   TIME_BUDGET_MIN=N  Wall-clock budget; stops cleanly and checkpoints at the edge
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) {
  console.log('Usage: node scripts/recover-wsj-browser.js [--auth-only] [--shows=id1,id2] [--dry-run]');
  console.log('');
  console.log('Recovers WSJ review full text via a real authenticated browser session');
  console.log('(plain HTTP fetch is dead — see file header). Requires data/cookies/wsj.json');
  console.log('from scripts/wsj-otp-login.js.');
  process.exit(0);
}

const authOnly = args.includes('--auth-only');
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const showsFilter = args.find(a => a.startsWith('--shows='));
const showsAllowlist = showsFilter ? new Set(showsFilter.split('=')[1].split(',')) : null;

const { loadCookiesForDomain } = require('./lib/cookie-loader');
// The gate, the locked writes and the scoped commit/push are shared with every
// other recovery script (BRO-7171); this file keeps only its WSJ specifics.
const { processRecoveredText, stampDead, startRun, checkpoint: sharedCheckpoint, REVIEW_TEXTS_DIR } = require('./lib/browser-recovery-helpers');
const { listShowDirs } = require('./lib/list-show-dirs');

const CONFIG = {
  reviewTextsDir: REVIEW_TEXTS_DIR,
  reportPath: path.join(__dirname, '..', 'data', 'audit', 'wsj-browser-recovery-report.json'),
  minTextLength: 300,
  delayMinMs: 6000,
  delayMaxMs: 12000,
  checkpointInterval: parseInt(process.env.CHECKPOINT_INTERVAL || '8'),
  maxUrls: parseInt(process.env.MAX_URLS || '0') || Infinity,
  timeBudgetMs: process.env.TIME_BUDGET_MIN ? parseInt(process.env.TIME_BUDGET_MIN) * 60000 : Infinity,
};

const TEST_URL = 'https://www.wsj.com/articles/smash-review-an-inside-broadway-musical-bdcafc62';

function jitterDelay() {
  return CONFIG.delayMinMs + Math.random() * (CONFIG.delayMaxMs - CONFIG.delayMinMs);
}

async function extractArticle(page, url) {
  url = url.split('?gaa_')[0];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1800); // let client-side entitlement hydration resolve

  return page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    if (/verification required|slide right to secure/i.test(bodyText)) {
      return { error: 'DataDome challenge detected' };
    }
    const article = document.querySelector('article');
    const text = article ? article.innerText : '';
    const title = document.title || '';
    if (!text) return { error: 'No article element found', title };
    return { text, title, len: text.length };
  });
}

function loadCandidates() {
  const dirs = listShowDirs(CONFIG.reviewTextsDir);
  const candidates = [];
  for (const dir of dirs) {
    if (showsAllowlist && !showsAllowlist.has(dir)) continue;
    const showPath = path.join(CONFIG.reviewTextsDir, dir);

    let files;
    try { files = fs.readdirSync(showPath); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith('wsj') || !f.endsWith('.json')) continue;
      const filePath = path.join(showPath, f);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (data.contentTier === 'complete') continue;
      if (data.wrongShow || data.wrongProduction) continue;
      if (!data.url) continue;

      candidates.push({
        reviewId: `${dir}/${f}`,
        filePath,
        url: data.url,
        showId: data.showId || dir,
        existingChars: (data.fullText || '').length,
        contentTier: data.contentTier || 'unknown',
      });
    }
  }
  // Recency-first: extract a trailing -YYYY year from the showId as a cheap
  // proxy (openingDate/publishDate parsing was too inconsistent across the
  // corpus to rely on — many files carry a stale wrongProduction date instead
  // of the show's real date). Undated ids sort last.
  candidates.sort((a, b) => {
    const ya = (a.showId.match(/-(\d{4})$/) || [])[1] || '0';
    const yb = (b.showId.match(/-(\d{4})$/) || [])[1] || '0';
    return yb.localeCompare(ya);
  });

  return candidates.slice(0, CONFIG.maxUrls);
}

const WSJ_LABELS = {
  fetchMethod: 'wsj-subscriber-browser-session',
  sourceMethod: 'wsj-subscriber-recovery-otp-login',
  contentTierReasonFallback: 'Recovered via authenticated WSJ browser session (task #779)',
};

function checkpoint(stats) {
  return sharedCheckpoint({ ...stats, dryRun }, 'WSJ browser recovery');
}

async function main() {
  const cookies = loadCookiesForDomain('wsj.com');
  if (!cookies) {
    console.error('ERROR: no WSJ cookies available. Run: node scripts/wsj-otp-login.js');
    process.exit(1);
  }
  console.log(`Loaded ${cookies.length} WSJ cookies.`);

  // Bundled headless Chromium gets served a stripped/paywall-locked page even
  // with valid session cookies (verified live 2026-08-02: "No article element
  // found" on every request) — same anti-bot fingerprinting class as #712.
  // Real installed Chrome + a persistent profile is what worked for login
  // (scripts/wsj-otp-login.js); reuse the identical launch strategy here.
  const { chromium } = require('playwright');
  const PROFILE_DIR = '/tmp/wsj-recovery-browser-profile';
  const launchOpts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, { ...launchOpts, channel: 'chrome' });
    console.log('  -> using installed Google Chrome (channel: chrome)');
  } catch (err) {
    console.log(`  -> real Chrome unavailable; falling back to bundled chromium`);
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  }

  // Playwright's addCookies() requires each cookie to carry a valid sameSite
  // value and no undefined fields; our stored shape already matches.
  await context.addCookies(cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires && c.expires > 0 ? c.expires : undefined,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  })));

  const page = context.pages()[0] || (await context.newPage());

  console.log('Testing authentication...');
  const testResult = await extractArticle(page, TEST_URL);
  if (testResult.error || !testResult.text || testResult.len < 1500) {
    console.error(`Auth test FAILED: ${testResult.error || `only ${testResult.len || 0} chars`}`);
    console.error('Cookies may be expired. Re-run: node scripts/wsj-otp-login.js');
    await context.close();
    process.exit(1);
  }
  console.log(`Auth test PASSED — ${testResult.len} chars, title: "${testResult.title}"`);

  if (authOnly) {
    await context.close();
    return;
  }

  // Push/restore anything an earlier run committed but could not land
  // (BRO-7171). Throws on a still-failing push: no new work on a backlog.
  if (!dryRun) startRun();
  const candidates = loadCandidates();
  console.log(`\n${candidates.length} candidates to process.\n`);
  if (candidates.length === 0) {
    await context.close();
    return;
  }

  const stats = { total: candidates.length, recovered: 0, dead: 0, blocked: 0, tooShort: 0, garbage: 0, notMentioned: 0, notLonger: 0 };
  const deadEntries = [];
  const startTime = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    if (Date.now() - startTime > CONFIG.timeBudgetMs) {
      console.log(`\nTime budget reached (${CONFIG.timeBudgetMin || CONFIG.timeBudgetMs / 60000}min) — stopping cleanly.`);
      break;
    }

    const c = candidates[i];
    console.log(`[${i + 1}/${candidates.length}] ${c.showId} (${c.contentTier}, ${c.existingChars} chars existing)`);

    if (i > 0) await page.waitForTimeout(jitterDelay());

    let result;
    try {
      result = await extractArticle(page, c.url);
    } catch (e) {
      result = { error: e.message };
    }

    if (result.error || !result.text) {
      const reason = result.error || 'no text extracted';
      console.log(`  ✗ ${reason}`);
      stats.dead++;
      deadEntries.push({ reviewId: c.reviewId, url: c.url, reason });
      if (!dryRun) {
        // incompleteReason is a controlled-vocabulary field (see scripts/lib/incomplete-reason.js)
        // that collect-review-texts.js/gather-reviews.js gate SERP re-discovery eligibility on
        // ('wrong_content' -> needsSerpDiscovery). A free-text string here silently disables that
        // downstream auto-recovery until the next rebuild-all-reviews.js recomputes it — use the
        // real enum value instead, with our diagnostic in incompleteDetail.
        stampDead(c, {
          incompleteReason: reason === 'DataDome challenge detected' ? 'bot_blocked' : 'wrong_content',
          incompleteDetail: `wsj-browser-recovery: ${reason} (${new Date().toISOString()})`,
        });
      }
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY RUN] would process ${result.len} chars`);
      continue;
    }

    const outcome = processRecoveredText(c, result.text, WSJ_LABELS);
    if (outcome.ok) {
      stats.recovered++;
      console.log(`  ✓ RECOVERED (${outcome.newLen} chars)`);
      if (stats.recovered % CONFIG.checkpointInterval === 0) checkpoint(stats);
    } else {
      console.log(`  ✗ ${outcome.reason}`);
      if (outcome.reason.includes('too short')) stats.tooShort++;
      else if (outcome.reason.includes('garbage')) stats.garbage++;
      else if (outcome.reason.includes('not mentioned')) stats.notMentioned++;
      else if (outcome.reason.includes('not longer')) stats.notLonger++;
      else stats.blocked++;
    }
  }

  // Tracker-driven: also lands dead-candidate stamps when nothing was recovered.
  if (!dryRun) checkpoint(stats);

  fs.writeFileSync(CONFIG.reportPath, JSON.stringify({ ...stats, deadEntries, timestamp: new Date().toISOString(), dryRun }, null, 2) + '\n');

  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Candidates: ${stats.total}`);
  console.log(`  Recovered:  ${stats.recovered}`);
  console.log(`  Dead (stamped incompleteReason): ${stats.dead}`);
  console.log(`  Too short: ${stats.tooShort}  Garbage: ${stats.garbage}  Not mentioned: ${stats.notMentioned}  Not longer: ${stats.notLonger}`);

  await context.close();
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
