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
 *   BRIGHTDATA_ZONE - Bright Data zone name (default: mcp_unlocker)
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key (fallback)
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

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
  'talkinbroadway.com', // Simple HTML blog — free Playwright works reliably
  'stagebuddy.com',     // WordPress blog — free Playwright works reliably
]);

// --- Domains where ScrapingBee MUST use render_js=true (JS-rendered content) ---
// Most review pages are static HTML and work fine with render_js=false (1 credit vs 5).
// Only add domains here where render_js=false returns broken/empty content.
// NOTE: whatsonstage.com and dailymail.co.uk are already in PLAYWRIGHT_FIRST_DOMAINS,
// so SB never reaches them — no need to list here.
const JS_REQUIRED_DOMAINS = new Set([
  'show-score.com',     // React SPA — requires JS rendering
  'theatermania.com',   // Dynamic content loading
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
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE || 'mcp_unlocker';
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
const SB_CREDIT_BUDGET = parseInt(process.env.SB_CREDIT_BUDGET || '100', 10);

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
    const body = JSON.stringify({
      zone: BRIGHTDATA_ZONE,
      url: url,
      format: 'raw'
    });

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
            resolve(data);
          } else {
            reject(new Error(`Bright Data HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.end(body);
    });

    _scraperStats.bdRequests++;
    return {
      content: response,
      format: 'html',
      source: 'brightdata'
    };
  } catch (error) {
    console.error(`⚠️  Bright Data failed: ${error.message}`);
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

  try {
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=${renderJs}`;

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

    _scraperStats.sbRequests++;
    _scraperStats.sbCredits += creditCost;
    return {
      content: response,
      format: 'html',
      source: 'scrapingbee'
    };
  } catch (error) {
    const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; } })();
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
  try {
    if (!playwright) {
      playwright = await chromium.launch({
        headless: true
      });
    }

    const page = await playwright.newPage();
    const waitUntil = options.fast ? 'domcontentloaded' : 'networkidle';
    await page.goto(url, { waitUntil, timeout: 30000 });
    const content = await page.content();
    await page.close();

    _scraperStats.pwSuccess++;
    return {
      content,
      format: 'html',
      source: 'playwright'
    };
  } catch (error) {
    console.error(`⚠️  Playwright failed: ${error.message}`);
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

  console.log(`Fetching: ${url}`);

  // Playwright-first for known public sites (free, fast with domcontentloaded)
  // Also for BroadwayWorld (complex JS) and explicit preferPlaywright
  if (preferPlaywright || url.includes('broadwayworld.com') || isPublicSite) {
    if (skips.has('playwright')) {
      console.log('  → Skipping Playwright (domain-tier-skip)');
    } else {
      const label = isPublicSite ? 'public site' : 'complex site';
      console.log(`  → Using Playwright (${label})...`);
      const result = await fetchWithPlaywright(url, { fast: isPublicSite });
      if (result) {
        console.log(`  ✅ Success (Playwright, ${result.format})`);
        return result;
      }
    }
  }

  // Try Bright Data (primary for non-public sites, fallback for public)
  if (BRIGHTDATA_TOKEN && !skips.has('brightdata')) {
    console.log('  → Trying Bright Data...');
    const result = await fetchWithBrightData(url);
    if (result && result.content && result.content.length > 0) {
      console.log(`  ✅ Success (Bright Data, ${result.format})`);
      return result;
    } else if (result) {
      console.log('  ⚠️  Bright Data returned empty content, trying next provider...');
    }
  }

  // Fall back to ScrapingBee (skip if credits exhausted, budget exceeded, or domain-skipped)
  if (SCRAPINGBEE_KEY && !_sbCreditsLow && !_scraperStats.sbBudgetExceeded && !skips.has('scrapingbee')) {
    console.log('  → Trying ScrapingBee...');
    const result = await fetchWithScrapingBee(url, options);
    if (result) {
      console.log(`  ✅ Success (ScrapingBee, ${result.format})`);
      return result;
    }
  }

  // Last resort: Playwright (only if not already tried above)
  if (!preferPlaywright && !isPublicSite && !url.includes('broadwayworld.com') && !skips.has('playwright')) {
    console.log('  → Trying Playwright (last resort)...');
    const result = await fetchWithPlaywright(url);
    if (result) {
      console.log(`  ✅ Success (Playwright, ${result.format})`);
      return result;
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
    if (s.bdRequests > 0) parts.push(`${s.bdRequests} BD (~$${(s.bdRequests * 0.001).toFixed(3)})`);
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

module.exports = {
  fetchPage,
  fetchJSON,
  fetchWithBrightData,
  fetchWithScrapingBee,
  fetchWithPlaywright,
  cleanup,
  domainMatchesExpected,
  setRegistryDomainAliases,
  DOMAIN_ALIAS_GROUPS,
  checkScrapingBeeCredits,
  getScraperStats,
  get sbCreditsLow() { return _sbCreditsLow; },
};
