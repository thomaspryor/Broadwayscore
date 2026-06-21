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
const { chromium } = require('playwright');
const {
  loadCookiesForDomain,
  buildCookieHeaderForUrl,
  hasCookiesForUrl,
} = require('./cookie-loader');
const { fetchWithCookiesPlain } = require('./fetch-plain');
const { recordBdCall, recordSbCall } = require('./bd-telemetry');

// --- Domain-tier-skip: skip providers known to fail for specific domains ---
// Sourced from collect-review-texts.js empirical data (30K+ collection results).
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
    return new Set(_domainTierSkip[hostname] || []);
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

// --- SB credit pre-check ---
let _sbCreditCheckDone = false;
let _sbCreditsLow = false;

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

let playwright = null; // Lazy load only if needed

// --- Per-run SB credit budget ---
// Default 250: allows ~250 render_js=false calls or ~50 render_js=true calls.
// Gather-reviews with 5 shows uses ~30-50 SB fallback calls; opening night ~100.
// For bulk runs (backfills, large dispatches), override via env:
//   SB_CREDIT_BUDGET=1000 node scripts/gather-reviews.js ...
// or in a workflow step:  env: { SB_CREDIT_BUDGET: '1000' }
const SB_CREDIT_BUDGET = parseInt(process.env.SB_CREDIT_BUDGET || '250', 10);

// --- Per-run cost tracking ---
const _scraperStats = {
  bdRequests: 0,
  sbRequests: 0,
  sbCredits: 0,
  sbBudgetExceeded: false,
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
 * Fetch page using ScrapingBee API (HTML output)
 */
async function fetchWithScrapingBee(url, options = {}) {
  if (!SCRAPINGBEE_KEY) {
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
      https.get(apiUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`ScrapingBee HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }).on('error', reject);
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
 * Fetch a page with automatic fallback
 *
 * @param {string} url - URL to fetch
 * @param {object} options - Options
 * @param {boolean} options.renderJs - Whether to render JavaScript (default: false unless domain is in JS_REQUIRED_DOMAINS)
 * @param {boolean} options.preferPlaywright - Skip APIs and go straight to Playwright (e.g. for BroadwayWorld)
 * @returns {Promise<{content: string, format: 'html'|'markdown', source: string}>}
 */
async function fetchPage(url, options = {}) {
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

  // Fall back to ScrapingBee (skip if credits exhausted, budget exceeded, or domain-skipped)
  if (SCRAPINGBEE_KEY && !_sbCreditsLow && !_scraperStats.sbBudgetExceeded && !skips.has('scrapingbee')) {
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
  const total = s.pwAttempts + s.bdRequests + s.sbRequests;
  if (total > 0) {
    const parts = [];
    if (s.pwSuccess > 0 || s.pwAttempts > 0) parts.push(`${s.pwSuccess}/${s.pwAttempts} Playwright (free)`);
    if (s.bdRequests > 0) parts.push(`${s.bdRequests} BD (~$${(s.bdRequests * 0.0015).toFixed(3)})`);
    if (s.sbRequests > 0) parts.push(`${s.sbRequests} SB (${s.sbCredits} credits${s.sbBudgetExceeded ? ', BUDGET HIT' : ''})`);
    console.log(`[Scraper Summary] ${parts.join(', ')}`);
  }

  if (playwright) {
    await playwright.close();
    playwright = null;
  }
}

/**
 * Fetch a JSON API endpoint through the proxy chain.
 * Uses ScrapingBee with render_js=false (1 credit) → Bright Data → direct fetch.
 * Unlike fetchPage(), returns parsed JSON instead of HTML.
 *
 * @param {string} url - The JSON API URL to fetch
 * @param {object} [options]
 * @param {object} [options.headers] - Additional headers (e.g. Accept: application/json)
 * @returns {Promise<any>} Parsed JSON response
 */
async function fetchJSON(url, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };

  // Try ScrapingBee first (cheapest: 1 credit with render_js=false)
  if (SCRAPINGBEE_KEY && !_sbCreditsLow && !_scraperStats.sbBudgetExceeded) {
    try {
      const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false`;
      const response = await new Promise((resolve, reject) => {
        https.get(apiUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) resolve(data);
            else reject(new Error(`ScrapingBee HTTP ${res.statusCode}`));
          });
        }).on('error', reject);
      });
      _scraperStats.sbRequests++;
      _scraperStats.sbCredits += 1; // render_js=false = 1 credit
      return JSON.parse(response);
    } catch (err) {
      console.log(`  fetchJSON ScrapingBee failed: ${err.message}`);
    }
  }

  // Fallback: direct fetch (works locally, may be TLS-blocked in CI)
  try {
    const proto = url.startsWith('https') ? https : require('http');
    const response = await new Promise((resolve, reject) => {
      proto.get(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0', ...headers } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          proto.get(res.headers.location, { headers: { 'User-Agent': 'BroadwayScorecard/1.0', ...headers } }, (res2) => {
            let d = ''; res2.on('data', c => d += c); res2.on('end', () => {
              if (res2.statusCode === 200) resolve(d); else reject(new Error(`HTTP ${res2.statusCode}`));
            });
          }).on('error', reject);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    return JSON.parse(response);
  } catch (err) {
    console.log(`  fetchJSON direct failed: ${err.message}`);
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

  // Normalize both URLs to hostname + pathname (drop scheme, query string, and hash).
  // Canonical URLs from <link rel="canonical"> are query-free by convention, so comparing
  // anything beyond host+path causes false mismatches whenever the request URL carries:
  //   - tracking params (utm_*, fbclid, gclid, SocialFlow, ref, etc.)
  //   - HTML-encoded `&amp;utm_*` keys that don't match the utm_ strip list
  //   - http:// vs https:// (e.g. old NYPost URLs stored as http but canonicalized to https)
  // Path-only comparison is robust: none of these change the article served.
  function normalizeForVerify(u) {
    try {
      const parsed = new URL(u);
      return parsed.hostname.toLowerCase() + parsed.pathname.replace(/\/$/, '');
    } catch { return u.toLowerCase().replace(/\/$/, ''); }
  }

  const normExpected = normalizeForVerify(expectedUrl);
  const normActual = normalizeForVerify(actualUrl);

  if (normExpected === normActual) return { verified: true };

  // Allow if actual is a subdomain/alias of expected (e.g., amp. prefix) but only
  // when the domains actually differ — same-domain path differences are still mismatches.
  try {
    const expHost = new URL(expectedUrl).hostname.replace(/^www\./, '');
    const actHost = new URL(actualUrl).hostname.replace(/^www\./, '');
    if (expHost !== actHost) {
      // Different domains: allow subdomain relationships and known alias groups
      if (actHost.endsWith('.' + expHost) || expHost.endsWith('.' + actHost)) {
        return { verified: true };
      }
      if (domainMatchesExpected(expHost, actHost)) return { verified: true };
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
  fetchWithPlaywright,
  cleanup,
  domainMatchesExpected,
  setRegistryDomainAliases,
  DOMAIN_ALIAS_GROUPS,
  checkScrapingBeeCredits,
  getScraperStats,
  verifyFetchedUrl,
  recordUrlMismatch,
  get sbCreditsLow() { return _sbCreditsLow; },
};
