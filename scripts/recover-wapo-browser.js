#!/usr/bin/env node

/**
 * Recover WaPo review full text via a real authenticated browser session
 * (task #876, generalizes scripts/recover-wsj-browser.js / recover-nyt-browser.js).
 *
 * fetchPage()'s cookie-plain fetch returns HTTP 404 for washingtonpost.com
 * article URLs even with valid cookies (confirmed live 2026-08-02), and
 * Playwright without a real Chrome channel trips ERR_HTTP2_PROTOCOL_ERROR —
 * same bot-detection shape as WSJ. A real Chrome + real cookies + DOM read
 * sidesteps both.
 *
 * Cookies come from data/cookies/wapo.json, produced by scripts/wapo-login.js.
 *
 * Usage:
 *   node scripts/recover-wapo-browser.js --auth-only         # fast health check
 *   node scripts/recover-wapo-browser.js --shows=id1,id2      # targeted re-run
 *   node scripts/recover-wapo-browser.js                      # full candidate sweep
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
  console.log('Usage: node scripts/recover-wapo-browser.js [--auth-only] [--shows=id1,id2] [--dry-run]');
  console.log('');
  console.log('Recovers WaPo review full text via a real authenticated browser session.');
  console.log('Requires data/cookies/wapo.json from scripts/wapo-login.js.');
  process.exit(0);
}

const authOnly = args.includes('--auth-only');
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const showsFilter = args.find(a => a.startsWith('--shows='));
const showsAllowlist = showsFilter ? new Set(showsFilter.split('=')[1].split(',')) : null;

const { loadCookiesForDomain } = require('./lib/cookie-loader');
const { loadCandidates, processRecoveredText, checkpoint } = require('./lib/browser-recovery-helpers');

const CONFIG = {
  reportPath: path.join(__dirname, '..', 'data', 'audit', 'wapo-browser-recovery-report.json'),
  checkpointInterval: parseInt(process.env.CHECKPOINT_INTERVAL || '8'),
  maxUrls: parseInt(process.env.MAX_URLS || '0') || Infinity,
  timeBudgetMs: process.env.TIME_BUDGET_MIN ? parseInt(process.env.TIME_BUDGET_MIN) * 60000 : Infinity,
  delayMinMs: 6000,
  delayMaxMs: 12000,
};

const TEST_URL = 'https://www.washingtonpost.com/entertainment/theater/2025/09/29/masquerade-phantom-review/';

function jitterDelay() {
  return CONFIG.delayMinMs + Math.random() * (CONFIG.delayMaxMs - CONFIG.delayMinMs);
}

async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1800); // let client-side entitlement hydration resolve

  return page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    if (/unusual activity|verify you.re not a robot|access denied/i.test(bodyText)) {
      return { error: 'Bot-check challenge detected' };
    }
    // .article-body only wraps the lede teaser on some WaPo templates (269
    // chars vs 6693 in <article> on the same page, confirmed live
    // 2026-08-02) — pick whichever candidate selector yields the MOST text
    // rather than trusting selector specificity.
    const candidates = [
      'article[data-qa="article-body"]',
      '[itemprop="articleBody"]',
      '.article-body',
      'article',
    ]
      .map((sel) => document.querySelector(sel))
      .filter(Boolean)
      .map((el) => el.innerText || '');
    const text = candidates.reduce((best, t) => (t.length > best.length ? t : best), '');
    const title = document.title || '';
    if (!text) return { error: 'No article body element found', title };
    return { text, title, len: text.length };
  });
}

async function main() {
  const cookies = loadCookiesForDomain('washingtonpost.com');
  if (!cookies) {
    console.error('ERROR: no WaPo cookies available. Run: node scripts/wapo-login.js');
    process.exit(1);
  }
  console.log(`Loaded ${cookies.length} WaPo cookies.`);

  const { chromium } = require('playwright');
  const PROFILE_DIR = '/tmp/wapo-recovery-browser-profile';
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
  } catch {
    console.log('  -> real Chrome unavailable; falling back to bundled chromium');
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  }

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
  if (testResult.error || !testResult.text || testResult.len < 1000) {
    console.error(`Auth test FAILED: ${testResult.error || `only ${testResult.len || 0} chars`}`);
    console.error('Cookies may be expired. Re-run: node scripts/wapo-login.js');
    await context.close();
    process.exit(1);
  }
  console.log(`Auth test PASSED — ${testResult.len} chars, title: "${testResult.title}"`);

  if (authOnly) {
    await context.close();
    return;
  }

  let candidates;
  try {
    candidates = loadCandidates({ filePrefix: 'washpost', showsAllowlist, maxUrls: CONFIG.maxUrls });
  } catch (e) {
    await context.close();
    throw e;
  }
  console.log(`\n${candidates.length} candidates to process.\n`);
  if (candidates.length === 0) {
    await context.close();
    return;
  }

  const stats = { total: candidates.length, recovered: 0, dead: 0, blocked: 0, tooShort: 0, garbage: 0, notMentioned: 0, notLonger: 0, dryRun };
  const deadEntries = [];
  const startTime = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    if (Date.now() - startTime > CONFIG.timeBudgetMs) {
      console.log(`\nTime budget reached — stopping cleanly.`);
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
      console.log(`  ✗ ${result.error || 'no text extracted'}`);
      stats.dead++;
      deadEntries.push({ reviewId: c.reviewId, url: c.url, reason: result.error || 'no text extracted' });
      if (!dryRun) {
        const data = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
        data.incompleteReason = `wapo-browser-recovery: ${result.error || 'no text extracted'} (${new Date().toISOString()})`;
        fs.writeFileSync(c.filePath, JSON.stringify(data, null, 2) + '\n');
      }
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY RUN] would process ${result.len} chars`);
      continue;
    }

    const outcome = processRecoveredText(c, result.text, {
      fetchMethod: 'wapo-subscriber-browser-session',
      sourceMethod: 'wapo-subscriber-recovery-login',
      contentTierReasonFallback: 'Recovered via authenticated WaPo browser session (task #876)',
    });
    if (outcome.ok) {
      stats.recovered++;
      console.log(`  ✓ RECOVERED (${outcome.newLen} chars)`);
      if (stats.recovered % CONFIG.checkpointInterval === 0) checkpoint(stats, 'WaPo browser recovery');
    } else {
      console.log(`  ✗ ${outcome.reason}`);
      if (outcome.reason.includes('too short')) stats.tooShort++;
      else if (outcome.reason.includes('garbage')) stats.garbage++;
      else if (outcome.reason.includes('not mentioned')) stats.notMentioned++;
      else if (outcome.reason.includes('not longer')) stats.notLonger++;
      else stats.blocked++;
    }
  }

  if (stats.recovered > 0 && !dryRun) checkpoint(stats, 'WaPo browser recovery');

  fs.writeFileSync(CONFIG.reportPath, JSON.stringify({ ...stats, deadEntries, timestamp: new Date().toISOString() }, null, 2) + '\n');

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
