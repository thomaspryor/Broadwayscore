#!/usr/bin/env node
/**
 * Re-collect review HTML from outlet websites to extract explicit scores.
 *
 * Targets reviews that have a URL but no originalScore, for outlets with
 * dedicated score extractors. Fetches the URL, runs the extractor on
 * the raw HTML, and updates the review file if a score is found.
 *
 * Usage:
 *   node scripts/recollect-for-scores.js --outlet=timeout [--limit=5] [--execute] [--delay=2000]
 *
 * Options:
 *   --outlet=X   Required. Outlet ID to re-collect for
 *   --limit=N    Process at most N reviews (default: 5 for safety)
 *   --execute    Actually write changes (default: dry run that still fetches)
 *   --delay=N    Delay between requests in ms (default: 2000)
 *   --dry-run    Don't fetch, just list targets
 *   --tier15-cleared  (BRO-4490) also target files whose star a tier-1.5 audit
 *                cleared ("extraction-no-evidence-in-text") at an outlet the
 *                rebuild trusts for that clear (isTier15OverrideActive). A fresh
 *                star is written only when it comes from the page structure
 *                (isScoreClearSupersededBy), which retires the clear; then
 *                late-star-anchor queues the anchored re-score.
 *   --files=<show>/<file>.json,...  only consider these files (an approved-fix
 *                plan names the exact rows to refetch instead of the outlet's
 *                whole backlog).
 *   --time-budget-min=N  (BRO-5675) stop starting new reviews once less than
 *                one worst-case item is left in N minutes; exit 0 with the
 *                remaining count. The weekly workflow passes what is left of
 *                its step budget to each outlet.
 *
 * Attempts are logged in data/audit/recollect-scores-state.json (see
 * lib/recollect-state.js): least-recently-attempted reviews go first and a
 * fetch error backs off for weeks instead of retrying every run.
 */

const fs = require('fs');
const path = require('path');

// Load .env if available (must run before requiring ./lib/scraper, which
// snapshots BRIGHTDATA_TOKEN/SCRAPINGBEE_API_KEY into module-level consts
// at require-time, so loading .env afterward is a no-op)
require('./lib/load-env').loadEnv();

const { extractScore, OUTLET_EXTRACTORS, EXTRACTOR_VERSION, OUTLET_VERIFIED_SOURCES } = require('./lib/score-extractors');
const { fetchPage: fetchPageScraper, cleanup: cleanupScraper } = require('./lib/scraper');
const { setExtractedScore, isScoreClearSupersededBy } = require('./lib/score-routing');
const { isTier15OverrideActive } = require('./lib/rebuild-helpers');
const { AGGREGATOR_DOMAINS } = require('./lib/aggregator-domains');
const { listShowDirs } = require('./lib/list-show-dirs');
const { writableShowIds } = require('./lib/opening-night-lane/lease-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { withDeadline } = require('./lib/cron-deadline');
const { loadState, saveState, orderTargets, recordAttempt, pruneState } = require('./lib/recollect-state');

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const STATE_FILE = path.join(__dirname, '..', 'data', 'audit', 'recollect-scores-state.json');

// fetchPage()'s worst case is ~270s (Scrapingdog 2x45s, Bright Data 45s,
// ScrapingBee 45s, Playwright tier 90s), and those are idle timeouts, so cap
// one fetch at 300s. The client-rendered Playwright retry is goto 30s + 3s wait.
const FETCH_DEADLINE_MS = 300_000;
const RETRY_DEADLINE_MS = 60_000;
// Don't start an item that can't finish: one fetch + the retry + delay + slack.
const MIN_REMAINING_MS_TO_START = FETCH_DEADLINE_MS + RETRY_DEADLINE_MS + 30_000;
// An outlet whose every fetch fails (culturesauce, 70/70 on 2026-10-18) is one
// outage, not N URL failures: stop the outlet after this many in a row.
const MAX_CONSECUTIVE_ERRORS = 8;

// Parse args
const args = process.argv.slice(2);
const outletArg = args.find(a => a.startsWith('--outlet='));
const limitArg = args.find(a => a.startsWith('--limit='));
const delayArg = args.find(a => a.startsWith('--delay='));
const execute = args.includes('--execute');
const dryRun = args.includes('--dry-run');
const replaceAggregator = args.includes('--replace-aggregator');
const tier15Cleared = args.includes('--tier15-cleared');
const filesArg = args.find(a => a.startsWith('--files='));
const onlyFiles = filesArg ? new Set(filesArg.slice('--files='.length).split(',').filter(Boolean)) : null;
const outlet = outletArg ? outletArg.split('=')[1] : null;
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 5;
const delay = delayArg ? parseInt(delayArg.split('=')[1]) : 2000;
const budget = createRunBudget(parseTimeBudgetMin(args));

// Replaceable score sources — aggregators (not outlet's own) + low-reliability extractions
const AGGREGATOR_SOURCES = new Set([
  'westendtheatre-star-rating', 'thestage-roundup-star-rating',
  'lbo-star-rating', 'stagedoor-star-rating', 'theatre-reviews-star-rating',
  'show-score-stars', 'show-score-playwright', 'bestoftheatre-star-rating',
  'css-stars',          // Generic CSS extraction — often reads sidebar/wrong element
  'lbo-css-stars',      // LBO CSS extraction — sometimes wrong element
  'numeric-stars',      // Generic "X/5" pattern — false positives from pagination
]);

if (!outlet) {
  console.error('Usage: node scripts/recollect-for-scores.js --outlet=timeout [--limit=5] [--execute]');
  process.exit(1);
}

if (!OUTLET_EXTRACTORS[outlet]) {
  console.error(`No extractor for outlet "${outlet}". Available outlets with extractors:`);
  const available = Object.keys(OUTLET_EXTRACTORS).filter(k =>
    OUTLET_EXTRACTORS[k] && OUTLET_EXTRACTORS[k].name !== 'noScoreExtractor'
  ).sort();
  console.error(available.join(', '));
  process.exit(1);
}

if (OUTLET_EXTRACTORS[outlet] && OUTLET_EXTRACTORS[outlet].name === 'noScoreExtractor') {
  console.error(`Outlet "${outlet}" is marked noScoreExtractor — this outlet publishes text-only reviews with no star ratings.`);
  console.error('Re-collection would fetch pages but never find ratings. Exiting to prevent wasted scraping.');
  process.exit(1);
}

// Cookie domain map from shared cookie-loader (full map, not just UK outlets)
const { COOKIE_DOMAIN_MAP, loadCookiesForDomain: _loadCookiesForDomain } = require('./lib/cookie-loader');

function loadCookiesForUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    for (const domain of Object.keys(COOKIE_DOMAIN_MAP)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        const cookies = _loadCookiesForDomain(domain);
        if (cookies) return { cookies, domain };
      }
    }
  } catch (e) { /* skip */ }
  return null;
}

let _browser;
let _context;

async function ensureBrowser() {
  if (_browser) return;
  const { chromium } = require('playwright');
  _browser = await chromium.launch({ headless: true });
  _context = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
}

async function fetchUrl(url) {
  const cookieData = loadCookiesForUrl(url);

  // fetchPage() owns the whole tier chain (cookies-plain -> SD -> BD -> SB -> Playwright)
  // and attaches subscriber cookies itself (BRO-32: no direct ScrapingBee here).
  if (!cookieData) {
    const { content } = await fetchPageScraper(url);
    return content;
  }
  try {
    const { content } = await fetchPageScraper(url);
    if (content && content.length > 500) return content;
    console.log(`  fetchPage returned ${content ? content.length : 0} chars, trying Playwright...`);
  } catch (e) {
    console.log(`  fetchPage failed: ${e.message}, trying Playwright...`);
  }

  // Playwright fallback for paywalled sites with full cookie set
  await ensureBrowser();
  if (cookieData) {
    const playwrightCookies = cookieData.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      ...(c.expires ? { expires: c.expires } : {}),
      httpOnly: c.httpOnly || false,
      secure: c.secure || false,
      sameSite: c.sameSite === 'None' ? 'None' : 'Lax',
    })).filter(c => c.name && c.value && c.domain);
    try {
      await _context.addCookies(playwrightCookies);
    } catch (e) { /* skip */ }
  }

  const page = await _context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    return await page.content();
  } finally {
    await page.close();
  }
}

// A timed-out fetch keeps running in the background; reset the scraper's
// shared browser so the next item does not share a page with it.
async function fetchItem(url) {
  try {
    return await withDeadline(() => fetchUrl(url), FETCH_DEADLINE_MS, 'Fetch');
  } catch (e) {
    if (/wall-clock timeout/.test(e.message)) {
      await withDeadline(() => cleanupScraper(), 15000, 'Scraper cleanup').catch(() => {});
      // Paywalled outlets fetch through this script's own browser: drop it too.
      if (_browser) {
        const b = _browser;
        _browser = null;
        _context = null;
        await withDeadline(() => b.close(), 10000, 'Browser close').catch(() => {});
      }
    }
    // Only a failed fetch earns the error backoff; a bug in this script must not
    // park the backlog for weeks.
    e.isFetchError = true;
    throw e;
  }
}

async function main() {
  console.log(`\n=== Re-collect for Scores: ${outlet} ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (listing only)' : execute ? 'EXECUTING' : 'FETCH + PREVIEW (no writes)'}`);
  console.log(`Limit: ${limit} | Delay: ${delay}ms\n`);

  // Find targets
  // BRO-6648 S1-T4: shows the opening-night lane holds are the lane's to write.
  const showDirs = writableShowIds(listShowDirs(REVIEW_DIR), { label: 'recollect' });

  const targets = [];
  for (const dir of showDirs) {
    const files = fs.readdirSync(path.join(REVIEW_DIR, dir))
      .filter(f => f.startsWith(outlet + '--') && f.endsWith('.json'));

    for (const file of files) {
      if (onlyFiles && !onlyFiles.has(`${dir}/${file}`)) continue;
      const fp = path.join(REVIEW_DIR, dir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        // Skip if already has a verified outlet score — but re-extract if score came from
        // Show Score (SS assigns its own stars, wrong ~11% of the time) or aggregators
        const isSSSource = data.source === 'show-score' || data.source === 'show-score-playwright' || data.source === 'showscore-roundup';
        const hasUnverifiedSSScore = isSSSource && data.originalScore && !OUTLET_VERIFIED_SOURCES.has(data.scoreSource);
        const hasAggregatorScore = replaceAggregator && data.originalScore && AGGREGATOR_SOURCES.has(data.scoreSource);
        // Deliberately cleared by P0 audit (a tier-1.5 clear is retried on request)
        if (data.originalScoreCleared && !(tier15Cleared && isTier15OverrideActive(data))) continue;
        if (data.originalScore && !hasUnverifiedSSScore && !hasAggregatorScore) continue;
        if (!data.url) continue; // No URL to fetch
        // Skip reviews where URL points to an aggregator (contaminated data)
        try {
          const urlHost = new URL(data.url).hostname.replace(/^www\./, '');
          if (AGGREGATOR_DOMAINS.has(urlHost)) continue;
        } catch {
          // Not an absolute URL (e.g. a stored relative "/people/..." path):
          // every provider rejects it, so fetching only burns credits (BRO-3501).
          continue;
        }
        if (data.wrongShow) continue; // Flagged as wrong content
        if (data.wrongProduction) continue; // URL is for a different production
        // Skip if already checked with current extractor version
        const checkedVersion = data._noScoreExtractorVersion || 0;
        if (data._noScoreOnHtml && checkedVersion >= EXTRACTOR_VERSION) continue;
        if (data._noScoreOnHtml && checkedVersion < EXTRACTOR_VERSION) {
          console.log(`  Retrying ${file} (extractor updated: v${checkedVersion} -> v${EXTRACTOR_VERSION})`);
        }
        // Skip non-theatre content URLs (film reviews, concert reviews, etc.)
        const urlPath = data.url.toLowerCase();
        if (/\/(films|film)\//i.test(urlPath) || /\/music\/concerts\//i.test(urlPath)) continue;
        // Skip URLs that clearly don't match the show's production year
        const showYear = dir.match(/(\d{4})$/)?.[1];
        const urlYear = data.url.match(/(?:nypost|timeout|ew|standard|independent|whatsonstage|telegraph|thestage)\.(?:com|co\.uk)\/(\d{4})\//)?.[1];
        if (showYear && urlYear && Math.abs(parseInt(urlYear) - parseInt(showYear)) > 1) continue;
        targets.push({ key: `${dir}/${file}`, dir, file, fp, url: data.url, data });
      } catch (e) { /* skip */ }
    }
  }

  const ssTargets = targets.filter(t => t.data.originalScore && !AGGREGATOR_SOURCES.has(t.data.scoreSource));
  const aggTargets = targets.filter(t => AGGREGATOR_SOURCES.has(t.data.scoreSource));
  const noScore = targets.length - ssTargets.length - aggTargets.length;
  console.log(`Found ${targets.length} reviews to process (${noScore} missing score, ${ssTargets.length} replacing SS score, ${aggTargets.length} replacing aggregator score)`);
  const state = loadState(STATE_FILE);
  pruneState(state, `/${outlet}--`, targets.map(t => t.key));
  if (execute) saveState(STATE_FILE, state);
  const ordered = orderTargets(targets, state);
  if (ordered.length < targets.length) {
    console.log(`Skipping ${targets.length - ordered.length} in error backoff (fetch failed recently)`);
  }
  const toProcess = ordered.slice(0, limit);
  console.log(`Processing ${toProcess.length} of ${ordered.length}${budget.enabled ? ` (time budget ${budget.minutes} min)` : ''}\n`);

  if (dryRun) {
    toProcess.forEach(t => console.log(`  ${t.dir}/${t.file}: ${t.url}`));
    console.log('\nUse without --dry-run to fetch and extract.');
    return;
  }

  let extracted = 0;
  let failed = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  const streakKeys = [];

  for (let i = 0; i < toProcess.length; i++) {
    const t = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;
    if (!budget.canStartItem(MIN_REMAINING_MS_TO_START)) {
      console.log(`\nTime budget reached after ${budget.elapsedMin()} min: ${toProcess.length - i} left for the next run`);
      break;
    }
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.log(`\n${consecutiveErrors} errors in a row: stopping ${outlet}, ${toProcess.length - i} left for the next run`);
      // An outlet-wide failure (outage, expired cookies, spent credits) says
      // nothing about these URLs: drop their backoff, keep them at the back.
      if (execute) {
        for (const key of streakKeys) if (state[key]) delete state[key].lastError;
        saveState(STATE_FILE, state);
      }
      break;
    }
    let itemError = null;

    try {
      console.log(`${progress} Fetching: ${t.dir}/${t.file}`);
      console.log(`  URL: ${t.url}`);

      // Check existing archives first (avoids paywall/JS-rendering issues)
      let html = '';
      let result = null;
      const archiveDir = path.join(__dirname, '..', 'data', 'archives', 'reviews', t.dir);
      const archiveGlob = path.join(archiveDir, `${outlet}--${t.file.split('--')[1].replace('.json', '')}*.html`);
      const existingArchives = require('glob').sync(archiveGlob);
      if (existingArchives.length > 0) {
        // Try most recent archive first
        const archiveFile = existingArchives.sort().pop();
        const archiveHtml = require('fs').readFileSync(archiveFile, 'utf8');
        result = extractScore(archiveHtml, t.data.fullText || '', outlet);
        if (result && result.originalScore) {
          html = archiveHtml;
          console.log(`  ARCHIVE HIT: ${path.basename(archiveFile)} → ${result.originalScore} [${result.source}]`);
        }
      }

      if (!result) {
        html = await fetchItem(t.url);
        console.log(`  HTML: ${html.length} chars`);
        result = extractScore(html, t.data.fullText || '', outlet);
      }

      // JS-rendering retry: some outlets (Guardian, TimeOut) render star ratings
      // client-side. If BD returned HTML without scores, retry with Playwright.
      if (!result && html.length > 10000) {
        const JS_RENDERED_OUTLETS = new Set([
          'guardian', 'the-guardian', 'timeout', 'timeout-london',
          'standard', 'independent', 'i-paper',
        ]);
        if (JS_RENDERED_OUTLETS.has(outlet)) {
          console.log('  Retrying with Playwright (client-rendered stars)...');
          try {
            await ensureBrowser();
            const page = await _context.newPage();
            try {
              const rendered = await withDeadline(async () => {
                await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(3000);
                return page.content();
              }, RETRY_DEADLINE_MS, 'Playwright retry');
              html = rendered;
              console.log(`  Playwright HTML: ${html.length} chars`);
              result = extractScore(html, t.data.fullText || '', outlet);
            } finally {
              await withDeadline(() => page.close(), 5000, 'Page close').catch(() => {});
            }
          } catch (e) {
            console.log(`  Playwright retry failed: ${e.message}`);
          }
        }
      }

      // A cleared star comes back only from the page structure: a text match is
      // what the tier-1.5 audit already found no evidence for.
      if (result && result.originalScore && t.data.originalScoreCleared && !isScoreClearSupersededBy(t.data, result.source)) {
        console.log(`  FOUND ${result.originalScore} [${result.source}], not a structural star: the clear stands`);
        result = null;
      }

      if (result && result.originalScore) {
        extracted++;
        if (t.data.originalScore) {
          console.log(`  FOUND: ${result.originalScore} -> ${result.normalizedScore} (replacing SS: ${t.data.originalScore})`);
        } else {
          console.log(`  FOUND: ${result.originalScore} -> ${result.normalizedScore}`);
        }

        if (execute) {
          if (t.data.originalScore) {
            t.data.previousShowScoreRating = t.data.originalScore;
          }
          // Routes to originalScore unless EITHER the incoming source OR the
          // file's existing scoreSource is an aggregator. See lib/score-routing.js.
          const routed = setExtractedScore(t.data, {
            value: result.originalScore,
            normalizedValue: result.normalizedScore,
            source: result.source,
          });
          if (!routed.wasAggregator) {
            t.data.scoreSource = result.source;
          }
          t.data._scoreNote = `Re-collected for score extraction (${new Date().toISOString().split('T')[0]})`;
          // Save archive of the HTML
          if (!t.data.htmlContent && html.length > 1000) {
            const archiveDir = path.join(__dirname, '..', 'data', 'archives', 'reviews', t.dir);
            fs.mkdirSync(archiveDir, { recursive: true });
            const archiveFile = `${outlet}--${t.file.split('--')[1].replace('.json', '')}_${new Date().toISOString().split('T')[0]}.html`;
            fs.writeFileSync(path.join(archiveDir, archiveFile), html);
            t.data.archivePath = `data/archives/reviews/${t.dir}/${archiveFile}`;
          }
          fs.writeFileSync(t.fp, JSON.stringify(t.data, null, 2) + '\n');
        }
      } else {
        failed++;
        console.log('  NO SCORE FOUND in HTML');
        // Mark as checked so subsequent runs skip this review
        if (execute) {
          t.data._noScoreOnHtml = new Date().toISOString().split('T')[0];
          t.data._noScoreExtractorVersion = EXTRACTOR_VERSION;
          fs.writeFileSync(t.fp, JSON.stringify(t.data, null, 2) + '\n');
        }
      }
      consecutiveErrors = 0;
      streakKeys.length = 0;
    } catch (e) {
      errors++;
      consecutiveErrors++;
      streakKeys.push(t.key);
      console.log(`  ERROR: ${e.message || e}`);
      if (e.isFetchError) itemError = e.message || String(e);
    }

    if (execute) {
      recordAttempt(state, t.key, itemError);
      saveState(STATE_FILE, state);
    }

    // Rate limit
    if (i < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  if (_browser) await withDeadline(() => _browser.close(), 10000, 'Browser close').catch(() => {});
  await withDeadline(() => cleanupScraper(), 15000, 'Scraper cleanup').catch(() => {});

  console.log('\n=== SUMMARY ===');
  console.log(`Extracted: ${extracted} | No score: ${failed} | Errors: ${errors}`);
  if (!execute) {
    console.log('\nPreview mode - no changes written. Use --execute to apply.');
  } else {
    console.log(`\n${extracted} scores extracted. Run rebuild next.`);
  }
}

// Exit explicitly: a fetch abandoned at its deadline can hold a socket open.
main().then(() => process.exit(0), e => {
  console.error('Fatal:', e);
  process.exit(1);
});
