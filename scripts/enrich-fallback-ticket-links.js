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
`;

if (hasHelpFlag(process.argv)) {
  console.log(USAGE);
  process.exit(0);
}

const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { serpQuery } = require('./lib/url-discovery');
const { pickTicketUrl, buildTicketQuery } = require('./lib/ticket-link-discovery');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 10;
const ONLY_SHOW = (process.argv.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;

/**
 * Liveness probe: the candidate URL must answer with a non-error status.
 * 2xx/3xx pass; 403 also passes (ticketing sites routinely bot-block GETs —
 * Marylebone/La Jolla confirmed cases — and a SERP-indexed, title-matched 403
 * page is a live page). 404/410/5xx fail.
 */
function probeUrl(url, timeout = 15000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(false); }
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
        const s = res.statusCode || 0;
        resolve((s >= 200 && s < 400) || s === 403);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
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
    console.log(`Attempting first ${LIMIT} this run (--limit); the daily cron drains the rest.`);
    targets = targets.slice(0, LIMIT);
  }

  let added = 0;
  let misses = 0;
  for (const show of targets) {
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
      show.ticketLinks = [{ platform: pick.platform, url: pick.url, priceFrom: null }];
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

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
