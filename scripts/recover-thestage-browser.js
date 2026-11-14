#!/usr/bin/env node

/**
 * Recover The Stage review full text via a real authenticated browser session
 * (task #876, generalizes scripts/recover-wsj-browser.js / recover-nyt-browser.js;
 * closes task #198 — cookie session has been functionally dead for months
 * despite check-cookie-health.js reporting "Auth OK", because that check only
 * looks at cookie expiry, never whether the session actually authenticates
 * content).
 *
 * Reuses extractArticleText()'s existing extractStageBody() logic (built for
 * task #99/#720-adjacent work against plain-fetched HTML) by grabbing the
 * live authenticated page's full HTML and running it through the same
 * extractor — logged-in HTML has the same aos-Article-IntroText / aos-DS32-WYSEdit
 * shape the extractor already knows how to parse; only the auth path changes.
 *
 * Cookies come from data/cookies/thestage.json, produced by
 * scripts/renew-cookies.js --outlet=thestage.
 *
 * Usage:
 *   node scripts/recover-thestage-browser.js --auth-only         # fast health check
 *   node scripts/recover-thestage-browser.js --shows=id1,id2      # targeted re-run
 *   node scripts/recover-thestage-browser.js                      # full candidate sweep
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
  console.log('Usage: node scripts/recover-thestage-browser.js [--auth-only] [--shows=id1,id2] [--dry-run]');
  console.log('');
  console.log('Recovers The Stage review full text via a real authenticated browser session.');
  console.log('Requires data/cookies/thestage.json from scripts/renew-cookies.js --outlet=thestage.');
  process.exit(0);
}

const authOnly = args.includes('--auth-only');
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const showsFilter = args.find(a => a.startsWith('--shows='));
const showsAllowlist = showsFilter ? new Set(showsFilter.split('=')[1].split(',')) : null;

const { loadCookiesForDomain } = require('./lib/cookie-loader');
const { loadCandidates, processRecoveredText, stampDead, startRun, checkpoint } = require('./lib/browser-recovery-helpers');

const CONFIG = {
  reportPath: path.join(__dirname, '..', 'data', 'audit', 'thestage-browser-recovery-report.json'),
  checkpointInterval: parseInt(process.env.CHECKPOINT_INTERVAL || '8'),
  maxUrls: parseInt(process.env.MAX_URLS || '0') || Infinity,
  timeBudgetMs: process.env.TIME_BUDGET_MIN ? parseInt(process.env.TIME_BUDGET_MIN) * 60000 : Infinity,
  delayMinMs: 6000,
  delayMaxMs: 12000,
};

// Extractor + auth-probe URL shared with the gap-recovery driver (BRO-7171).
const { ADAPTERS } = require('./lib/browser-outlet-adapters');
const TEST_URL = ADAPTERS.thestage.testUrl;
const AUTH_MIN_CHARS = 500;
const { resolveBrowserMiss } = require('./lib/browser-outlet-adapters');

function jitterDelay() {
  return CONFIG.delayMinMs + Math.random() * (CONFIG.delayMaxMs - CONFIG.delayMinMs);
}

const extractArticle = ADAPTERS.thestage.extract;

async function main() {
  // BRO-7171 Stage 3: never overlap the nightly gap-recovery job or another recovery run.
  require('./lib/browser-recovery-helpers').acquireRecoveryRunLock('recover-thestage-browser');
  const cookies = loadCookiesForDomain('thestage.co.uk');
  if (!cookies) {
    console.error('ERROR: no The Stage cookies available. Run: node scripts/renew-cookies.js --outlet=thestage');
    process.exit(1);
  }
  console.log(`Loaded ${cookies.length} The Stage cookies.`);

  const { chromium } = require('playwright');
  // BRO-7171 plan item 8: the outlet's shared persistent profile (renew lock held).
  const PROFILE_DIR = require('./lib/cookie-renew').claimOutletProfile('thestage', { legacy: ['/tmp/thestage-recovery-browser-profile'] }).dir;
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
  if (testResult.error || !testResult.text || testResult.len < AUTH_MIN_CHARS) {
    console.error(`Auth test FAILED: ${testResult.error || `only ${testResult.len || 0} chars`}`);
    console.error('Cookies may be expired. Re-run: node scripts/renew-cookies.js --outlet=thestage');
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
    // Push/restore anything an earlier run committed but could not land
    // (BRO-7171). Throws on a still-failing push: no new work on a backlog.
    if (!dryRun) startRun();
    candidates = loadCandidates({ filePrefix: 'thestage', showsAllowlist, maxUrls: CONFIG.maxUrls });
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

  // A failed push (ReviewTextsPushError) or lock timeout stops the run, but
  // the report is still written and the browser still closed (BRO-7171).
  let runError = null;
  try {
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
        // BRO-7171: a bot check, an access wall or a lost session is never
        // evidence about the review: skip it, or stop the run, never stamp it.
        const miss = await resolveBrowserMiss(result, { probe: () => extractArticle(page, TEST_URL), minAuthChars: AUTH_MIN_CHARS });
        if (miss.action === 'stop') { console.log(`  ✗ ${result.error || 'no text extracted'}; ${miss.reason}: stopping the run`); stats.sessionLost = miss.reason; break; }
        if (miss.action === 'skip') { console.log(`  ✗ ${result.error || 'no text extracted'} (${miss.reason}; not evidence, not stamped)`); stats.skipped = (stats.skipped || 0) + 1; continue; }
        console.log(`  ✗ ${result.error || 'no text extracted'}`);
        stats.dead++;
        deadEntries.push({ reviewId: c.reviewId, url: c.url, reason: result.error || 'no text extracted' });
        if (!dryRun) {
          stampDead(c, { incompleteReason: `thestage-browser-recovery: ${result.error || 'no text extracted'} (${new Date().toISOString()})` });
        }
        continue;
      }

      if (dryRun) {
        console.log(`  [DRY RUN] would process ${result.len} chars`);
        continue;
      }

      const outcome = processRecoveredText(c, result.text, {
        fetchMethod: 'thestage-subscriber-browser-session',
        sourceMethod: 'thestage-subscriber-recovery-login',
        contentTierReasonFallback: 'Recovered via authenticated The Stage browser session (task #876)',
      }, { headline: require('./lib/gap-acceptance').pageHeadline(result.html) });
      if (outcome.ok) {
        stats.recovered++;
        console.log(`  ✓ RECOVERED (${outcome.newLen} chars)`);
        if (stats.recovered % CONFIG.checkpointInterval === 0) checkpoint(stats, 'The Stage browser recovery');
      } else {
        if (outcome.code === 'too_short') {
          const miss = await resolveBrowserMiss(result, { probe: () => extractArticle(page, TEST_URL), minAuthChars: AUTH_MIN_CHARS, refusalCode: 'too_short' });
          if (miss.action === 'stop') { console.log(`  ✗ ${outcome.reason}; ${miss.reason}: stopping the run`); stats.sessionLost = miss.reason; break; }
        }
        console.log(`  ✗ ${outcome.reason}`);
        if (outcome.reason.includes('too short')) stats.tooShort++;
        else if (outcome.reason.includes('garbage')) stats.garbage++;
        else if (outcome.reason.includes('not mentioned')) stats.notMentioned++;
        else if (outcome.reason.includes('not longer')) stats.notLonger++;
        else stats.blocked++;
      }
    }

    // Tracker-driven: also lands dead-candidate stamps when nothing was recovered.
    if (!dryRun) checkpoint(stats, 'The Stage browser recovery');
  } catch (e) {
    runError = e;
  }

  fs.writeFileSync(CONFIG.reportPath, JSON.stringify({ ...stats, deadEntries, timestamp: new Date().toISOString(), error: runError ? runError.message : null }, null, 2) + '\n');

  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Candidates: ${stats.total}`);
  console.log(`  Recovered:  ${stats.recovered}`);
  console.log(`  Dead (stamped incompleteReason): ${stats.dead}`);
  if (stats.sessionLost) console.log(`  Session lost mid-run (${stats.sessionLost}): stopped, nothing stamped after it`);
  if (stats.skipped) console.log(`  Skipped (bot check / access wall, not evidence): ${stats.skipped}`);
  console.log(`  Too short: ${stats.tooShort}  Garbage: ${stats.garbage}  Not mentioned: ${stats.notMentioned}  Not longer: ${stats.notLonger}`);

  await context.close();
  if (runError) throw runError;
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
