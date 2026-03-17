#!/usr/bin/env node
/**
 * Validate and fix Telecharge/Ticketmaster links in shows.json.
 *
 * Unlike TodayTix (which responds to HEAD requests), Telecharge uses Akamai
 * queue-it (302 for everything) and Ticketmaster requires JS rendering (404 for
 * HEAD/GET). So this script validates differently:
 *
 * Telecharge:
 * - Verify URL matches expected construction from show title
 * - Reconstruct if mismatched (show title may have changed)
 * - Remove for closed shows
 *
 * Ticketmaster:
 * - Re-verify via SERP search (confirms URL still appears in Google)
 * - Update if SERP returns a different URL
 * - Remove for closed shows
 *
 * Usage: node scripts/fix-platform-ticket-links.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { buildTelechargeUrl, normalizeShowName } = require('./lib/url-utils');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================================
// Ticketmaster SERP re-verification
// ============================================================================

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 30000;
    const urlObj = new URL(url);
    const proto = urlObj.protocol === 'https:' ? https : require('http');
    const method = options.method || 'GET';
    const reqHeaders = Object.assign(
      { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
      options.headers || {}
    );
    if (options.body) {
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(options.body);
    }
    // Add Authorization from BRIGHTDATA_TOKEN for BrightData API calls
    if (urlObj.hostname === 'api.brightdata.com' && process.env.BRIGHTDATA_TOKEN) {
      reqHeaders['Authorization'] = `Bearer ${process.env.BRIGHTDATA_TOKEN}`;
    }
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: reqHeaders,
      timeout,
    };
    const req = proto.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      res.on('error', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Match SERP results against a Ticketmaster URL for the given show.
 * Uses allowlist of valid TM path patterns instead of strict regex.
 * Returns { status, newUrl?, reason? } or null if no results to evaluate.
 */
function matchTicketmasterFromResults(results, showTitle, existingUrl) {
  // Allowlist of valid Ticketmaster path patterns
  const validPaths = ['/event/', '/artist/', '/venue/', '/tickets/'];

  for (const r of results) {
    const url = r.url || r.link;
    if (!url || !url.includes('ticketmaster.com')) continue;
    // Must match at least one valid path pattern
    if (!validPaths.some(p => url.includes(p))) continue;
    // Reject search/listing/category pages
    if (url.includes('/search') || url.includes('/discover') || url.includes('/category')) continue;

    const serpTitle = normalizeShowName(r.title || '');
    const showNorm = normalizeShowName(showTitle);
    const primaryTitle = showTitle.includes(':') ? normalizeShowName(showTitle.split(':')[0]) : showNorm;
    const matched = [showNorm, primaryTitle].some(candidate => {
      const words = candidate.split(' ').filter(w => w.length > 2);
      const matchCount = words.filter(w => serpTitle.includes(w)).length;
      return words.length === 0 || matchCount >= Math.ceil(words.length * 0.5);
    });

    if (matched) {
      const cleanUrl = url.replace(/^http:/, 'https:').replace('://ticketmaster.com', '://www.ticketmaster.com');
      if (cleanUrl === existingUrl) {
        return { status: 'ok' };
      }
      return { status: 'updated', newUrl: cleanUrl };
    }
  }

  return null; // No matching result found
}

/**
 * SERP search via ScrapingBee (primary — uses Google search credits)
 */
async function serpViaScrapingBee(query) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) return null;

  const searchUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}`;
  const result = await httpGet(searchUrl);
  if (result.statusCode !== 200) {
    console.log(`    ScrapingBee SERP HTTP ${result.statusCode}`);
    return null;
  }

  const data = JSON.parse(result.body);
  return data.organic_results || data.results || [];
}

/**
 * SERP search via BrightData SERP API (fallback — async polling)
 */
async function serpViaBrightData(query) {
  const apiKey = process.env.BRIGHTDATA_TOKEN;
  if (!apiKey) return null;

  const customer = process.env.BRIGHTDATA_CUSTOMER || 'hl_a2c64a47';
  const zone = process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1';

  try {
    // Submit request
    const submitResult = await httpGet(
      `https://api.brightdata.com/serp/req?customer=${customer}&zone=${zone}`,
      { method: 'POST', body: JSON.stringify({ query: { q: query, gl: 'us' } }) }
    );
    if (submitResult.statusCode !== 200) {
      console.log(`    BrightData SERP submit HTTP ${submitResult.statusCode}`);
      return null;
    }
    const submitData = JSON.parse(submitResult.body);
    const responseId = submitData.response_id;
    if (!responseId) return null;

    // Poll for results (max 20s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollResult = await httpGet(
        `https://api.brightdata.com/serp/get_result?response_id=${responseId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );
      if (pollResult.statusCode === 202) continue;
      if (pollResult.statusCode !== 200) return null;

      const data = JSON.parse(pollResult.body);
      if (data.organic) {
        return data.organic.slice(0, 10).map(r => ({
          url: r.link || r.url || '',
          title: r.title || '',
        }));
      }
      if (data.response_id) continue;
      return [];
    }
    console.log('    BrightData SERP timeout (20s)');
    return null;
  } catch (e) {
    console.log(`    BrightData SERP error: ${e.message}`);
    return null;
  }
}

async function serpVerifyTicketmaster(showTitle, existingUrl) {
  const query = `site:ticketmaster.com "${showTitle}" broadway tickets`;

  // Try ScrapingBee first (primary)
  let results = await serpViaScrapingBee(query);
  let source = 'ScrapingBee';

  // Fallback to BrightData SERP API
  if (!results) {
    results = await serpViaBrightData(query);
    source = 'BrightData';
  }

  // No SERP provider available — skip gracefully
  if (!results) {
    return { status: 'skip', reason: 'all SERP providers unavailable' };
  }

  console.log(`    (via ${source}, ${results.length} results)`);
  const match = matchTicketmasterFromResults(results, showTitle, existingUrl);
  if (match) return match;

  return { status: 'not_found', reason: 'no matching SERP result' };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`Platform Ticket Link Validator ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows;

  const stats = {
    telechargeChecked: 0, telechargeFixed: 0, telechargeRemoved: 0,
    ticketmasterChecked: 0, ticketmasterFixed: 0, ticketmasterRemoved: 0, ticketmasterSkipped: 0,
  };

  // ── Phase 1: Telecharge validation ──────────────────────────────
  console.log('\n── Telecharge Validation ──');

  for (const show of shows) {
    const links = show.ticketLinks || [];
    const tcIndex = links.findIndex(l => l.platform === 'Telecharge');
    if (tcIndex < 0) continue;
    stats.telechargeChecked++;

    const tcLink = links[tcIndex];

    // Remove for closed shows
    if (show.status === 'closed') {
      if (!DRY_RUN) links.splice(tcIndex, 1);
      console.log(`${show.id}: REMOVED (closed)`);
      stats.telechargeRemoved++;
      continue;
    }

    // Verify URL matches expected construction
    const expected = buildTelechargeUrl(show.title);
    if (tcLink.url !== expected) {
      console.log(`${show.id}: URL mismatch`);
      console.log(`  Current:  ${tcLink.url}`);
      console.log(`  Expected: ${expected}`);
      if (!DRY_RUN) tcLink.url = expected;
      stats.telechargeFixed++;
    }
  }

  console.log(`Telecharge: ${stats.telechargeChecked} checked, ${stats.telechargeFixed} fixed, ${stats.telechargeRemoved} removed`);

  // ── Phase 2: Ticketmaster validation ────────────────────────────
  console.log('\n── Ticketmaster Validation ──');

  for (const show of shows) {
    const links = show.ticketLinks || [];
    const tmIndex = links.findIndex(l => l.platform === 'Ticketmaster');
    if (tmIndex < 0) continue;
    stats.ticketmasterChecked++;

    const tmLink = links[tmIndex];

    // Remove for closed shows
    if (show.status === 'closed') {
      if (!DRY_RUN) links.splice(tmIndex, 1);
      console.log(`${show.id}: REMOVED (closed)`);
      stats.ticketmasterRemoved++;
      continue;
    }

    // SERP re-verify
    console.log(`${show.id}: verifying via SERP...`);
    const result = await serpVerifyTicketmaster(show.title, tmLink.url);

    if (result.status === 'ok') {
      console.log(`  ✓ URL confirmed`);
    } else if (result.status === 'updated') {
      console.log(`  → Updated: ${result.newUrl}`);
      if (!DRY_RUN) tmLink.url = result.newUrl;
      stats.ticketmasterFixed++;
    } else if (result.status === 'not_found') {
      console.log(`  ⚠ Not found in SERP (keeping existing URL)`);
      // Don't remove — SERP can have false negatives
    } else {
      console.log(`  ⚠ Skipped: ${result.reason}`);
      stats.ticketmasterSkipped++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Ticketmaster: ${stats.ticketmasterChecked} checked, ${stats.ticketmasterFixed} fixed, ${stats.ticketmasterRemoved} removed, ${stats.ticketmasterSkipped} skipped`);

  // ── Save ─────────────────────────────────────────────────────────
  const totalChanges = stats.telechargeFixed + stats.telechargeRemoved +
                       stats.ticketmasterFixed + stats.ticketmasterRemoved;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Total changes: ${totalChanges}`);

  if (!DRY_RUN && totalChanges > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(data, null, 2) + '\n');
    console.log('shows.json updated.');
  } else if (DRY_RUN) {
    console.log('(dry run — no files written)');
  } else {
    console.log('No changes needed.');
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes_made=${totalChanges > 0}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=TC:${stats.telechargeFixed}f/${stats.telechargeRemoved}r TM:${stats.ticketmasterFixed}f/${stats.ticketmasterRemoved}r\n`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
