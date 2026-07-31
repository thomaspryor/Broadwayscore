#!/usr/bin/env node
/**
 * Universal Web Scraper with Fallback
 *
 * Tries multiple scraping services with smart ordering:
 * - Public sites (IBDB, Broadway.com): Playwright first (free), then BD/SB
 * - BroadwayWorld: Playwright first (complex JS rendering)
 * - All other sites: Bright Data → ScrapingBee → Playwright
 *
 * Usage:
 *   const { fetchPage } = require('./lib/scraper');
 *   const content = await fetchPage('https://example.com');
 *
 * Environment variables:
 *   BRIGHTDATA_TOKEN - Bright Data API token (primary)
 *   BRIGHTDATA_ZONE - Bright Data zone name (default: web_unlocker2)
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key (fallback)
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
// playwright is lazy-loaded inside fetchWithPlaywright() so that merely
// requiring this module never needs the package. Several lightweight scraper
// workflows (update-lbo/seatplan/ltd) run without `npm ci` and only ever use
// the Bright Data / ScrapingBee HTTP paths — a top-level require('playwright')
// crashed them with MODULE_NOT_FOUND the moment they imported scraper.js,
// even though they never reach the browser fallback. See feedback memory.
let chromium = null;
const {
  loadCookiesForDomain,
  buildCookieHeaderForUrl,
  hasCookiesForUrl,
} = require('./cookie-loader');
const { fetchWithCookiesPlain } = require('./fetch-plain');
const { recordBdCall, recordSbCall, recordSdCall } = require('./bd-telemetry');
const { shouldSkipScrapingdogAtRuntime, isSdQuotaHttpStatus } = require('./scrapingdog-ack');

// --- Domain-tier-skip: skip providers known to fail for specific domains ---
// Sourced from collect-review-texts.js empirical data (30K+ collection results).
const { getSkippedTiers } = require('./domain-tier-skip');
let _domainTierSkip = null;
function _getDomainSkips(url) {
  if (!_domainTierSkip) {
    try {
      const skipPath = path.join(__dirname, '..', 'config', 'domain-tier-skip.json');
      _domainTierSkip = JSON.parse(fs.readFileSync(skipPath, 'utf8'));
    } catch { _domainTierSkip = {}; }
  }
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return getSkippedTiers(_domainTierSkip, hostname);
  } catch { return new Set(); }
}

// --- Domain alias groups ---
// Sites that legitimately redirect between each other
// (e.g., Penske Media properties, NY Mag network). Both directions are checked.
const DOMAIN_ALIAS_GROUPS = [
  ['vulture.com', 'nymag.com', 'thecut.com', 'grubstreet.com'], // NY Mag network
  ['variety.com', 'deadline.com', 'indiewire.com', 'rollingstone.com', 'hollywoodlife.com'], // Penske Media
  ['ew.com', 'people.com'], // Dotdash Meredith
  ['usatoday.com', 'northjersey.com', 'azcentral.com', 'jsonline.com'], // Gannett/USA Today Network
  ['newyorktheatreguide.com', 'broadwayworld.com'], // NYTG merged into BWW
];

const DOMAIN_ALIASES = new Map();
for (const group of DOMAIN_ALIAS_GROUPS) {
  for (const domain of group) {
    if (!DOMAIN_ALIASES.has(domain)) DOMAIN_ALIASES.set(domain, new Set());
    for (const alias of group) {
      if (alias !== domain) DOMAIN_ALIASES.get(domain).add(alias);
    }
  }
}

// --- Public sites that should try free Playwright before paid APIs ---
// Only includes domains that actually flow through scraper.js's fetchPage().
// BWW already has separate Playwright-first handling (line ~203).
const PLAYWRIGHT_FIRST_DOMAINS = new Set([
  'ibdb.com',           // Public theater database — simple HTML, no anti-bot
  'broadway.com',       // Schedule/runtime pages — public, needs JS for some content
  'broadway.org',       // Playbill/closing dates — public HTML
  'whatsonstage.com',   // Star ratings rendered via client-side JS (yellow.png/star-grey.png)
  'dailymail.co.uk',    // Star ratings rendered via client-side JS (rating-star CSS classes)
  // talkinbroadway.com removed — behind Cloudflare managed challenge since ~2026-04;
  // Playwright (headless, even with stealth) cannot solve it. BrightData goes first.
  'stagebuddy.com',     // WordPress blog — free Playwright works reliably
  'londontheatre.co.uk', // React SPA (Material-UI) — BD returns empty, Playwright renders JS
  'bachtrack.com',      // review body (.pcm-walled-full) renders only in a real browser; BD/SB (even render_js) get a shell with meta description only. Verified Playwright renders full body 2026-07-13 (Met opera backfill)
  'todaytix.com',       // Public server-rendered show pages (run time, metadata) — no anti-bot; keeps bulk runtime audits off BD/SB credits
]);

// --- Domains where ScrapingBee MUST use render_js=true (JS-rendered content) ---
// Most review pages are static HTML and work fine with render_js=false (1 credit vs 5).
// Only add domains here where render_js=false returns broken/empty content.
// NOTE: whatsonstage.com and dailymail.co.uk are already in PLAYWRIGHT_FIRST_DOMAINS,
// so SB never reaches them — no need to list here.
const JS_REQUIRED_DOMAINS = new Set([
  'show-score.com',     // React SPA — requires JS rendering
  'theatermania.com',   // Dynamic content loading
  'timeout.com',        // Star ratings rendered via client-side SVG (_ratingStars_ CSS classes)
]);

function _isJsRequiredDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return JS_REQUIRED_DOMAINS.has(hostname);
  } catch { return false; }
}

/**
 * Check if a URL's domain is in the Playwright-first set.
 */
function _isPlaywrightFirstDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return PLAYWRIGHT_FIRST_DOMAINS.has(hostname);
  } catch { return false; }
}

/**
 * Check if an actual domain matches the expected domain, accounting for
 * subdomains (amp.nytimes.com vs nytimes.com) and known alias groups
 * (vulture.com → nymag.com). Domains should be pre-stripped of www. prefix.
 */
function domainMatchesExpected(expectedDomain, actualDomain) {
  if (actualDomain === expectedDomain) return true;
  // Subdomain match (e.g., amp.nytimes.com vs nytimes.com)
  if (actualDomain.includes(expectedDomain) || expectedDomain.includes(actualDomain)) return true;
  // Known alias from DOMAIN_ALIAS_GROUPS (e.g., vulture.com → nymag.com)
  const aliases = DOMAIN_ALIASES.get(expectedDomain);
  if (aliases && aliases.has(actualDomain)) return true;
  // Registry domain aliases (e.g., oneminutecritic.com ↔ 1minutecritic.com)
  if (_registryDomainAliases) {
    const regAliases = _registryDomainAliases[expectedDomain];
    if (regAliases && regAliases.has(actualDomain)) return true;
    const regAliases2 = _registryDomainAliases[actualDomain];
    if (regAliases2 && regAliases2.has(expectedDomain)) return true;
  }
  return false;
}

// Registry domain aliases injected by url-discovery.js at load time
let _registryDomainAliases = null;
function setRegistryDomainAliases(aliases) {
  _registryDomainAliases = aliases;
}

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// Scrapingdog — cheap tier inserted AHEAD of Bright Data. BD Web Unlocker is
// ~$1.50/1k req; Scrapingdog plain HTML is ~$0.09/1k (1 credit), dynamic
// ~$0.45/1k (5cr). Bake-off (2026-06-21) confirmed content-identical results
// on the dominant BD hosts (DTLI/Playbill/BWW) + working Google SERP; task
// #213 (2026-07) hardened SD's own failure handling so BD no longer silently
// absorbs its overflow at 3x cost. 71+ workflows already opt in explicitly —
// default ON now that it's proven; set SCRAPER_USE_SCRAPINGDOG=0 to opt out
// (e.g. a workflow that intentionally wants BD/SB only). No effect without
// SCRAPINGDOG_API_KEY set (only in GH secrets, not local .env). Bright Data
// stays in the chain as the fallback for the hard sites Scrapingdog can't
// unblock.
const SCRAPINGDOG_API_KEY = process.env.SCRAPINGDOG_API_KEY;
const USE_SCRAPINGDOG = process.env.SCRAPER_USE_SCRAPINGDOG !== '0';

// --- SB credit pre-check ---
let _sbCreditCheckDone = false;
let _sbCreditsLow = false;

// --- SB page-fetch reactive circuit breaker ---
// checkScrapingBeeCredits() (below) is a proactive precheck, but nothing calls
// it automatically — it must be invoked explicitly by a script's setup code,
// and most callers don't. fetchWithScrapingBee() had no fallback for that: with
// the account genuinely over its monthly cap (2026-07-20 incident, #224), every
// single call did a full HTTP round-trip before dying on a 401, for the entire
// duration of every run, across every script, all day. url-discovery.js's SERP
// path already self-heals this way (_scrapingBeeSerpExhausted, set on first
// 401/403/429) — this mirrors that same pattern for the page-fetch path so ONE
// failed call disables SB for the rest of the process instead of all of them.
let _scrapingBeePageExhausted = false;

/**
 * Check ScrapingBee remaining credits. Call once per process.
 * Returns true if credits are available, false if low/exhausted/missing key.
 * Sets _sbCreditsLow flag which fetchPage() and SERP functions check.
 */
async function checkScrapingBeeCredits() {
  if (_sbCreditCheckDone) return !_sbCreditsLow;
  _sbCreditCheckDone = true;

  if (!SCRAPINGBEE_KEY) return false;

  return new Promise((resolve) => {
    const req = https.get(
      `https://app.scrapingbee.com/api/v1/usage?api_key=${SCRAPINGBEE_KEY}`,
      { timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const used = data.used_api_credit || 0;
            const max = data.max_api_credit || 1;
            const remaining = max - used;
            const pctRemaining = (remaining / max) * 100;

            if (remaining <= 0 || pctRemaining < 5) {
              console.warn(`⚠️  ScrapingBee credits low: ${remaining} remaining (${pctRemaining.toFixed(1)}%) — skipping SB`);
              _sbCreditsLow = true;
              resolve(false);
            } else {
              console.log(`[SB Credits] ${remaining} remaining (${pctRemaining.toFixed(1)}%)`);
              resolve(true);
            }
          } catch {
            resolve(true); // Can't parse, assume OK
          }
        });
      }
    );
    req.on('error', () => resolve(true)); // Network error, assume OK
    req.on('timeout', () => { req.destroy(); resolve(true); });
  });
}

// --- SD quota pre-check (actual-exhaustion circuit breaker) ---
// History: task #213 A3 originally tripped this on a PACE PROJECTION
// (daysUntilExhaustion < daysToRenewal), reasoning SD "bills PAYG" and should
// be paced. Both halves were wrong (2026-07-26 BD recharge incident): the
// account is a prepaid monthly plan whose credits expire at renewal, and the
// projection tripped while 87% of the pool was unspent — rerouting every
// request to Bright Data at ~$1.50/1k while paid-for SD credits
// (~$0.09-0.45/1k) sat idle. The skip decision now lives in
// scrapingdog-ack.js's shouldSkipScrapingdogAtRuntime (§15 extraction) and
// trips ONLY on actual exhaustion, where skipping saves a doomed round-trip
// per call. Pace projections stay health-check-only (they alert, never route).
let _sdQuotaCheckPromise = null;
let _sdQuotaExceeded = false;

function _checkScrapingdogQuotaOnce() {
  if (_sdQuotaCheckPromise) return _sdQuotaCheckPromise;
  _sdQuotaCheckPromise = (async () => {
    if (!SCRAPINGDOG_API_KEY) return;
    try {
      const body = await new Promise((resolve, reject) => {
        const req = https.get(
          `https://api.scrapingdog.com/account?api_key=${SCRAPINGDOG_API_KEY}`,
          { timeout: 8000 },
          (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
          }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      const acct = JSON.parse(body);
      const { skip, logLine } = shouldSkipScrapingdogAtRuntime(acct);
      if (logLine) console.warn(`  ⚠️  ${logLine}`);
      if (skip) {
        _sdQuotaExceeded = true;
        recordSdCall({ host: 'account', fn: 'quota-check', success: false, status: 'quota', credits: 0 });
      }
    } catch {
      // Pre-check failure must never block scraping — fall through to normal SD flow.
    }
  })();
  return _sdQuotaCheckPromise;
}

let playwright = null; // Lazy load only if needed

// --- Per-run SB credit budget ---
// Default 250: allows ~250 render_js=false calls or ~50 render_js=true calls.
// Gather-reviews with 5 shows uses ~30-50 SB fallback calls; opening night ~100.
// For bulk runs (backfills, large dispatches), override via env:
//   SB_CREDIT_BUDGET=1000 node scripts/gather-reviews.js ...
// or in a workflow step:  env: { SB_CREDIT_BUDGET: '1000' }
const SB_CREDIT_BUDGET = parseInt(process.env.SB_CREDIT_BUDGET || '250', 10);

// Scrapingdog per-run credit budget. Unlike SB (a fixed monthly plan we ration
// per run), Scrapingdog is the new cheap primary, so default to no cap (0 =
// unlimited). Set SD_CREDIT_BUDGET=N to ration bulk runs.
const SD_CREDIT_BUDGET = parseInt(process.env.SD_CREDIT_BUDGET || '0', 10);

// --- Per-run cost tracking ---
const _scraperStats = {
  bdRequests: 0,
  sbRequests: 0,
  sbCredits: 0,
  sbBudgetExceeded: false,
  sdRequests: 0,
  sdCredits: 0,
  sdBudgetExceeded: false,
  pwAttempts: 0,
  pwSuccess: 0,
};

function getScraperStats() { return { ..._scraperStats }; }

/**
 * Fetch page using Bright Data Web Unlocker API (raw HTML output)
 */
async function fetchWithBrightData(url) {
  if (!BRIGHTDATA_TOKEN) {
    return null;
  }

  try {
    const apiUrl = 'https://api.brightdata.com/request';
    const bodyObj = {
      zone: BRIGHTDATA_ZONE,
      url: url,
      format: 'raw',
    };
    // Attach subscriber cookies (WSJ/FT/NYT/etc.) so BD's proxied request carries them
    const cookieHeader = buildCookieHeaderForUrl(url);
    if (cookieHeader) {
      bodyObj.headers = { Cookie: cookieHeader };
    }
    const body = JSON.stringify(bodyObj);

    const response = await new Promise((resolve, reject) => {
      const options = {
        method: 'POST',
        // Explicit timeout — matches SD's 45s. Previously unbounded; harmless
        // while BD was only ever the last tier fetchPage() tried, but fetchJSON
        // (task #203 reopen) now reaches it on the hot path too, where a hung
        // request would otherwise block indefinitely with no way out.
        timeout: 45000,
        headers: {
          'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(apiUrl, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ data, status: 200 });
          } else {
            const err = new Error(`Bright Data HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
            err.bdStatus = res.statusCode;
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Bright Data request timeout')); });
      req.end(body);
    });

    _scraperStats.bdRequests++;
    recordBdCall({ url, fn: 'web-unlocker', success: true, status: response.status });
    return {
      content: response.data,
      format: 'html',
      source: 'brightdata'
    };
  } catch (error) {
    console.error(`⚠️  Bright Data failed: ${error.message}`);
    recordBdCall({ url, fn: 'web-unlocker', success: false, status: error.bdStatus || error.message?.slice(0, 80) || 'error' });
    return null;
  }
}

/**
 * Fetch page using Scrapingdog API (HTML output).
 * Credit model mirrors ScrapingBee: plain=1, dynamic(JS)=5, premium proxy=10.
 * stealth_mode (options.stealthMode) is a heavier anti-bot bypass tier
 * (billed like premium, 10cr) — Scrapingdog's own 400 response body on a
 * WAF-protected host literally recommends "try enabling stealth_mode=true"
 * (task #203 reopen: westendtheatre.com wp-json 400s from the plain tier).
 * render/dynamic default is domain-aware (same JS_REQUIRED_DOMAINS as SB) unless
 * options.renderJs is explicitly set. premium proxy only when options.premium.
 * options.throwOn400: throw (instead of swallowing to null) when SD returns
 * HTTP 400, with `err.sdStatus = 400` set — lets a caller (fetchJSON) detect
 * "this specific request was refused, try the next tier" vs. other failure
 * modes (budget/quota/network) where escalating tiers wouldn't help.
 */
async function fetchWithScrapingdog(url, options = {}) {
  if (!SCRAPINGDOG_API_KEY) {
    return null;
  }

  // Fire-and-forget (not awaited): a live /account HTTP round-trip must never
  // add latency to the scraping hot path, especially opening-night polling.
  // The very first SD call in a process may proceed before the check resolves
  // — acceptable: it only skips on ACTUAL exhaustion, and a truly dry account
  // also trips the reactive HTTP-status latch below on the first failure.
  _checkScrapingdogQuotaOnce();
  if (_sdQuotaExceeded) {
    return null;
  }

  const renderJs = options.renderJs === true ? true :
                   options.renderJs === false ? false :
                   _isJsRequiredDomain(url);
  const premium = options.premium === true;
  const stealthMode = options.stealthMode === true;
  // premium and stealth_mode both imply a heavier anti-bot bypass (10cr); dynamic/JS is 5cr; plain is 1cr.
  const creditCost = (premium || stealthMode) ? 10 : (renderJs ? 5 : 1);

  // Per-run budget guard (0 = unlimited).
  if (SD_CREDIT_BUDGET > 0 && _scraperStats.sdCredits + creditCost > SD_CREDIT_BUDGET) {
    if (!_scraperStats.sdBudgetExceeded) {
      console.log(`  ⚠️  Scrapingdog credit budget exhausted (${_scraperStats.sdCredits}/${SD_CREDIT_BUDGET}) — skipping SD for remaining requests`);
    }
    _scraperStats.sdBudgetExceeded = true;
    return null;
  }

  const params = new URLSearchParams({
    api_key: SCRAPINGDOG_API_KEY,
    url,
    dynamic: renderJs ? 'true' : 'false',
  });
  if (premium) params.set('premium', 'true');
  if (stealthMode) params.set('stealth_mode', 'true');
  // Attach subscriber cookies so the proxied request carries them (same as SB/BD).
  const cookieHeader = buildCookieHeaderForUrl(url);
  if (cookieHeader) params.set('cookies', cookieHeader);
  const apiUrl = `https://api.scrapingdog.com/scrape?${params}`;

  // Retry once on transient failures (timeouts, socket errors, 5xx) before
  // giving up — the A0 billing probe confirmed SD failures are free, and these
  // often clear on a second attempt. 4xx (e.g. DTLI's structural "URL does not
  // exist") is NOT transient — retrying just adds latency; domain-tier-skip
  // handles those domains instead (task #213 A2).
  const MAX_ATTEMPTS = 2;
  let lastError = null;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Budget guard + credit accounting per attempt (not once up front) — a
    // retried call can bill twice, and the local ledger/SD_CREDIT_BUDGET must
    // reflect the worst case, not just the first attempt (codebase-review finding).
    if (SD_CREDIT_BUDGET > 0 && _scraperStats.sdCredits + creditCost > SD_CREDIT_BUDGET) {
      if (!_scraperStats.sdBudgetExceeded) {
        console.log(`  ⚠️  Scrapingdog credit budget exhausted (${_scraperStats.sdCredits}/${SD_CREDIT_BUDGET}) — skipping SD for remaining requests`);
      }
      _scraperStats.sdBudgetExceeded = true;
      if (attemptsMade === 0) return null;
      break;
    }
    _scraperStats.sdRequests++;
    _scraperStats.sdCredits += creditCost;
    attemptsMade++;
    try {
      const response = await new Promise((resolve, reject) => {
        // Explicit timeout: without one, a hung SD request waits indefinitely —
        // and now that a transient failure retries once, an unbounded first
        // attempt could block the retry from ever running. 45s matches the
        // longest observed SD render/premium latency.
        const req = https.get(apiUrl, { timeout: 45000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) resolve(data);
            else reject(new Error(`Scrapingdog HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Scrapingdog request timeout')); });
      });

      recordSdCall({ url, fn: stealthMode ? 'stealth' : (premium ? 'premium' : (renderJs ? 'render' : 'page')), success: true, status: 200, credits: creditCost * attemptsMade });
      return {
        content: response,
        format: 'html',
        source: 'scrapingdog'
      };
    } catch (error) {
      lastError = error;
      const isTransient = !/Scrapingdog HTTP 4\d\d/.test(error.message || '');
      if (isTransient && attempt < MAX_ATTEMPTS) continue;
      break;
    }
  }

  const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; } })();
  recordSdCall({ host: hostname, fn: stealthMode ? 'stealth' : (premium ? 'premium' : (renderJs ? 'render' : 'page')), success: false, status: lastError.message?.slice(0, 80) || 'error', credits: creditCost * attemptsMade });
  console.error(`⚠️  Scrapingdog failed (dynamic=${renderJs}${premium ? ', premium' : ''}${stealthMode ? ', stealth_mode' : ''}, domain=${hostname}): ${lastError.message}`);
  // Reactive quota latch (mirrors _scrapingBeePageExhausted): the /account
  // pre-check is memoized once per process, so credits hitting 0 MID-RUN would
  // otherwise leave every later call paying a doomed SD round-trip (up to 45s)
  // before falling to BD/SB. 401/403/429 from the scrape endpoint means
  // out-of-credits/auth — disable SD for the rest of the process. The exported
  // sdQuotaExceeded getter carries this to url-discovery's SERP path too.
  {
    const failStatus = /Scrapingdog HTTP (\d+)/.exec(lastError.message || '')?.[1];
    if (failStatus && isSdQuotaHttpStatus(failStatus) && !_sdQuotaExceeded) {
      _sdQuotaExceeded = true;
      console.warn(`  ⚠️  Scrapingdog disabled for the rest of this process (HTTP ${failStatus} — credits exhausted or auth failure)`);
    }
  }
  if (options.throwOn400) {
    const statusMatch = /Scrapingdog HTTP (\d+)/.exec(lastError.message || '');
    if (statusMatch && statusMatch[1] === '400') {
      const err = new Error(lastError.message);
      err.sdStatus = 400;
      throw err;
    }
  }
  return null;
}

/**
 * Fetch page using ScrapingBee API (HTML output)
 */
async function fetchWithScrapingBee(url, options = {}) {
  if (!SCRAPINGBEE_KEY || _scrapingBeePageExhausted) {
    return null;
  }

  // Resolve render_js: explicit true/false honored, otherwise domain-aware default.
  // Most pages are static HTML → render_js=false (1 credit) unless domain needs JS (5 credits).
  const renderJs = options.renderJs === true ? true :
                   options.renderJs === false ? false :
                   _isJsRequiredDomain(url);
  const creditCost = renderJs ? 5 : 1;

  // Per-run budget guard — skip SB if budget would be exceeded
  if (_scraperStats.sbCredits + creditCost > SB_CREDIT_BUDGET) {
    if (!_scraperStats.sbBudgetExceeded) {
      console.log(`  ⚠️  SB credit budget exhausted (${_scraperStats.sbCredits}/${SB_CREDIT_BUDGET}) — skipping SB for remaining requests`);
    }
    _scraperStats.sbBudgetExceeded = true;
    return null;
  }

  // Count credit spend BEFORE the call — SB charges even for 404/error responses
  _scraperStats.sbRequests++;
  _scraperStats.sbCredits += creditCost;

  try {
    let apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=${renderJs}`;
    // Attach subscriber cookies so SB's proxied request carries them. SB expects
    // semicolon-separated "name=value" pairs URL-encoded as one value. WSJ cookie
    // payloads can be large (~1-2KB); SB caps URL length around 8KB so this is fine.
    const cookieHeader = buildCookieHeaderForUrl(url);
    if (cookieHeader) {
      apiUrl += `&cookies=${encodeURIComponent(cookieHeader)}`;
    }

    const response = await new Promise((resolve, reject) => {
      // Explicit timeout — same class of gap as fetchWithBrightData's (task
      // #203 what-else finding): previously unbounded, so a hung SB connection
      // would stall the whole fetchPage()/fetchJSON() chain indefinitely.
      const req = https.get(apiUrl, { timeout: 45000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            const err = new Error(`ScrapingBee HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('ScrapingBee request timeout')); });
    });

    recordSbCall({ url, fn: renderJs ? 'render' : 'page', success: true, status: 200, credits: creditCost });
    return {
      content: response,
      format: 'html',
      source: 'scrapingbee'
    };
  } catch (error) {
    const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; } })();
    recordSbCall({ host: hostname, fn: renderJs ? 'render' : 'page', success: false, status: error.message?.slice(0, 80) || 'error', credits: creditCost });
    console.error(`⚠️  ScrapingBee failed (render_js=${renderJs}, domain=${hostname}): ${error.message}`);
    // Same trigger set as url-discovery.js's _serpViaScrapingBee circuit breaker:
    // 401 (auth/limit), 403 (forbidden/plan), 429 (rate limit) all mean "stop
    // asking SB for the rest of this process" — a monthly-cap 401 doesn't
    // resolve itself mid-run, so retrying it per-call just burns time.
    if ([401, 403, 429].includes(error.statusCode)) {
      _scrapingBeePageExhausted = true;
      console.warn(`  ⚠️  ScrapingBee page-fetch disabled for the rest of this process (HTTP ${error.statusCode})`);
    }
    return null;
  }
}

/**
 * Fetch page using Playwright (browser automation)
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.fast] - Use domcontentloaded instead of networkidle (for simple public sites)
 */
async function fetchWithPlaywright(url, options = {}) {
  _scraperStats.pwAttempts++;
  let context = null;
  try {
    if (!chromium) {
      try {
        ({ chromium } = require('playwright'));
      } catch (e) {
        // No browser fallback available in this environment (workflow ran
        // without devDeps installed). Surface a clear, catchable error rather
        // than a raw MODULE_NOT_FOUND so callers degrade gracefully.
        throw new Error(
          'Playwright fallback unavailable — playwright package not installed. ' +
          'Run `npm ci` (includes devDeps) or add `npx playwright install chromium`. ' +
          `Underlying: ${e.message}`
        );
      }
    }
    if (!playwright) {
      playwright = await chromium.launch({
        headless: true
      });
    }

    // Attach subscriber cookies (WSJ/FT/NYT/etc.) when available. Cookie-loader
    // returns Playwright-compatible objects {name, value, domain, path, ...}.
    const cookieDomain = hasCookiesForUrl(url);
    if (cookieDomain) {
      context = await playwright.newContext();
      const cookies = loadCookiesForDomain(cookieDomain);
      if (cookies && cookies.length > 0) {
        await context.addCookies(cookies);
      }
    }

    const page = context ? await context.newPage() : await playwright.newPage();
    // When caller asks us to wait for a specific selector, use
    // domcontentloaded (not networkidle) — pages that need selector-waiting
    // typically have ongoing analytics/ad XHRs that never let networkidle
    // settle (Signature Theatre being the canonical example — networkidle
    // times out at 45s; domcontentloaded + waitForSelector('.type-event')
    // returns in ~3s).
    const waitUntil = options.playwrightWaitForSelector
      ? 'domcontentloaded'
      : (options.fast ? 'domcontentloaded' : 'networkidle');
    await page.goto(url, { waitUntil, timeout: 30000 });
    // Optional: wait for a specific selector to appear before reading content.
    // Required when networkidle times out (e.g. Signature Theatre's
    // /productions/ — see scripts/lib/venue-listing-discover.js for the
    // venue that needs this). If the selector never appears within 15s,
    // log a warning and proceed with whatever rendered — partial content
    // is still useful for selector-tolerant parsers.
    if (options.playwrightWaitForSelector) {
      try {
        await page.waitForSelector(options.playwrightWaitForSelector, { timeout: 15000 });
      } catch (e) {
        // Only swallow TimeoutError — real Playwright failures (Target closed,
        // navigation crash, invalid selector) bubble up so the outer catch
        // can fall back to Bright Data / ScrapingBee / last-resort path.
        if (e?.name !== 'TimeoutError') throw e;
        console.warn(`  ⚠️  Playwright waitForSelector "${options.playwrightWaitForSelector}" timed out at ${url} — proceeding with partial content`);
      }
    }
    // Dismiss any GDPR/consent banner so we read the article, not the consent
    // wall. Best-effort: never throws. Fixes the recurring whatsonstage.com
    // false "not a review" flag (Sinatra/Much Ado/Misanthrope opening nights).
    // Skip via options.skipConsentDismiss if a caller already has its content.
    if (!options.skipConsentDismiss) {
      try {
        const { dismissConsent } = require('./cookie-consent');
        const r = await dismissConsent(page);
        if (r.clicked && !r.navigatedAway) console.log(`  🍪 dismissed consent banner (${r.clicked})`);
        // If the consent click navigated off-page, try to return to the article
        // so page.content() captures the review, not the redirect target.
        if (r.navigatedAway) {
          try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }); } catch (_) {}
        }
      } catch (_) { /* best-effort — proceed with whatever rendered */ }
    }
    const content = await page.content();
    await page.close();
    if (context) {
      try { await context.close(); } catch (_) {}
    }

    _scraperStats.pwSuccess++;
    return {
      content,
      format: 'html',
      source: 'playwright'
    };
  } catch (error) {
    console.error(`⚠️  Playwright failed: ${error.message}`);
    if (context) {
      try { await context.close(); } catch (_) {}
    }
    // If the browser is in a bad state (e.g. after a timeout), close and
    // reset so the next call can relaunch a fresh instance.
    if (playwright) {
      try { await playwright.close(); } catch (_) {}
      playwright = null;
    }
    return null;
  }
}

/**
 * Unwrap Google redirect wrappers (e.g. `https://www.google.com/url?q=<real>&sa=D&...`),
 * which appear when a URL is scraped from Google Docs/Sheets/editors exports or a SERP
 * link that escaped the discovery-time unwrap in url-discovery.js. Such a URL fetches the
 * Google chrome rather than the article (→ scraper_garbage), silently dropping a real
 * review (e.g. grace-pervades / The Stage, 2026-06). Idempotent and no-op for normal URLs.
 *
 * @param {string} url
 * @returns {string} the unwrapped target URL, or the input unchanged
 */
function unwrapRedirectUrl(url) {
  if (typeof url !== 'string') return url;
  if (!/\/\/(www\.)?google\.[^/]+\/url\?/.test(url)) return url;
  try {
    const params = new URL(url).searchParams;
    const target = params.get('q') || params.get('url');
    if (target && /^https?:\/\//.test(target)) return target;
  } catch (_) { /* malformed URL — fall through */ }
  return url;
}

/**
 * Fetch a page with automatic fallback
 *
 * @param {string} url - URL to fetch
 * @param {object} options - Options
 * @param {boolean} options.renderJs - Whether to render JavaScript (default: false unless domain is in JS_REQUIRED_DOMAINS)
 * @param {boolean} options.preferPlaywright - Skip APIs and go straight to Playwright (e.g. for BroadwayWorld)
 * @returns {Promise<{content: string, format: 'html'|'markdown', source: string}>}
 */
async function fetchPage(url, options = {}) {
  url = unwrapRedirectUrl(url);
  const preferPlaywright = options.preferPlaywright || false;
  const isPublicSite = _isPlaywrightFirstDomain(url);
  const skips = _getDomainSkips(url);
  const cookieDomain = hasCookiesForUrl(url);

  console.log(`Fetching: ${url}`);

  // Whether to verify the fetched URL matches what was requested.
  // Skip for root-level URLs (homepage fetches are intentional).
  const shouldVerify = options.skipVerify !== true && (() => {
    try { return new URL(url).pathname.length > 1; } catch { return false; }
  })();

  /**
   * Run verifyFetchedUrl and escalate if the result is a known-bad page.
   * Returns the result unchanged if verified (or if verification is skipped).
   * Returns null to signal "try next provider" on failure.
   */
  function _checkAndReturn(result, source) {
    if (!shouldVerify) {
      console.log(`  ✅ Success (${source}, ${result.format})`);
      return result;
    }
    const vr = verifyFetchedUrl(result.content, url);
    if (vr.verified) {
      console.log(`  ✅ Success (${source}, ${result.format})`);
      return result;
    }
    if (vr.reason === 'url_mismatch') {
      try {
        const hostname = new URL(url).hostname;
        recordUrlMismatch(url, vr.actual, source, hostname);
      } catch { /* never crash the scrape */ }
    }
    console.log(`  ⚠️  ${source} returned wrong page (${vr.reason}${vr.actual ? ': ' + vr.actual.slice(0, 80) : ''}) — trying next provider...`);
    return null;
  }

  // Cookie-gated outlets (WSJ, FT, NYT, Telegraph, etc.): try plain HTTPS with
  // subscriber cookies FIRST. WSJ's DataDome blocks BD/Playwright even with cookies,
  // but plain HTTP + subscriber cookies bypasses it (the recover-wsj-subscriber.js
  // pattern). For non-WSJ cookie outlets this just skips one proxy hop — cheap.
  if (cookieDomain && !preferPlaywright && !skips.has('cookies-plain')) {
    console.log(`  → Trying plain HTTPS with ${cookieDomain} cookies...`);
    const raw = await fetchWithCookiesPlain(url);
    if (raw && raw.content && raw.content.length > 0) {
      const checked = _checkAndReturn(raw, 'Cookie-plain');
      if (checked) return checked;
    }
  }

  // Playwright-first for known public sites (free, fast with domcontentloaded)
  // Also for BroadwayWorld (complex JS) and explicit preferPlaywright
  if (preferPlaywright || url.includes('broadwayworld.com') || isPublicSite) {
    if (skips.has('playwright')) {
      console.log('  → Skipping Playwright (domain-tier-skip)');
    } else {
      const label = isPublicSite ? 'public site' : 'complex site';
      console.log(`  → Using Playwright (${label})...`);
      const raw = await fetchWithPlaywright(url, {
        fast: isPublicSite,
        playwrightWaitForSelector: options.playwrightWaitForSelector,
      });
      if (raw) {
        const checked = _checkAndReturn(raw, 'Playwright');
        if (checked) return checked;
      }
    }
  }

  // Scrapingdog (flag-gated cheap tier — tried BEFORE Bright Data to avoid BD's
  // ~$1.50/1k cost on the many hosts Scrapingdog handles for ~$0.09-0.45/1k).
  // A challenge/short response falls through to Bright Data, which keeps its role
  // as the strong unblocker for the hard sites Scrapingdog can't crack.
  if (USE_SCRAPINGDOG && SCRAPINGDOG_API_KEY && !_scraperStats.sdBudgetExceeded && !_sdQuotaExceeded && !skips.has('scrapingdog')) {
    console.log('  → Trying Scrapingdog...');
    const raw = await fetchWithScrapingdog(url, options);
    if (raw && raw.content && raw.content.length > 0) {
      const isChallengeOrGarbage = raw.content.length < 10000 && (
        raw.content.includes('Just a moment...') ||
        raw.content.includes('cf_chl_opt') ||
        raw.content.includes('challenge-platform') ||
        raw.content.includes('Enable JavaScript and cookies to continue')
      );
      if (isChallengeOrGarbage) {
        console.log(`  ⚠️  Scrapingdog returned challenge/garbage (${raw.content.length} bytes), trying next provider...`);
      } else {
        const checked = _checkAndReturn(raw, 'Scrapingdog');
        if (checked) return checked;
      }
    }
  }

  // Try Bright Data (primary for non-public sites, fallback for public)
  if (BRIGHTDATA_TOKEN && !skips.has('brightdata')) {
    console.log('  → Trying Bright Data...');
    const raw = await fetchWithBrightData(url);
    if (raw && raw.content && raw.content.length > 0) {
      // Detect Cloudflare challenge pages — BD returns HTTP 200 with challenge HTML
      // that passes length > 0 but isn't real content. Fall through to ScrapingBee.
      const isChallengeOrGarbage = raw.content.length < 10000 && (
        raw.content.includes('Just a moment...') ||
        raw.content.includes('cf_chl_opt') ||
        raw.content.includes('challenge-platform') ||
        raw.content.includes('Enable JavaScript and cookies to continue')
      );
      if (isChallengeOrGarbage) {
        console.log(`  ⚠️  Bright Data returned Cloudflare challenge (${raw.content.length} bytes), trying next provider...`);
      } else {
        const checked = _checkAndReturn(raw, 'Bright Data');
        if (checked) return checked;
      }
    } else if (raw) {
      console.log('  ⚠️  Bright Data returned empty content, trying next provider...');
    }
  }

  // Fall back to ScrapingBee (skip if credits exhausted, budget exceeded, page-exhausted, or domain-skipped)
  if (SCRAPINGBEE_KEY && !_sbCreditsLow && !_scraperStats.sbBudgetExceeded && !_scrapingBeePageExhausted && !skips.has('scrapingbee')) {
    console.log('  → Trying ScrapingBee...');
    const raw = await fetchWithScrapingBee(url, options);
    if (raw) {
      const checked = _checkAndReturn(raw, 'ScrapingBee');
      if (checked) return checked;
    }
  }

  // Last resort: Playwright (only if not already tried above)
  if (!preferPlaywright && !isPublicSite && !url.includes('broadwayworld.com') && !skips.has('playwright')) {
    // (Last-resort Playwright path. playwrightWaitForSelector pass-through:
    // only needed for caller-explicit Playwright via preferPlaywright above;
    // this branch is "everything else failed" fallback, no specific selector.)
    console.log('  → Trying Playwright (last resort)...');
    const raw = await fetchWithPlaywright(url);
    if (raw) {
      const checked = _checkAndReturn(raw, 'Playwright');
      if (checked) return checked;
    }
  }

  throw new Error('All scraping methods failed');
}

/**
 * Clean up resources (call this when done with all scraping)
 */
async function cleanup() {
  // Print cost summary if any scraping happened
  const s = _scraperStats;
  const total = s.pwAttempts + s.bdRequests + s.sbRequests + s.sdRequests;
  if (total > 0) {
    const parts = [];
    if (s.pwSuccess > 0 || s.pwAttempts > 0) parts.push(`${s.pwSuccess}/${s.pwAttempts} Playwright (free)`);
    if (s.sdRequests > 0) parts.push(`${s.sdRequests} SD (${s.sdCredits} credits${s.sdBudgetExceeded ? ', BUDGET HIT' : ''})`);
    if (s.bdRequests > 0) parts.push(`${s.bdRequests} BD (~$${(s.bdRequests * 0.0015).toFixed(3)})`);
    if (s.sbRequests > 0) parts.push(`${s.sbRequests} SB (${s.sbCredits} credits${s.sbBudgetExceeded ? ', BUDGET HIT' : ''})`);
    console.log(`[Scraper Summary] ${parts.join(', ')}`);
  }

  if (playwright) {
    // browser.close() can hang indefinitely if the Chromium process is in a
    // bad state (unresponsive CDP connection) — this is what actually caused
    // task #438's "45-min timeout": discover-new-shows.js finished all real
    // work in ~30s, then this awaited close() with no timeout kept the
    // process's event loop alive for 44 more minutes until GitHub's hard
    // step timeout SIGKILLed it (verified via run 30166720704 logs — last
    // content line at 17:04:22, kill at 17:49:04, nothing in between).
    // Shared by 27 scripts; a hang here silently blows any caller's wall-clock
    // budget checks, since those only guard the WORK, not process exit.
    const CLOSE_TIMEOUT_MS = 10000;
    const target = playwright;
    playwright = null; // clear immediately so a hung close() can't block a fresh launch
    let closed = false;
    await Promise.race([
      target.close().then(() => { closed = true; }).catch(() => { closed = true; }),
      new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
    // Promise.race only abandons the JS await — a genuinely hung Chromium
    // subprocess keeps its own stdio pipes open, and THOSE (not the abandoned
    // promise) are what actually keep node's event loop alive. If close()
    // didn't settle in time, kill the underlying process directly so the
    // caller's `node` invocation can actually exit.
    if (!closed) {
      try {
        const proc = target.process && target.process();
        if (proc && !proc.killed) proc.kill('SIGKILL');
      } catch (_) { /* best-effort */ }
    }
  }
}

/**
 * Fetch a JSON API endpoint through the proxy chain.
 * Order: direct fetch (free) → Scrapingdog (cheap tier, 1 credit plain, escalating
 * to stealth_mode=true on a 400) → ScrapingBee (render_js=false, 1 credit) →
 * Bright Data (final tier, format=raw — task #203 reopen: SB exhaustion + SD's
 * daily-pace guard were stranding JSON endpoints with no unblocker left to try,
 * e.g. westendtheatre.com's wp-json API behind a WAF).
 * Unlike fetchPage(), returns parsed JSON instead of HTML.
 *
 * @param {string} url - The JSON API URL to fetch
 * @param {object} [options]
 * @param {object} [options.headers] - Additional headers (e.g. Accept: application/json)
 * @returns {Promise<any>} Parsed JSON response
 */
async function fetchJSON(url, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  // fetchPage() consults this same domain-tier-skip registry for SD/SB/BD —
  // fetchJSON must too, or an empirically-dead tier for a given host keeps
  // getting tried on every call (ship-check finding, task #203 reopen).
  const skips = _getDomainSkips(url);

  // Try direct fetch first — free, and most JSON API endpoints (WP-JSON, etc.)
  // aren't bot-protected. May be TLS-blocked for some hosts in CI; falls
  // through to Scrapingdog/ScrapingBee below when that happens. Now the FIRST
  // thing every call attempts (was previously a last-resort fallback), so an
  // explicit timeout matters here in a way it didn't before — an unbounded
  // hang would delay every single call, not just the rare one that fell
  // through past ScrapingBee.
  try {
    const proto = url.startsWith('https') ? https : require('http');
    const DIRECT_TIMEOUT_MS = 15000;
    const response = await new Promise((resolve, reject) => {
      const req = proto.get(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0', ...headers }, timeout: DIRECT_TIMEOUT_MS }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          // Resolve against the original URL (handles relative Location headers)
          // and pick the protocol client from the RESOLVED target, not the
          // original request — a cross-scheme redirect (http->https or
          // https->http) must not be followed with the wrong client.
          let redirectUrlObj;
          try {
            redirectUrlObj = new URL(res.headers.location, url);
          } catch (err) {
            reject(new Error(`invalid redirect Location: ${err.message}`));
            return;
          }
          const redirectUrl = redirectUrlObj.toString();
          const redirectProto = redirectUrlObj.protocol === 'https:' ? https : require('http');
          const req2 = redirectProto.get(redirectUrl, { headers: { 'User-Agent': 'BroadwayScorecard/1.0', ...headers }, timeout: DIRECT_TIMEOUT_MS }, (res2) => {
            let d = ''; res2.on('data', c => d += c); res2.on('end', () => {
              if (res2.statusCode === 200) resolve(d); else reject(new Error(`HTTP ${res2.statusCode}`));
            });
          });
          req2.on('error', reject);
          req2.on('timeout', () => { req2.destroy(); reject(new Error('direct fetch redirect timeout')); });
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('direct fetch timeout')); });
    });
    return JSON.parse(response);
  } catch (err) {
    console.log(`  fetchJSON direct failed: ${err.message}`);
  }

  // Scrapingdog next — cheap tier (1 credit, plain fetch), handles the
  // TLS-blocked-in-CI case direct fetch can't. Escalates to stealth_mode=true
  // (10cr) when the plain tier 400s — Scrapingdog's own error body on a
  // WAF-protected host explicitly recommends that (task #203 reopen:
  // westendtheatre.com wp-json). Respects the same budget/quota guards as
  // every other SD caller so an actual account exhaustion or per-run budget
  // still routes past SD to ScrapingBee/Bright Data below instead of retrying.
  if (USE_SCRAPINGDOG && SCRAPINGDOG_API_KEY && !_scraperStats.sdBudgetExceeded && !_sdQuotaExceeded && !skips.has('scrapingdog')) {
    let sdStealthEligible = false;
    try {
      const raw = await fetchWithScrapingdog(url, { ...options, renderJs: false, throwOn400: true });
      if (raw && raw.content) {
        return JSON.parse(raw.content);
      }
    } catch (err) {
      if (err.sdStatus === 400) {
        sdStealthEligible = true;
        console.log('  fetchJSON Scrapingdog plain tier 400\'d — escalating to stealth_mode=true');
      } else {
        console.log(`  fetchJSON Scrapingdog failed: ${err.message}`);
      }
    }
    if (sdStealthEligible && !_scraperStats.sdBudgetExceeded && !_sdQuotaExceeded) {
      try {
        const raw = await fetchWithScrapingdog(url, { ...options, renderJs: false, stealthMode: true });
        if (raw && raw.content) {
          return JSON.parse(raw.content);
        }
      } catch (err) {
        console.log(`  fetchJSON Scrapingdog stealth_mode failed: ${err.message}`);
      }
    }
  }

  // Last resort: ScrapingBee (render_js=false = 1 credit)
  if (SCRAPINGBEE_KEY && !_sbCreditsLow && !_scraperStats.sbBudgetExceeded && !_scrapingBeePageExhausted && !skips.has('scrapingbee')) {
    try {
      const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false`;
      const response = await new Promise((resolve, reject) => {
        const req = https.get(apiUrl, { timeout: 45000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) resolve(data);
            else {
              const err = new Error(`ScrapingBee HTTP ${res.statusCode}`);
              err.statusCode = res.statusCode;
              reject(err);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('ScrapingBee request timeout')); });
      });
      _scraperStats.sbRequests++;
      _scraperStats.sbCredits += 1; // render_js=false = 1 credit
      recordSbCall({ url, fn: 'json', success: true, status: 200, credits: 1 });
      return JSON.parse(response);
    } catch (err) {
      recordSbCall({ url, fn: 'json', success: false, status: (err.message || 'error').slice(0, 80), credits: 1 });
      console.log(`  fetchJSON ScrapingBee failed: ${err.message}`);
      if ([401, 403, 429].includes(err.statusCode)) {
        _scrapingBeePageExhausted = true;
        console.warn(`  ⚠️  ScrapingBee disabled for the rest of this process (HTTP ${err.statusCode})`);
      }
    }
  }

  // Final tier: Bright Data (format=raw returns the endpoint's raw JSON body
  // directly, no HTML wrapper to strip). Strongest unblocker, tried last
  // because it's the most expensive (~$1.50/1k vs SD's $0.09-0.45/1k) — but
  // without it, SB exhaustion + SD's daily-pace guard left JSON endpoints with
  // nothing left to try (task #203 reopen, scrape-westendtheatre.yml run
  // 30056408665: direct 403, SD 400, SB 401-exhausted-until-2026-08-05 → 0 posts).
  if (BRIGHTDATA_TOKEN && !skips.has('brightdata')) {
    const raw = await fetchWithBrightData(url);
    if (raw && raw.content) {
      try {
        return JSON.parse(raw.content);
      } catch (err) {
        console.log(`  fetchJSON Bright Data returned non-JSON: ${err.message}`);
      }
    }
  }

  throw new Error(`fetchJSON: all methods failed for ${url}`);
}

// --- Homepage title detection ---
// High-risk outlets that return their homepage with HTTP 200 when an article URL fails.
// Pattern: title starts with the site name followed by punctuation or "Latest News" etc.
const HOMEPAGE_TITLE_RE = /^BroadwayWorld:|^The Wall Street Journal\s*$|^The New York Sun\s*$|^Playbill\s*[-|]|^TimeOut\s*[-|]/i;

/**
 * Verify that fetched HTML actually corresponds to the requested URL.
 * Detects Cloudflare redirects, homepage returns, and canonical URL mismatches.
 *
 * @param {string} html - The fetched HTML content
 * @param {string} expectedUrl - The URL that was requested
 * @returns {{ verified: boolean, reason?: string, actual?: string }}
 */
function verifyFetchedUrl(html, expectedUrl) {
  if (!html || !expectedUrl) return { verified: false, reason: 'missing_input' };

  // 1. Homepage title detection — high-risk outlets return homepage with 200
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].trim() : '';
  if (pageTitle && HOMEPAGE_TITLE_RE.test(pageTitle)) {
    // Only flag if we requested an article URL (not root or /article)
    try {
      const { pathname } = new URL(expectedUrl);
      if (pathname && pathname.length > 1) {
        return { verified: false, reason: 'title_matches_homepage', actual: pageTitle };
      }
    } catch { /* invalid URL, fall through */ }
  }

  // 2. Canonical URL check — most CMS-powered pages include <link rel="canonical">
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const ogUrlMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);

  const actualUrl = (canonicalMatch && canonicalMatch[1]) || (ogUrlMatch && ogUrlMatch[1]) || null;

  // No canonical/og:url — can't verify, but can't disprove either. Pass through.
  // Only homepage-title detection (above) and explicit URL mismatch (below) should block.
  if (!actualUrl) return { verified: true, reason: 'no_canonical' };

  // Strip invisible/bidi Unicode (zero-width spaces, LTR/RTL marks, BOM) that
  // some sites (e.g. theatre.reviews) inject into canonical URLs, and NFC-normalize
  // so visually-identical URLs with different codepoint decompositions compare equal.
  // Confirmed 2026-07-30: theatre.reviews canonical URLs carry a trailing U+200E
  // (LEFT-TO-RIGHT MARK) that byte-for-byte differs from the requested URL despite
  // being visually and semantically identical — 1,412 wasted provider escalations.
  const INVISIBLE_UNICODE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
  function stripInvisibleUnicode(u) {
    return u.normalize('NFC').replace(INVISIBLE_UNICODE_RE, '');
  }

  // Normalize both URLs to hostname + pathname (drop scheme, query string, and hash).
  // Canonical URLs from <link rel="canonical"> are query-free by convention, so comparing
  // anything beyond host+path causes false mismatches whenever the request URL carries:
  //   - tracking params (utm_*, fbclid, gclid, SocialFlow, ref, etc.)
  //   - HTML-encoded `&amp;utm_*` keys that don't match the utm_ strip list
  //   - http:// vs https:// (e.g. old NYPost URLs stored as http but canonicalized to https)
  //   - invisible/bidi Unicode marks (see stripInvisibleUnicode above)
  // Path-only comparison is robust: none of these change the article served.
  function normalizeForVerify(u) {
    try {
      const parsed = new URL(stripInvisibleUnicode(u));
      return parsed.hostname.toLowerCase() + parsed.pathname.replace(/\/$/, '');
    } catch { return stripInvisibleUnicode(u).toLowerCase().replace(/\/$/, ''); }
  }

  const normExpected = normalizeForVerify(expectedUrl);
  const normActual = normalizeForVerify(actualUrl);

  if (normExpected === normActual) return { verified: true };

  // Allow if actual is a subdomain/alias of expected (e.g., amp. prefix) but only
  // when the domains actually differ — same-domain path differences are still mismatches.
  try {
    const expHost = new URL(stripInvisibleUnicode(expectedUrl)).hostname.replace(/^www\./, '');
    const actHost = new URL(stripInvisibleUnicode(actualUrl)).hostname.replace(/^www\./, '');
    if (expHost !== actHost) {
      // Different domains: allow subdomain relationships and known alias groups
      if (actHost.endsWith('.' + expHost) || expHost.endsWith('.' + actHost)) {
        return { verified: true };
      }
      if (domainMatchesExpected(expHost, actHost)) return { verified: true };
    } else {
      // Same host: tolerate a path-suffix redirect, where the CMS resolves a short/
      // partial slug to its full canonical article (e.g. didtheylikeit.com resolves
      // /shows/the-gin-game/ to /shows/the-gin-game-review/). Requires same directory
      // depth AND the actual last segment to literally extend the expected last segment
      // — this rejects unrelated pages nested under a different path (still a mismatch)
      // while accepting the site's own slug-completion redirects. Confirmed 2026-07-30:
      // didtheylikeit.com accounts for 4,889 of these, ~67% of its Bright Data spend.
      const expSegments = new URL(stripInvisibleUnicode(expectedUrl)).pathname.replace(/\/$/, '').split('/');
      const actSegments = new URL(stripInvisibleUnicode(actualUrl)).pathname.replace(/\/$/, '').split('/');
      const expLast = expSegments.pop();
      const actLast = actSegments.pop();
      if (expLast && expSegments.join('/') === actSegments.join('/') && actLast.startsWith(expLast)) {
        return { verified: true };
      }
    }
  } catch { /* fall through */ }

  return { verified: false, reason: 'url_mismatch', actual: actualUrl };
}

// --- Audit log for url_mismatch rejections ---
// When verifyFetchedUrl rejects due to a canonical URL redirect (e.g. Variety's
// /legit/reviews/ → /film/awards/ path for Joe Turner 2009), the scraper correctly
// refuses the wrong-path response and falls over to the next provider. But canonical
// redirects ARE sometimes legitimate (CMS restructuring), so we record each rejection
// here for human review. A human can then decide which are safe to allowlist.
// The rejection behavior itself is NOT changed — this is purely telemetry.
const URL_MISMATCH_AUDIT_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'url-mismatch-suspects.json');
const URL_MISMATCH_MAX_ENTRIES = 10000;

/**
 * Append a url_mismatch rejection record to data/audit/url-mismatch-suspects.json.
 * File is a JSON array; created if missing. Capped at URL_MISMATCH_MAX_ENTRIES (oldest dropped).
 * Never throws — audit failures must not crash the scrape.
 *
 * @param {string} requestedUrl - The URL that was requested
 * @param {string} actualUrl - The canonical/og:url found in the fetched HTML
 * @param {string} source - Which fetch tier returned the mismatch (e.g. 'Bright Data')
 * @param {string} hostname - Hostname of the requested URL (for quick filtering)
 */
function recordUrlMismatch(requestedUrl, actualUrl, source, hostname) {
  try {
    fs.mkdirSync(path.dirname(URL_MISMATCH_AUDIT_PATH), { recursive: true });
    let entries = [];
    try {
      const raw = fs.readFileSync(URL_MISMATCH_AUDIT_PATH, 'utf8');
      entries = JSON.parse(raw);
      if (!Array.isArray(entries)) {
        console.warn('[scraper] url-mismatch-suspects.json is not an array — resetting');
        entries = [];
      }
    } catch (readErr) {
      if (readErr.code !== 'ENOENT') {
        console.warn('[scraper] Could not read url-mismatch-suspects.json:', readErr.message);
      }
      entries = [];
    }
    entries.push({
      requestedUrl,
      actualUrl,
      fetchedAt: new Date().toISOString(),
      source,
      hostname,
    });
    if (entries.length > URL_MISMATCH_MAX_ENTRIES) {
      entries = entries.slice(entries.length - URL_MISMATCH_MAX_ENTRIES);
    }
    fs.writeFileSync(URL_MISMATCH_AUDIT_PATH, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.warn('[scraper] Failed to record url_mismatch audit entry:', err.message);
  }
}

module.exports = {
  fetchPage,
  fetchJSON,
  fetchWithCookiesPlain,
  fetchWithBrightData,
  fetchWithScrapingBee,
  fetchWithScrapingdog,
  fetchWithPlaywright,
  cleanup,
  domainMatchesExpected,
  setRegistryDomainAliases,
  DOMAIN_ALIAS_GROUPS,
  checkScrapingBeeCredits,
  checkScrapingdogQuotaOnce: _checkScrapingdogQuotaOnce,
  getScraperStats,
  verifyFetchedUrl,
  recordUrlMismatch,
  unwrapRedirectUrl,
  get sbCreditsLow() { return _sbCreditsLow; },
  get sdQuotaExceeded() { return _sdQuotaExceeded; },
  get scrapingBeePageExhausted() { return _scrapingBeePageExhausted; },
};
