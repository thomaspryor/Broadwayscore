#!/usr/bin/env node
/**
 * Bright Data vs Scrapingdog provider bake-off.
 *
 * Purpose: decide whether traffic currently routed through Bright Data Web
 * Unlocker (~$1.50/1k req, our most expensive channel) can be rerouted to
 * Scrapingdog (standard 1cr ≈ $0.09/1k, premium 10cr ≈ $0.90/1k) without losing
 * success rate. Per-host BD telemetry (2026-06-21 sample) showed the dominant BD
 * spend is Google SERP discovery + didtheylikeit.com + playbill.com +
 * broadwayworld.com — none of which need BD's elite Cloudflare/DataDome bypass.
 *
 * This is a benchmark/diagnostic tool, NOT a pipeline scraper — it deliberately
 * calls each provider directly so it can isolate and compare them (same exception
 * as scripts/evaluate-brightdata-serp.js). Pipeline scrapers must still use
 * fetchPage() from scripts/lib/scraper.js.
 *
 * Usage:
 *   node scripts/scrapingdog-bakeoff.js                 # default URL set
 *   node scripts/scrapingdog-bakeoff.js --urls=path.txt # one URL per line
 *   SCRAPINGDOG_API_KEY=xxx node scripts/scrapingdog-bakeoff.js
 *
 * Env: BRIGHTDATA_TOKEN, BRIGHTDATA_ZONE (default web_unlocker2),
 *      SCRAPINGDOG_API_KEY (if absent, runs a BD-only baseline + prints signup).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
const SCRAPINGDOG_API_KEY = process.env.SCRAPINGDOG_API_KEY;

// Pricing (USD per request) — keep in sync with scraper-cost-report.yml.
const COST = {
  bd: 0.0015,            // BD Web Unlocker, per successful request
  sd_standard: 0.00009,  // Scrapingdog 1 credit  @ $90 / 1,000,000 credits
  sd_render: 0.00045,    // Scrapingdog 5 credits (dynamic=true)
  sd_premium: 0.0009,    // Scrapingdog 10 credits (premium=true)
};

// Default targets: real URLs for the hosts BD actually hits most, plus controls.
const DEFAULT_URLS = [
  'https://didtheylikeit.com/shows/a-beautiful-noise/a-beautiful-noise-the-neil-diamond-musical-review-good-times-never-seemed-so-glum/',
  'https://didtheylikeit.com/shows/almost-famous/almost-famous-takes-us-on-a-joyous-trip-down-memory-lane/',
  'https://playbill.com/article/reviews-are-in-for-little-bear-ridge-road-on-broadway',
  'https://www.broadwayworld.com/article/BWW-Review-New-Cast-Members-Add-New-Dynamics-To-A-DOLLS-HOUSE-PART-2-20170813',
  'https://www.broadwayworld.com/westend/article/Review-1536-The-Ambassadors-Theatre-20260514',
];

const TIMEOUT_MS = 30000;
const MIN_BODY = 2000; // chars; below this we treat as a soft block / empty
const BLOCK_MARKERS = [
  /just a moment/i, /cf-browser-verification/i, /attention required/i,
  /captcha/i, /access denied/i, /enable javascript and cookies/i,
  /<title>\s*403/i, /request blocked/i,
];

function looksBlocked(html) {
  if (!html || html.length < MIN_BODY) return true;
  return BLOCK_MARKERS.some((re) => re.test(html.slice(0, 4000)));
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }

async function withTimeout(promise) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await promise(ctrl.signal); }
  finally { clearTimeout(t); }
}

async function fetchBrightData(url) {
  const start = Date.now();
  try {
    const res = await withTimeout((signal) => fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { Authorization: `Bearer ${BRIGHTDATA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone: BRIGHTDATA_ZONE, url, format: 'raw' }),
      signal,
    }));
    const body = await res.text();
    const blocked = res.status !== 200 || looksBlocked(body);
    return { ok: !blocked, status: res.status, len: body.length, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : (e.message || 'error').slice(0, 60), len: 0, ms: Date.now() - start };
  }
}

// mode: 'standard' (1cr), 'render' (dynamic=true, 5cr), 'premium' (premium=true, 10cr)
async function fetchScrapingdog(url, mode) {
  const start = Date.now();
  const params = new URLSearchParams({ api_key: SCRAPINGDOG_API_KEY, url });
  if (mode === 'render') params.set('dynamic', 'true'); else params.set('dynamic', 'false');
  if (mode === 'premium') { params.set('premium', 'true'); params.set('dynamic', 'false'); }
  try {
    const res = await withTimeout((signal) => fetch(`https://api.scrapingdog.com/scrape?${params}`, { signal }));
    const body = await res.text();
    const blocked = res.status !== 200 || looksBlocked(body);
    return { ok: !blocked, status: res.status, len: body.length, ms: Date.now() - start, mode };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : (e.message || 'error').slice(0, 60), len: 0, ms: Date.now() - start, mode };
  }
}

(async () => {
  if (!BRIGHTDATA_TOKEN) { console.error('✗ BRIGHTDATA_TOKEN not set — cannot run baseline.'); process.exit(1); }

  const urlsArg = process.argv.find((a) => a.startsWith('--urls='));
  let urls = DEFAULT_URLS;
  if (urlsArg) {
    const file = urlsArg.split('=')[1];
    urls = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  }

  const haveSD = !!SCRAPINGDOG_API_KEY;
  console.log(`\nBake-off: ${urls.length} URLs · Bright Data${haveSD ? ' vs Scrapingdog' : ' (baseline only — no SCRAPINGDOG_API_KEY)'}\n`);

  const results = [];
  for (const url of urls) {
    const host = hostOf(url);
    const bd = await fetchBrightData(url);

    let sd = null;
    if (haveSD) {
      // Try cheapest first; escalate only on failure to mirror a real reroute policy.
      sd = await fetchScrapingdog(url, 'standard');
      if (!sd.ok) sd = await fetchScrapingdog(url, 'render');
      if (!sd.ok) sd = await fetchScrapingdog(url, 'premium');
    }

    results.push({ url, host, bd, sd });
    const bdTag = `BD ${bd.ok ? 'OK' : 'FAIL'} (${bd.status}, ${bd.len}b, ${bd.ms}ms)`;
    const sdTag = haveSD ? ` | SD ${sd.ok ? 'OK' : 'FAIL'} [${sd.mode}] (${sd.status}, ${sd.len}b, ${sd.ms}ms)` : '';
    console.log(`${(bd.ok && (!haveSD || sd.ok)) ? '✓' : '⚠'} ${host}\n    ${bdTag}${sdTag}`);
  }

  // --- Summary ---
  const n = results.length;
  const bdOk = results.filter((r) => r.bd.ok).length;
  console.log(`\n— Summary —`);
  console.log(`Bright Data:  ${bdOk}/${n} ok`);
  if (haveSD) {
    const sdOk = results.filter((r) => r.sd.ok).length;
    const matched = results.filter((r) => r.bd.ok && r.sd.ok).length;
    const sdLost = results.filter((r) => r.bd.ok && !r.sd.ok).map((r) => r.host);
    console.log(`Scrapingdog:  ${sdOk}/${n} ok`);
    console.log(`Both ok:      ${matched}/${n}`);
    if (sdLost.length) console.log(`BD-only (keep on BD): ${sdLost.join(', ')}`);

    // Projected monthly savings if rerouteable share moves to Scrapingdog.
    // Use this batch's success rate as the rerouteable fraction; BD baseline
    // ~100k req/mo at $0.0015.
    const BD_MONTHLY_REQ = 100000;
    const rerouteFrac = bdOk ? matched / bdOk : 0;
    const sdMode = results.find((r) => r.sd && r.sd.ok)?.sd.mode || 'standard';
    const sdUnit = sdMode === 'premium' ? COST.sd_premium : sdMode === 'render' ? COST.sd_render : COST.sd_standard;
    const movedReq = Math.round(BD_MONTHLY_REQ * rerouteFrac);
    const savings = movedReq * (COST.bd - sdUnit);
    console.log(`\nProjection (at ~${BD_MONTHLY_REQ.toLocaleString()} BD req/mo):`);
    console.log(`  Rerouteable: ${(rerouteFrac * 100).toFixed(0)}% → ${movedReq.toLocaleString()} req/mo to Scrapingdog (${sdMode})`);
    console.log(`  Est. savings: ~$${savings.toFixed(0)}/mo (~$${(savings * 12).toFixed(0)}/yr)`);
  } else {
    console.log(`\nTo run the comparison: sign up at https://www.scrapingdog.com (1,000 free credits, no card),`);
    console.log(`then: SCRAPINGDOG_API_KEY=xxx node scripts/scrapingdog-bakeoff.js`);
  }

  // --- Write report ---
  const outDir = path.join(os.homedir(), 'Documents', 'claude-outputs');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'scrapingdog-bakeoff.json');
  fs.writeFileSync(outFile, JSON.stringify({ ranAt: new Date().toISOString(), haveScrapingdog: haveSD, results }, null, 2));
  console.log(`\nReport: ${outFile}`);
})();
