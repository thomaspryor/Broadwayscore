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
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { extractScore, OUTLET_EXTRACTORS } = require('./lib/score-extractors');

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Parse args
const args = process.argv.slice(2);
const outletArg = args.find(a => a.startsWith('--outlet='));
const limitArg = args.find(a => a.startsWith('--limit='));
const delayArg = args.find(a => a.startsWith('--delay='));
const execute = args.includes('--execute');
const dryRun = args.includes('--dry-run');
const outlet = outletArg ? outletArg.split('=')[1] : null;
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 5;
const delay = delayArg ? parseInt(delayArg.split('=')[1]) : 2000;

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

// Cookie domain map for paywalled outlets
const COOKIE_DOMAIN_MAP = {
  'telegraph.co.uk': { fileKey: 'telegraph', envVar: 'TELEGRAPH_COOKIES' },
  'thetimes.co.uk': { fileKey: 'thetimes', envVar: 'THETIMES_COOKIES' },
  'thetimes.com': { fileKey: 'thetimes', envVar: 'THETIMES_COOKIES' },
  'thestage.co.uk': { fileKey: 'thestage', envVar: 'THESTAGE_COOKIES' },
  'standard.co.uk': { fileKey: 'standard', envVar: 'STANDARD_COOKIES' },
  'independent.co.uk': { fileKey: 'independent', envVar: 'INDEPENDENT_COOKIES' },
  'ft.com': { fileKey: 'ft', envVar: 'FT_COOKIES' },
};

// Essential auth cookie patterns per domain (for ScrapingBee URL length limits).
// Full cookie set goes to Playwright; only these go via ScrapingBee forward_headers.
const ESSENTIAL_COOKIE_PATTERNS = {
  'telegraph.co.uk': /^(__utp|tmg_refresh|tmg_session|tmg_pid|consentUUID)$/,
  'thetimes.co.uk': /^(auth0|auth0_compat|sacs_tnl|authId|blaize_jwt|nukt_mem|nuk_customer_location_hint|login_event_fired|pay_fls|gamera_user_id|_nuk_sp_id\.|_nuk_sp_ses\.)$/,
  'thetimes.com': /^(auth0|auth0_compat|sacs_tnl|authId|blaize_jwt|nukt_mem|nuk_customer_location_hint|login_event_fired|pay_fls|gamera_user_id|_nuk_sp_id\.|_nuk_sp_ses\.)$/,
  'thestage.co.uk': null, // Small enough to send all
};

function loadCookiesForUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    for (const [domain, config] of Object.entries(COOKIE_DOMAIN_MAP)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        // Try env var first (CI: base64-encoded JSON)
        const envVal = process.env[config.envVar];
        if (envVal) {
          try {
            const cookies = JSON.parse(Buffer.from(envVal, 'base64').toString('utf-8'));
            if (Array.isArray(cookies) && cookies.length > 0) return { cookies, domain };
          } catch (e) { /* skip */ }
        }
        // Try local file
        const fp = path.join(__dirname, '..', 'data', 'cookies', `${config.fileKey}.json`);
        if (fs.existsSync(fp)) {
          try {
            const cookies = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            if (Array.isArray(cookies) && cookies.length > 0) return { cookies, domain };
          } catch (e) { /* skip */ }
        }
      }
    }
  } catch (e) { /* skip */ }
  return null;
}

// Load env from .env file if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

let fetchUrl;
let _browser;
let _context;

function fetchWithScrapingBee(url, cookieHeader) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      api_key: SCRAPINGBEE_KEY,
      url: url,
      render_js: 'true',
    });
    if (cookieHeader) {
      params.set('forward_headers', 'true');
    }
    const apiUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
    const options = { headers: {} };
    if (cookieHeader) {
      options.headers['Spb-Cookie'] = cookieHeader;
    }
    https.get(apiUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`ScrapingBee HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function initScraper() {
  const { chromium } = require('playwright');
  _browser = await chromium.launch({ headless: true });
  _context = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  fetchUrl = async (url) => {
    const cookieData = loadCookiesForUrl(url);

    // For paywalled/WAF-protected sites, try ScrapingBee with filtered auth cookies
    if (cookieData && SCRAPINGBEE_KEY) {
      const { cookies, domain } = cookieData;
      const pattern = ESSENTIAL_COOKIE_PATTERNS[domain];
      const filtered = pattern ? cookies.filter(c => pattern.test(c.name)) : cookies;
      const cookieHeader = filtered.map(c => `${c.name}=${c.value}`).join('; ');
      if (cookieHeader.length > 0) {
        try {
          console.log(`  ScrapingBee: forwarding ${filtered.length}/${cookies.length} cookies (${cookieHeader.length} chars)`);
          const html = await fetchWithScrapingBee(url, cookieHeader);
          if (html && html.length > 500) return html;
          console.log(`  ScrapingBee returned ${html.length} chars, trying Playwright...`);
        } catch (e) {
          console.log(`  ScrapingBee failed: ${e.message}, trying Playwright...`);
        }
      }
    }

    // Playwright fallback with full cookie set
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
  };

  return { browser: _browser, context: _context };
}

async function main() {
  console.log(`\n=== Re-collect for Scores: ${outlet} ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (listing only)' : execute ? 'EXECUTING' : 'FETCH + PREVIEW (no writes)'}`);
  console.log(`Limit: ${limit} | Delay: ${delay}ms\n`);

  // Find targets
  const showDirs = fs.readdirSync(REVIEW_DIR).filter(d =>
    fs.statSync(path.join(REVIEW_DIR, d)).isDirectory()
  );

  const targets = [];
  for (const dir of showDirs) {
    const files = fs.readdirSync(path.join(REVIEW_DIR, dir))
      .filter(f => f.startsWith(outlet + '--') && f.endsWith('.json'));

    for (const file of files) {
      const fp = path.join(REVIEW_DIR, dir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (data.originalScore) continue; // Already has score
        if (!data.url) continue; // No URL to fetch
        targets.push({ dir, file, fp, url: data.url, data });
      } catch (e) { /* skip */ }
    }
  }

  console.log(`Found ${targets.length} reviews without originalScore`);
  const toProcess = targets.slice(0, limit);
  console.log(`Processing ${toProcess.length} of ${targets.length}\n`);

  if (dryRun) {
    toProcess.forEach(t => console.log(`  ${t.dir}/${t.file}: ${t.url}`));
    console.log('\nUse without --dry-run to fetch and extract.');
    return;
  }

  // Init browser
  const { browser } = await initScraper();

  let extracted = 0;
  let failed = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const t = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;

    try {
      console.log(`${progress} Fetching: ${t.dir}/${t.file}`);
      console.log(`  URL: ${t.url}`);

      const html = await fetchUrl(t.url);
      console.log(`  HTML: ${html.length} chars`);

      const result = extractScore(html, t.data.fullText || '', outlet);

      if (result && result.originalScore) {
        extracted++;
        console.log(`  FOUND: ${result.originalScore} -> ${result.normalizedScore}`);

        if (execute) {
          t.data.originalScore = result.originalScore;
          t.data.originalScoreNormalized = result.normalizedScore;
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
      }
    } catch (e) {
      errors++;
      console.log(`  ERROR: ${e.message}`);
    }

    // Rate limit
    if (i < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  await browser.close();

  console.log('\n=== SUMMARY ===');
  console.log(`Extracted: ${extracted} | No score: ${failed} | Errors: ${errors}`);
  if (!execute) {
    console.log('\nPreview mode - no changes written. Use --execute to apply.');
  } else {
    console.log(`\n${extracted} scores extracted. Run rebuild next.`);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
