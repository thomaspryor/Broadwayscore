#!/usr/bin/env node
/**
 * Cookie Health Check — 3-Layer Verification
 *
 * Layer 1: Structure — cookie file/env var exists, valid JSON, non-empty array
 * Layer 2: Auth expiry — checks specific auth cookies per critical outlet, general health for others
 * Layer 3: Live access — ScrapingBee test with cookies forwarded (opt-in, costs ~175 credits)
 *
 * Schedule: Twice weekly (Tue/Fri) via check-cookie-health.yml
 *
 * Usage:
 *   node scripts/check-cookie-health.js                  # Layers 1+2 only (free)
 *   LIVE_CHECK=true node scripts/check-cookie-health.js  # All 3 layers (~175 SB credits)
 *
 * Exit code: 0 = all healthy, 1 = critical failures detected
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadCookiesByFileKey, getEnvVarForFileKey, getAllFileKeys, COOKIE_DIR } = require('./lib/cookie-loader');
const { fetchWithCookiesPlain } = require('./lib/fetch-plain');
const { buildCookieHeaderForUrl } = require('./lib/cookie-loader');

// --- Outlet Configuration ---

// Critical outlets: hard paywalls where dead cookies silently degrade collection.
// Each has known auth cookie names (the short-lived tokens that prove subscriber status)
// and a test URL for Layer 3 live access verification.
const CRITICAL_OUTLETS = {
  nytimes: {
    envVar: 'NYT_COOKIES',
    testUrl: 'https://www.nytimes.com/2022/10/06/theater/1776-review-broadway.html',
    authCookies: ['NYT-S', 'nyt-a'],
  },
  wsj: {
    envVar: 'WSJ_COOKIES',
    testUrl: 'https://www.wsj.com/articles/gypsy-review-audra-mcdonalds-turn-on-broadway-ff528df3',
    authCookies: ['sso', 'djcs_route', 'session'],
    proxyBlocked: true, // WSJ aggressively blocks proxy access — live test unreliable
  },
  newyorker: {
    envVar: 'NEWYORKER_COOKIES',
    testUrl: 'https://www.newyorker.com/magazine/2023/03/20/dolls-house-review-broadway-jessica-chastain',
    authCookies: ['CN_token_access', 'CN_token_id', 'CN_access'],
    proxyBlocked: true, // Condé Nast blocks proxy access — live test unreliable
  },
  wapo: {
    envVar: 'WAPO_COOKIES',
    testUrl: 'https://www.washingtonpost.com/entertainment/theater/2025/04/10/boop-smash-broadway-review/',
    authCookies: ['wp_ak_subs', 'wp_ak_signinv2'],
  },
  ft: {
    envVar: 'FT_COOKIES',
    testUrl: 'https://www.ft.com/content/681beb68-5155-11df-bed9-00144feab49a',
    authCookies: ['FTSession', 'FTSession_s'],
  },
  vulture: {
    envVar: 'VULTURE_COOKIES',
    testUrl: 'https://www.vulture.com/2022/10/theater-review-1776-on-broadway.html',
    authCookies: [], // Soft paywall — no hard auth cookies
  },
  timeout: {
    envVar: 'TIMEOUT_COOKIES',
    testUrl: 'https://www.timeout.com/newyork/theater/1776-review-broadway-revival',
    authCookies: [], // Metered/GDPR wall — no hard auth cookies
  },
  thestage: {
    envVar: 'THESTAGE_COOKIES',
    testUrl: 'https://www.thestage.co.uk/',
    // Stage's logged-in cookie set is just 5: VISITOR, USER, USERSECURE, AWSALB, AWSALBCORS.
    // USERSECURE is the actual subscriber auth token. Verified by fetching Stage homepage
    // with the bundle and observing "my account" in nav + no "sign in" markers (2026-04-10).
    authCookies: ['USERSECURE', 'USER'],
    minCookies: 3, // VISITOR + USER + USERSECURE is the floor; AWS LB cookies are bonuses
  },
  thetimes: {
    envVar: 'THETIMES_COOKIES',
    testUrl: 'https://www.thetimes.com/culture/theatre-dance/article/1776-review-broadway-revival',
    authCookies: [], // Complex subscriber auth — monitor via structural/volume check
    minCookies: 15, // Times bundle historically has 20+ cookies; <15 signals stale
  },
};

// All outlet fileKey → envVar mappings (from shared cookie-loader)
const ALL_OUTLETS = {};
for (const fk of getAllFileKeys()) {
  ALL_OUTLETS[fk] = getEnvVarForFileKey(fk);
}

// Thresholds — NYT cookies only last ~7 days, so thresholds must be tight
const AUTH_ERROR_DAYS = 1;   // Auth cookie <1 day = fail
const AUTH_WARN_DAYS = 3;    // Auth cookie <3 days = warn
const EXPIRED_PCT_WARN = 80; // >80% of all cookies expired = warn

// --- HTTP Helper ---

function httpsGet(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...headers },
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });

    req.on('error', (err) => resolve({ status: 0, body: err.message, headers: {} }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); });
    req.end();
  });
}

// Cookie loading delegated to shared cookie-loader.js
// loadCookiesByFileKey returns { source: 'bundle'|'env'|'file', cookies: [] } or null
const loadCookies = loadCookiesByFileKey;

function buildCookieHeader(cookies, targetHostname = null) {
  let filtered = cookies.filter(c => c.name && c.value);
  if (targetHostname) {
    // Only include cookies whose domain matches the target URL
    // Cookie domain ".vulture.com" matches "www.vulture.com"
    filtered = filtered.filter(c => {
      if (!c.domain) return true;
      const cookieDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      return targetHostname === cookieDomain || targetHostname.endsWith('.' + cookieDomain);
    });
  }
  return filtered.map(c => `${c.name}=${c.value}`).join('; ');
}

// --- Paywall Detection (from collect-review-texts.js) ---

function isPaywalled(html) {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();
  return (
    lower.includes('subscribe to continue') ||
    lower.includes('subscription required') ||
    lower.includes('create a free account') ||
    lower.includes('sign in to read') ||
    lower.includes('already a subscriber') ||
    lower.includes('this article is for subscribers') ||
    lower.includes('to read the full story')
  );
}

function isBlocked(html) {
  if (!html || typeof html !== 'string') return true;
  if (html.length < 1000) {
    const lower = html.toLowerCase();
    return (
      lower.includes('access denied') ||
      lower.includes('403 forbidden') ||
      lower.includes('blocked') ||
      lower.includes('robot check') ||
      lower.includes('rate limit')
    );
  }
  return false;
}

// --- Layer 1: Structure Validation ---

function checkStructure(fileKey) {
  const loaded = loadCookies(fileKey);
  if (!loaded) {
    return { status: 'skip', message: 'Not found', cookies: null };
  }
  if (loaded.cookies.length === 0) {
    return { status: 'warn', message: `Empty (${loaded.source})`, cookies: [] };
  }
  const valid = loaded.cookies.filter(c => c.name && c.value && c.domain);
  if (valid.length === 0) {
    return { status: 'fail', message: `${loaded.cookies.length} cookies, none valid`, cookies: loaded.cookies };
  }
  return { status: 'pass', message: `${valid.length} cookies`, cookies: loaded.cookies, source: loaded.source };
}

// --- Layer 2: Auth Cookie Expiry (critical outlets only) ---

function checkAuthExpiry(cookies, authCookieNames) {
  if (!cookies || cookies.length === 0 || authCookieNames.length === 0) {
    return { status: 'pass', message: 'No auth cookies to check', authDays: null };
  }

  const now = Date.now() / 1000;
  const authSet = new Set(authCookieNames);

  // Find auth cookies by name
  const authCookies = cookies.filter(c => authSet.has(c.name));

  if (authCookies.length === 0) {
    return { status: 'warn', message: `Auth cookies missing (need: ${authCookieNames.join(', ')})`, authDays: null };
  }

  // Check expiry of found auth cookies
  const withExpiry = authCookies.filter(c => c.expires && c.expires > 0);
  if (withExpiry.length === 0) {
    return { status: 'pass', message: `${authCookies.length} auth cookies (session-type)`, authDays: null };
  }

  const alive = withExpiry.filter(c => c.expires >= now);
  if (alive.length === 0) {
    return { status: 'fail', message: `Auth cookies EXPIRED (${authCookieNames.join(', ')})`, authDays: -1 };
  }

  const earliest = alive.sort((a, b) => a.expires - b.expires)[0];
  const days = Math.round((earliest.expires - now) / 86400 * 10) / 10;

  if (days < AUTH_ERROR_DAYS) {
    return { status: 'fail', message: `Auth expires in ${days}d (${earliest.name}) — login in Safari NOW, then run: python3 scripts/extract-safari-cookies.py --push`, authDays: days };
  }
  if (days < AUTH_WARN_DAYS) {
    return { status: 'warn', message: `Auth expires in ${days}d (${earliest.name}) — login in Safari soon, then run: python3 scripts/extract-safari-cookies.py --push`, authDays: days };
  }

  return { status: 'pass', message: `Auth OK ${days}d (${earliest.name})`, authDays: days };
}

// --- Layer 2b: General health (all outlets) ---

function checkGeneralHealth(cookies) {
  if (!cookies || cookies.length === 0) {
    return { status: 'skip', message: '' };
  }

  const now = Date.now() / 1000;
  const persistent = cookies.filter(c => c.expires && c.expires > 0);
  if (persistent.length === 0) return { status: 'pass', message: 'session-only' };

  const expired = persistent.filter(c => c.expires < now);
  const expiredPct = Math.round(100 * expired.length / persistent.length);

  if (expiredPct >= EXPIRED_PCT_WARN) {
    return { status: 'warn', message: `${expiredPct}% expired` };
  }
  if (expired.length > 0) {
    return { status: 'pass', message: `${expired.length}/${persistent.length} expired` };
  }
  return { status: 'pass', message: '' };
}

// --- Layer 3: Live Access Test via ScrapingBee ---

async function checkLiveAccess(fileKey, testUrl, cookies, authCookies) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    return { status: 'skip', message: 'SCRAPINGBEE_API_KEY not set' };
  }

  const targetHostname = new URL(testUrl).hostname;
  const cookieHeader = buildCookieHeader(cookies, targetHostname);
  if (!cookieHeader || cookieHeader.length < 10) {
    return { status: 'warn', message: 'Cookie header too short' };
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    url: testUrl,
    render_js: 'true',
    wait: '5000',
    premium_proxy: 'true',
    forward_headers: 'true',
    block_ads: 'true',
  });

  const sbUrl = `https://app.scrapingbee.com/api/v1/?${params.toString()}`;

  try {
    const res = await httpsGet(sbUrl, { 'Spb-Cookie': cookieHeader }, 60000);

    if (res.status === 0) return { status: 'warn', message: `Request failed: ${res.body}` };
    if (res.status === 500) return { status: 'warn', message: 'ScrapingBee 500 (site blocking)' };
    if (res.status !== 200) return { status: 'warn', message: `HTTP ${res.status}` };

    const html = res.body;
    // Soft-paywall outlets (no auth cookies): blocking/paywall signals are not cookie failures
    const isSoftPaywall = !authCookies || authCookies.length === 0;
    if (isBlocked(html)) {
      const severity = isSoftPaywall ? 'warn' : 'fail';
      return { status: severity, message: `Blocked (${html.length} chars)` };
    }
    if (isPaywalled(html)) {
      if (isSoftPaywall && html.length > 50000) {
        return { status: 'pass', message: `OK soft-paywall (${html.length} chars)` };
      }
      return { status: 'fail', message: `Paywalled (${html.length} chars)` };
    }
    if (html.length < 2000) return { status: 'warn', message: `Short (${html.length} chars)` };

    return { status: 'pass', message: `OK (${html.length} chars)` };
  } catch (err) {
    return { status: 'warn', message: `Error: ${err.message}` };
  }
}

// --- Layer 3 (production-path): for outlets where SB proxies are blocked ---
// Mirrors what gather/collect scripts actually do for WSJ/New Yorker:
//   1. Try plain HTTPS with cookies (works from residential IPs)
//   2. Fall through to Bright Data with cookies (works from CI datacenter IPs,
//      since BD uses residential proxy pool)
// A pass means "the production fetch path gets paywalled content end-to-end."

async function fetchWithBrightDataCookies(url) {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) return { ok: false, error: 'BRIGHTDATA_TOKEN not set' };

  const cookieHeader = buildCookieHeaderForUrl(url);
  if (!cookieHeader) return { ok: false, error: 'no cookies for domain' };

  const bodyObj = {
    zone: process.env.BRIGHTDATA_ZONE || 'mcp_unlocker',
    url,
    format: 'raw',
    headers: { Cookie: cookieHeader },
  };
  const body = JSON.stringify(bodyObj);

  return new Promise((resolve) => {
    const req = https.request('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve({ ok: true, content: data });
        else resolve({ ok: false, error: `BD HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

function classifyLiveContent(html, authCookies, source) {
  const isSoftPaywall = !authCookies || authCookies.length === 0;
  if (isBlocked(html)) return { status: 'fail', message: `Blocked via ${source} (${html.length} chars)` };
  if (isPaywalled(html)) {
    if (isSoftPaywall && html.length > 50000) {
      return { status: 'pass', message: `OK soft-paywall via ${source} (${html.length} chars)` };
    }
    return { status: 'fail', message: `Paywalled via ${source} — subscriber cookies not authenticating (${html.length} chars)` };
  }
  if (html.length < 2000) return { status: 'warn', message: `Short via ${source} (${html.length} chars)` };
  return { status: 'pass', message: `OK via ${source} (${html.length} chars)` };
}

async function checkLiveAccessPlain(fileKey, testUrl, authCookies) {
  // Tier 1: plain HTTPS + cookies (residential IP path)
  try {
    const plain = await fetchWithCookiesPlain(testUrl);
    if (plain && plain.content) {
      const result = classifyLiveContent(plain.content, authCookies, 'plain-HTTPS');
      if (result.status === 'pass') return result;
      // fall through to BD if plain returned paywall/block — CI IP often blocked
    }
  } catch (err) {
    console.log(`  plain-HTTPS error: ${err.message}`);
  }

  // Tier 2: Bright Data with cookies (residential proxy, works from CI datacenters)
  const bd = await fetchWithBrightDataCookies(testUrl);
  if (!bd.ok) {
    return { status: 'fail', message: `plain-HTTPS failed + BD failed: ${bd.error}` };
  }
  return classifyLiveContent(bd.content, authCookies, 'Bright Data');
}

// --- Main ---

async function main() {
  const liveCheck = process.env.LIVE_CHECK === 'true';
  const icons = { pass: '\u2705', fail: '\u274C', warn: '\u26A0\uFE0F', skip: '\u23ED\uFE0F' };
  const results = [];

  console.log('=== Cookie Health Check ===');
  console.log(`Layers: 1 (structure) + 2 (auth expiry)${liveCheck ? ' + 3 (live ScrapingBee test)' : ''}\n`);

  // --- Critical outlets: Layer 1 + 2 (auth-aware) ---
  console.log('--- Critical Outlets (Layer 1+2) ---\n');

  for (const [fileKey, config] of Object.entries(CRITICAL_OUTLETS)) {
    const structure = checkStructure(fileKey);
    if (structure.status !== 'pass') {
      const icon = icons[structure.status] || '?';
      console.log(`${icon} ${fileKey}: ${structure.message}`);
      results.push({ name: fileKey, status: structure.status, message: structure.message, isCritical: true, layer: 1 });
      continue;
    }

    const auth = checkAuthExpiry(structure.cookies, config.authCookies || []);
    const health = checkGeneralHealth(structure.cookies);

    // Volume check: outlets where authCookies: [] (can't check specific names) but we know
    // a healthy bundle should have at least N cookies. Low count = stale/incomplete extraction.
    let volume = { status: 'pass', message: '' };
    if (config.minCookies && structure.cookies.length < config.minCookies) {
      volume = {
        status: 'fail',
        message: `only ${structure.cookies.length} cookies (expected ≥${config.minCookies}) — bundle stale`,
      };
    }

    const worstStatus = auth.status === 'fail' || volume.status === 'fail' ? 'fail'
      : auth.status === 'warn' || volume.status === 'warn' ? 'warn'
      : health.status === 'warn' ? 'warn' : 'pass';

    const parts = [structure.message];
    if (auth.message) parts.push(auth.message);
    if (volume.message) parts.push(volume.message);
    if (health.message) parts.push(health.message);
    const msg = parts.join(' | ');

    console.log(`${icons[worstStatus]} ${fileKey}: ${msg}`);
    results.push({
      name: fileKey,
      status: worstStatus,
      message: msg,
      isCritical: true,
      layer: 2,
      authDays: auth.authDays,
      cookies: structure.cookies,
    });
  }

  // --- Non-critical outlets: Layer 1 only ---
  console.log('\n--- Other Outlets (Layer 1) ---\n');

  const criticalKeys = new Set(Object.keys(CRITICAL_OUTLETS));
  for (const fileKey of Object.keys(ALL_OUTLETS)) {
    if (criticalKeys.has(fileKey)) continue;

    const structure = checkStructure(fileKey);
    const health = structure.cookies ? checkGeneralHealth(structure.cookies) : { status: 'skip', message: '' };
    const worstStatus = structure.status !== 'pass' ? structure.status : health.status;

    const parts = [structure.message];
    if (health.message) parts.push(health.message);
    const msg = parts.join(' | ');

    console.log(`${icons[worstStatus]} ${fileKey}: ${msg}`);
    results.push({ name: fileKey, status: worstStatus, message: msg, isCritical: false, layer: 1 });
  }

  // --- Layer 3: Live access (critical outlets only, opt-in) ---
  if (liveCheck) {
    console.log('\n--- Live Access Test (ScrapingBee) ---\n');

    // Run all 7 in parallel
    const livePromises = Object.entries(CRITICAL_OUTLETS).map(async ([fileKey, config]) => {
      const existing = results.find(r => r.name === fileKey && r.cookies);
      if (!existing || !existing.cookies || existing.cookies.length === 0) {
        const msg = 'No cookies loaded';
        console.log(`${icons.skip} ${fileKey}: ${msg}`);
        return { name: fileKey, layer: 3, status: 'skip', message: msg, isCritical: true };
      }

      // Proxy-blocked outlets (WSJ, New Yorker) use plain HTTPS + cookies instead of
      // ScrapingBee. Post PR #260, fetchWithCookiesPlain is the primary path gather/collect
      // take for these domains, so this is the real end-to-end verification.
      const live = config.proxyBlocked
        ? await checkLiveAccessPlain(fileKey, config.testUrl, config.authCookies)
        : await checkLiveAccess(fileKey, config.testUrl, existing.cookies, config.authCookies);
      console.log(`${icons[live.status]} ${fileKey}: ${live.message}`);
      return { name: fileKey, layer: 3, status: live.status, message: live.message, isCritical: true };
    });

    const liveResults = await Promise.all(livePromises);
    results.push(...liveResults);
  }

  // --- Summary ---
  console.log('\n--- Summary ---\n');

  const failures = results.filter(r => r.status === 'fail');
  const warnings = results.filter(r => r.status === 'warn');
  const passed = results.filter(r => r.status === 'pass');
  const skipped = results.filter(r => r.status === 'skip');
  const criticalFailures = failures.filter(r => r.isCritical);

  console.log(`${passed.length} pass | ${warnings.length} warn | ${failures.length} fail | ${skipped.length} skip`);

  if (criticalFailures.length > 0) {
    console.log(`\n${icons.fail} CRITICAL FAILURES:`);
    for (const f of criticalFailures) {
      console.log(`  ${f.name} (L${f.layer}): ${f.message}`);
    }
  }

  // Report auth cookies expiring soon
  const expiringSoon = results
    .filter(r => r.authDays !== undefined && r.authDays !== null && r.authDays > 0 && r.authDays < AUTH_WARN_DAYS)
    .sort((a, b) => a.authDays - b.authDays);

  if (expiringSoon.length > 0) {
    console.log(`\n${icons.warn} AUTH EXPIRING SOON:`);
    for (const r of expiringSoon) {
      console.log(`  ${r.name}: ${r.authDays}d until auth cookies expire`);
    }
    console.log('\nTo refresh: python3 scripts/extract-safari-cookies.py --push');
  }

  // --- Alerting ---
  if (criticalFailures.length > 0 || expiringSoon.length > 0) {
    try {
      const { sendAlert } = require('./lib/discord-notify');

      const fields = [];

      if (criticalFailures.length > 0) {
        fields.push({
          name: `${criticalFailures.length} Critical Failure(s)`,
          value: criticalFailures.map(f => `**${f.name}** (L${f.layer}): ${f.message}`).join('\n'),
          inline: false,
        });
      }

      if (expiringSoon.length > 0) {
        fields.push({
          name: 'Auth Expiring Soon',
          value: expiringSoon.map(r => `**${r.name}**: ${r.authDays}d left`).join(', '),
          inline: false,
        });
      }

      fields.push({
        name: 'Action',
        value: 'Refresh: `python3 scripts/extract-safari-cookies.py --push`',
        inline: false,
      });

      const severity = criticalFailures.length > 0 ? 'error' : 'warning';
      await sendAlert({
        title: criticalFailures.length > 0
          ? `Cookie Health — ${criticalFailures.length} Failed`
          : `Cookie Health — ${expiringSoon.length} Expiring Soon`,
        description: criticalFailures.length > 0
          ? 'Critical outlet cookies are dead or expiring. Review collection is silently degraded.'
          : 'Auth cookies expiring soon. Refresh before they die.',
        severity,
        email: criticalFailures.length > 0,
        fields: fields.slice(0, 10),
      }).catch(e => console.error('[Alert] Failed to send:', e.message));
    } catch (e) {
      console.error('[Alert] Could not load discord-notify:', e.message);
    }
  }

  if (criticalFailures.length > 0) {
    process.exit(1);
  }

  if (failures.length === 0 && warnings.length === 0 && expiringSoon.length === 0) {
    console.log('\nAll cookies healthy.');
  }
}

main().catch(err => {
  console.error('Cookie health check failed:', err);
  process.exit(1);
});
