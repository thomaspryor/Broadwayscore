#!/usr/bin/env node
/**
 * Fallback ticket-link enrichment for shows the other two enrichers can't fill.
 *
 * Coverage map before this script:
 *   - enrich-todaytix-data.js      → only shows listed on TodayTix
 *   - enrich-ticket-platform-links.js → only category=broadway + the 40 houses
 * Everything else (Off-Broadway, Off-West End, regional shows absent from
 * TodayTix) stayed at ticketLinks: [] forever — 29 open shows on 2026-07-31,
 * surfaced by the freshness digest but never self-healed.
 *
 * This script SERP-discovers a ticket URL for open/previews shows with empty
 * ticketLinks, accepting only allowlisted ticketing platforms / first-party
 * venue sites with a diacritic-folded title match (scripts/lib/
 * ticket-link-discovery.js), then verifies the URL responds before writing.
 *
 * Usage: node scripts/enrich-fallback-ticket-links.js [--dry-run] [--limit=N] [--show=ID]
 */

const https = require('https');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-fallback-ticket-links.js — SERP-discover ticket links for open shows with none.

Usage:
  node scripts/enrich-fallback-ticket-links.js [--dry-run] [--limit=N] [--show=ID]
  node scripts/enrich-fallback-ticket-links.js --help, -h    print this usage and exit

Options:
  --dry-run    discover + verify but do not write shows.json
  --limit=N    max shows to attempt this run (default 10, bounds SERP spend)
  --show=ID    only attempt this show id
  --time-budget-min=N  wall-clock budget in minutes (0/omitted = unlimited)
`;

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(USAGE);
  process.exit(0);
}

const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { serpQuery } = require('./lib/url-discovery');
const { pickTicketUrl, buildTicketQuery, platformForUrl, VENUE_SITES } = require('./lib/ticket-link-discovery');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 10;
const ONLY_SHOW = (process.argv.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

function isVenueSiteHost(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return VENUE_SITES.some((v) => host === v || host.endsWith('.' + v));
  } catch {
    return false;
  }
}

function fetchStatus(url, timeout) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ status: 0 }); }
    if (u.protocol !== 'https:') return resolve({ status: 0 });
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        timeout,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode || 0, location: res.headers.location });
      }
    );
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.end();
  });
}

/**
 * Liveness probe. Follows up to 3 redirects to a final status. 2xx passes
 * only if the final URL is still on an allowlisted host (a 302 to an
 * unrelated landing page must not count as alive); 403 passes only for
 * first-party venue sites (they routinely bot-block plain GETs —
 * Marylebone/La Jolla confirmed — while the big platforms answer 200, so a
 * platform 403 is suspicious, not normal).
 *
 * fetchStatusFn is injectable so the unit tests can drive every branch
 * deterministically (test-extraction rule: the tests exercise THIS function,
 * not a copy).
 */
async function probeUrl(url, timeout = 15000, fetchStatusFn = fetchStatus) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const { status, location } = await fetchStatusFn(current, timeout);
    if (status >= 200 && status < 300) return platformForUrl(current) !== null;
    if (status === 403) return isVenueSiteHost(current);
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return false;
  }
  return false;
}

async function main() {
  const data = loadShows();
  const shows = Array.isArray(data) ? data : data.shows;

  let targets = shows.filter(
    (s) =>
      (s.status === 'open' || s.status === 'previews') &&
      (!s.ticketLinks || s.ticketLinks.length === 0)
  );
  if (ONLY_SHOW) targets = targets.filter((s) => s.id === ONLY_SHOW);

  console.log(`Open/previews shows without ticketLinks: ${targets.length}`);
  if (targets.length > LIMIT) {
    // Day-of-month rotation so permanently-unfindable shows at the head of
    // the list can't starve the tail forever (every gap show gets attempts
    // across successive daily runs).
    const offset = (new Date().getUTCDate() * LIMIT) % targets.length;
    targets = targets.slice(offset).concat(targets.slice(0, offset)).slice(0, LIMIT);
    console.log(`Attempting ${LIMIT} this run (--limit, rotation offset ${offset}); the daily cron cycles the rest.`);
  }

  let added = 0;
  let misses = 0;
  for (const show of targets) {
    if (timeBudget.exceeded()) {
      console.log(`\n⏱ Time budget (${timeBudget.minutes} min) reached — remaining shows deferred to next run.`);
      break;
    }
    const query = buildTicketQuery(show);
    console.log(`\n${show.id}: SERP "${query}"`);
    let results = null;
    try {
      results = await serpQuery(query, { nbResults: 10 });
    } catch (err) {
      console.log(`  ⚠ SERP error: ${err.message}`);
    }
    if (!results || results.length === 0) {
      console.log('  ✗ no SERP results');
      misses++;
      continue;
    }
    const pick = pickTicketUrl(results, show);
    if (!pick) {
      console.log('  ✗ no allowlisted, title-matched result');
      misses++;
      continue;
    }
    const alive = await probeUrl(pick.url);
    if (!alive) {
      console.log(`  ✗ URL failed liveness probe: ${pick.url}`);
      misses++;
      continue;
    }
    console.log(`  ✓ ${pick.platform}: ${pick.url}`);
    if (!DRY_RUN) {
      // source marks lower-confidence SERP-discovered links so a bad batch can
      // be bulk-identified and rolled back without touching curated links.
      show.ticketLinks = [{ platform: pick.platform, url: pick.url, priceFrom: null, source: 'serp-fallback' }];
    }
    added++;
    // Space SERP calls out — same 500ms pacing as enrich-ticket-platform-links.
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone: ${added} link(s) discovered, ${misses} miss(es).`);
  if (added > 0 && !DRY_RUN) {
    saveShows(data);
    console.log('shows.json updated.');
  } else if (DRY_RUN) {
    console.log('(dry run — nothing written)');
  }
}

// Exported for the colocated test suite; the sweep only runs when invoked
// directly (requiring this module must never trigger a live SERP run —
// the cousin --help bug class, in require() form).
module.exports = { probeUrl, isVenueSiteHost };

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
