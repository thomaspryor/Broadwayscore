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
 * Usage: node scripts/fix-platform-ticket-links.js [--dry-run] [--time-budget-min=N]
 *
 * --time-budget-min=N: wall-clock budget in minutes for the Ticketmaster
 * SERP-verification phase (0 or omitted = unlimited). Exits cleanly once
 * exceeded instead of running into the job timeout; deferred shows keep
 * their existing (unverified) link and are picked up next run. Telecharge
 * validation is pure local URL construction — no network calls, no budget
 * needed.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { serpQuery } = require('./lib/url-discovery');
const { isRegionMismatch, showRegion } = require('./lib/ticket-link-discovery.js');
const { buildTelechargeUrl, normalizeShowName } = require('./lib/url-utils');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-platform-ticket-links.js — Validate and fix Telecharge/Ticketmaster links in shows.json.

Usage:
  node scripts/fix-platform-ticket-links.js [options]
  node scripts/fix-platform-ticket-links.js --help, -h    print this usage and exit
`;
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

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
function matchTicketmasterFromResults(results, showTitle, existingUrl, show) {
  // Allowlist of valid Ticketmaster path patterns
  const validPaths = ['/event/', '/artist/', '/venue/', '/tickets/'];

  for (const r of results) {
    const url = r.url || r.link;
    if (!url || !(url.includes('ticketmaster.com') || url.includes('ticketmaster.co.uk'))) continue;
    // Never adopt a storefront that cannot sell this show's market — this is
    // how a-christmas-carol-west-end-2026 (Old Vic) kept getting the US
    // "A Christmas Carol (NY)" artist page: the .com-only domain filter above
    // couldn't even see the verified .co.uk link, and a half-title SERP match
    // replaced it (task #1002 class; gate: scripts/tests/tm-gap-links.test.mjs).
    if (show && isRegionMismatch(url, show)) continue;
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
      const cleanUrl = url.replace(/^http:/, 'https:')
        .replace('://ticketmaster.com', '://www.ticketmaster.com')
        .replace('://ticketmaster.co.uk', '://www.ticketmaster.co.uk');
      if (cleanUrl === existingUrl) {
        return { status: 'ok' };
      }
      return { status: 'updated', newUrl: cleanUrl };
    }
  }

  return null; // No matching result found
}

// SERP functions removed — using shared serpQuery from url-discovery.js

async function serpVerifyTicketmaster(show, existingUrl) {
  const showTitle = show.title;
  // Search the storefront that can actually sell this market: a UK show
  // queried as `site:ticketmaster.com ... broadway` can ONLY return
  // wrong-region results (the original clobber vector).
  const query = showRegion(show) === 'uk'
    ? `site:ticketmaster.co.uk "${showTitle}" tickets`
    : `site:ticketmaster.com "${showTitle}" broadway tickets`;

  const results = await serpQuery(query);

  // No SERP provider available — skip gracefully
  if (!results) {
    return { status: 'skip', reason: 'all SERP providers unavailable' };
  }

  console.log(`    (${results.length} results)`);
  const match = matchTicketmasterFromResults(results, showTitle, existingUrl, show);
  if (match) return match;

  return { status: 'not_found', reason: 'no matching SERP result' };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log(`Platform Ticket Link Validator ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const data = loadShows();
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

  let ticketmasterBudgetExit = false;
  for (const show of shows) {
    const links = show.ticketLinks || [];
    const tmIndex = links.findIndex(l => l.platform === 'Ticketmaster');
    if (tmIndex < 0) continue;

    // Each show's serpVerifyTicketmaster() runs a multi-provider SERP chain
    // with its own retries — this loop runs first in a 25-min job shared
    // with enrich-official-urls.js, so an unbounded catalog-wide list here
    // could starve that later step (same class as #369/#415).
    if (timeBudget.exceeded()) {
      ticketmasterBudgetExit = true;
      console.log(`⏱ Time budget (${timeBudget.minutes} min) reached — remaining Ticketmaster links deferred to next run.`);
      break;
    }

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
    const result = await serpVerifyTicketmaster(show, tmLink.url);

    if (result.status === 'ok') {
      console.log(`  ✓ URL confirmed`);
    } else if (result.status === 'updated') {
      // Defense-in-depth: the matcher already region-filters, but never let a
      // future matcher edit write a cross-region storefront (tm-gap-links gate).
      if (isRegionMismatch(result.newUrl, show)) {
        console.log(`  ⚠ Rejected region-mismatched candidate: ${result.newUrl} (keeping existing URL)`);
        stats.ticketmasterSkipped++;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
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

  console.log(`Ticketmaster: ${stats.ticketmasterChecked} checked, ${stats.ticketmasterFixed} fixed, ${stats.ticketmasterRemoved} removed, ${stats.ticketmasterSkipped} skipped${ticketmasterBudgetExit ? ' (time budget exit)' : ''}`);

  // ── Save ─────────────────────────────────────────────────────────
  const totalChanges = stats.telechargeFixed + stats.telechargeRemoved +
                       stats.ticketmasterFixed + stats.ticketmasterRemoved;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Total changes: ${totalChanges}`);

  if (!DRY_RUN && totalChanges > 0) {
    saveShows(data);
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

// Exported for scripts/tests/fix-platform-ticket-links.test.mjs (CLAUDE.md §15:
// tests require() the real decision function, never a copy).
module.exports = { matchTicketmasterFromResults };

if (require.main === module) {
  main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}
