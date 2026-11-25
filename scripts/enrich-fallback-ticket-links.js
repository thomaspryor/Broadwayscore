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
 * Usage: node scripts/enrich-fallback-ticket-links.js [--dry-run] [--limit=N] [--venue-limit=N] [--show=ID]
 *
 * BRO-7368: before any SERP spend, shows at an allowlisted regional venue are
 * looked up on that venue's own sitemap / what's-on page (free direct reads).
 *
 * BRO-7668: then, for shows still with no ticket link and no officialUrl, the
 * theatre's own page already in hand (a first-party evidenceUrl, or the
 * website the theatreinX listing prints) becomes officialUrl, which the site
 * renders as "Visit Official Site" (BRO-166). Free direct reads only.
 */

const https = require('https');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-fallback-ticket-links.js — SERP-discover ticket links for open shows with none.

Usage:
  node scripts/enrich-fallback-ticket-links.js [--dry-run] [--limit=N] [--venue-limit=N] [--show=ID]
  node scripts/enrich-fallback-ticket-links.js --help, -h    print this usage and exit

Options:
  --dry-run    discover + verify but do not write shows.json
  --limit=N    max shows to SERP this run (default 10, bounds SERP spend)
  --venue-limit=N  max shows for the free venue-site lookup (default 40)
  --show=ID    only attempt this show id
  --time-budget-min=N  wall-clock budget in minutes (0/omitted = unlimited)
`;

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(USAGE);
  process.exit(0);
}

const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { serpQuery } = require('./lib/url-discovery');
const {
  pickTicketUrl, buildTicketQuery, platformForUrl, VENUE_SITES,
  venueHostForShow, pickChildSitemaps, extractSameHostLinks, pickVenuePageUrl,
  needsListingConfirmation,
} = require('./lib/ticket-link-discovery');
const { parseSitemapLocs } = require('./lib/gap-url-find');
const { isFirstPartyVenueUrl, pickFirstPartyVenueUrl } = require('./lib/first-party-venue-url');
const { parseSitemapLines } = require('./lib/sitemap-urls');
const { findTicketUrlHolder } = require('./lib/show-duplicate-detection');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 10;
// BRO-7368: the venue-host lookup is free (direct HTTP only), so it is capped
// separately and far higher than the SERP --limit, which bounds paid credits.
const VENUE_LIMIT = Number((process.argv.find((a) => a.startsWith('--venue-limit=')) || '').split('=')[1]) || 40;
const ONLY_SHOW = (process.argv.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));
// BRO-5338: update-show-status.yml runs this with --time-budget-min=8 under a
// step timeout-minutes of 10, so 2 min of slack. One show's worst case is a SERP
// fetchPage() chain (~2.5 min, run-budget.js header) plus probeUrl() (up to 4
// hops x 15s = 1 min), ~3.5 min, so an item started with under 1.5 min left
// (3.5 minus the 2 min slack) can carry the step past its timeout.
const MIN_REMAINING_MS_TO_START = 90_000;
// The venue phase runs first and must leave the SERP phase its time. The SERP
// phase (10 shows) took 23-61s on the 12 successful update-show-status runs of
// 2026-11-08..18, and its own worst single item is ~3.5 min (see above), so it
// keeps a 4 min reserve (~4x its observed need). The worst venue item is one
// uncached host crawl, MAX_VENUE_FETCHES reads at fetchPage's 10s direct
// timeout plus VENUE_REQUEST_GAP_MS between them (~84s), plus probeUrl (4 hops
// x 15s = 60s): ~2.5 min. A venue item therefore starts only with reserve +
// worst item (6.5 min) left, i.e. in the first ~90s of the cron's 8 min budget;
// the whole 30-show venue phase measured 69s on 2026-11-19.
const SERP_PHASE_RESERVE_MS = 240_000;
const VENUE_ITEM_WORST_MS = 150_000;
const MAX_VENUE_FETCHES = 8;
// Politeness gap between consecutive reads of one venue host.
const VENUE_REQUEST_GAP_MS = 500;

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

/** Free direct read (no paid or browser tier) of a venue sitemap / listing. */
async function fetchVenueText(url) {
  const { fetchPage } = require('./lib/scraper');
  const r = await fetchPage(url, { directOnly: true, skipVerify: true });
  return r.content;
}

/**
 * Every URL a venue host publishes about its shows: robots.txt Sitemap: lines
 * (else /sitemap.xml), up to 4 show-ish child sitemaps of an index, and the
 * /whats-on/ and homepage links. Tries https://www.<host> first and falls back
 * to the bare host when www. answers neither robots.txt nor sitemap.xml.
 * At most MAX_VENUE_FETCHES reads; a failed read is skipped. Returns
 * { all, listed }: `listed` is the subset seen on the listing pages.
 * fetchText is injectable so the tests drive it without a network.
 */
async function collectVenueUrls(host, fetchText = fetchVenueText, gapMs = VENUE_REQUEST_GAP_MS) {
  let fetches = 0;
  const seen = new Map();
  const read = async (url) => {
    if (seen.has(url)) return seen.get(url);
    if (fetches >= MAX_VENUE_FETCHES) return null;
    if (fetches > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    fetches++;
    let text = null;
    try { text = await fetchText(url); } catch { text = null; }
    seen.set(url, text);
    return text;
  };
  let origin = `https://www.${host}`;
  let robots = await read(`${origin}/robots.txt`);
  if (!robots && !(await read(`${origin}/sitemap.xml`))) {
    origin = `https://${host}`;
    robots = await read(`${origin}/robots.txt`);
  }
  const all = [];
  const roots = parseSitemapLines(robots || '').filter((u) => {
    try { return new URL(u).hostname.replace(/^www\./, '') === host; } catch { return false; }
  });
  if (roots.length === 0) roots.push(`${origin}/sitemap.xml`);
  for (const root of roots.slice(0, 2)) {
    const xml = await read(root);
    if (!xml) continue;
    const locs = parseSitemapLocs(xml);
    if (!/<sitemapindex/i.test(xml)) { all.push(...locs); continue; }
    for (const child of pickChildSitemaps(locs)) {
      const childXml = await read(child);
      if (childXml && !/<sitemapindex/i.test(childXml)) all.push(...parseSitemapLocs(childXml));
    }
  }
  // Listing pages last: the homepage features current shows that some CMSs
  // leave out of the sitemap (writerstheatre.org /events/the-royale).
  const listed = [];
  for (const page of [`${origin}/whats-on/`, `${origin}/`]) {
    const html = await read(page);
    if (html) listed.push(...extractSameHostLinks(html, page));
  }
  all.push(...listed);
  return { all, listed };
}

/**
 * SERP-free pick for one show: its allowlisted venue host's own pages.
 * `cache` (host → Promise<{all, listed}>) makes several shows at one venue
 * cost one crawl. `requireListed` (needsListingConfirmation: another run of
 * the same title at this venue exists) accepts only a URL on the venue's
 * current listing pages, so an undated archive page of the other run in the
 * sitemap can never be picked; a miss falls through to SERP.
 */
async function discoverVenuePage(show, { cache = new Map(), fetchText = fetchVenueText, gapMs, requireListed = false } = {}) {
  const host = venueHostForShow(show);
  if (!host) return null;
  if (!cache.has(host)) cache.set(host, collectVenueUrls(host, fetchText, gapMs));
  const { all, listed } = await cache.get(host);
  return pickVenuePageUrl(requireListed ? listed : all, show);
}

// ---------------------------------------------------------------------------
// BRO-7668: the theatre's own page as officialUrl (free, no SERP).
// ---------------------------------------------------------------------------

const HUB_DETAIL_RE = /^https?:\/\/(?:www\.)?theatrein(?:chicago|dc|la)\.com\/[^/]+\/\d+\/?$/i;

/** Open/previews, no ticket link and no official link: the page has no buy button at all. */
function needsOfficialPage(show) {
  return !!show && (show.status === 'open' || show.status === 'previews') &&
    (!show.ticketLinks || show.ticketLinks.length === 0) &&
    !(typeof show.officialUrl === 'string' && show.officialUrl.trim());
}

/** The theatreinX listing detail page this show was staged from, or null. */
function hubDetailUrl(show) {
  return ((show && show.evidenceUrls) || []).find((u) => HUB_DETAIL_RE.test(u || '')) || null;
}

/** The website link a theatreinX detail page prints for the production, or null. */
function parseHubWebsite(html) {
  const { parseDetailPage } = require('./lib/theatreinchicago');
  const d = parseDetailPage(html || '');
  return (d && d.website) || null;
}

/**
 * Liveness for a first-party page: https only (http is upgraded first),
 * redirects followed, and the page must END on the same theatre's site (a
 * dead domain parked on a reseller fails). 403 passes, as for venue sites in
 * probeUrl. Returns the https URL to store (the starting one), or null.
 */
async function probeFirstPartyUrl(url, venue, timeout = 15000, fetchStatusFn = fetchStatus) {
  if (typeof url !== 'string') return null;
  const start = url.trim().replace(/^http:/i, 'https:');
  let current = start;
  for (let hop = 0; hop < 4; hop++) {
    if (!isFirstPartyVenueUrl(current, venue)) return null;
    const { status, location } = await fetchStatusFn(current, timeout);
    // Store the URL we were given, not the redirect target: a box-office
    // redirect chain can end on a one-time session URL (arenastage.org ->
    // tickets.arenastage.org/components/sharedsession?...).
    if ((status >= 200 && status < 300) || status === 403) return start;
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString().replace(/^http:/i, 'https:');
      continue;
    }
    return null;
  }
  return null;
}

/**
 * One show: the first-party page to store as officialUrl, or null.
 * fetchText / fetchStatusFn are injectable for the tests.
 */
async function discoverOfficialPage(show, { fetchText = fetchVenueText, fetchStatusFn = fetchStatus } = {}) {
  const extra = [];
  const detail = hubDetailUrl(show);
  if (detail && !pickFirstPartyVenueUrl(show)) {
    let html = null;
    try { html = await fetchText(detail); } catch { html = null; }
    const site = parseHubWebsite(html);
    if (site) extra.push(site.trim());
  }
  const cand = pickFirstPartyVenueUrl(show, extra);
  if (!cand) return null;
  return probeFirstPartyUrl(cand, show.venue, 15000, fetchStatusFn);
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

  let added = 0;
  let misses = 0;

  // Phase 1 (BRO-7368): free venue-host lookup for shows at an allowlisted
  // regional venue. Same holder + liveness gates as the SERP path below.
  const venueCache = new Map();
  let venueTargets = targets.filter((s) => venueHostForShow(s));
  if (venueTargets.length > 0) {
    // Same day-of-month rotation as the SERP phase, so a budget cut-off never
    // starves the same tail of venue shows every day.
    const vOffset = new Date().getUTCDate() % venueTargets.length;
    venueTargets = venueTargets.slice(vOffset).concat(venueTargets.slice(0, vOffset)).slice(0, VENUE_LIMIT);
  }
  console.log(`Venue-host lookup: ${venueTargets.length} show(s) at an allowlisted venue host (--venue-limit=${VENUE_LIMIT}).`);
  for (const show of venueTargets) {
    if (!timeBudget.canStartItem(SERP_PHASE_RESERVE_MS + VENUE_ITEM_WORST_MS)) {
      console.log('\n⏱ Venue phase stopped to leave the SERP phase its time budget.');
      break;
    }
    console.log(`\n${show.id}: venue host ${venueHostForShow(show)}`);
    const requireListed = needsListingConfirmation(shows, show);
    const pick = await discoverVenuePage(show, { cache: venueCache, requireListed });
    if (!pick) { console.log('  ✗ no matching page on the venue site'); continue; }
    const holder = findTicketUrlHolder(shows, show, pick.url);
    if (holder) { console.log(`  ✗ ${pick.url} is already ${holder.id}'s listing`); continue; }
    if (!(await probeUrl(pick.url))) { console.log(`  ✗ URL failed liveness probe: ${pick.url}`); continue; }
    console.log(`  ✓ ${pick.platform}: ${pick.url}`);
    // Mark as filled even in --dry-run so the SERP phase does not re-spend on it.
    show.ticketLinks = [{ platform: pick.platform, url: pick.url, priceFrom: null, source: 'venue-sitemap' }];
    added++;
  }
  targets = targets.filter((s) => !s.ticketLinks || s.ticketLinks.length === 0);

  // Phase 2 (BRO-7668): the theatre's own page as officialUrl.
  // Only shows with a source to read (a first-party evidenceUrl or a theatreinX
  // listing); the cap then never spends itself on shows with nothing to read.
  const officialTargets = targets
    .filter((s) => needsOfficialPage(s) && (pickFirstPartyVenueUrl(s) || hubDetailUrl(s)))
    .slice(0, VENUE_LIMIT);
  console.log(`\nFirst-party official page: ${officialTargets.length} show(s) with no ticket or official link and a page to read.`);
  let officialAdded = 0;
  for (const show of officialTargets) {
    if (!timeBudget.canStartItem(SERP_PHASE_RESERVE_MS + 60_000)) {
      console.log('\n⏱ Official-page phase stopped to leave the SERP phase its time budget.');
      break;
    }
    const url = await discoverOfficialPage(show);
    if (!url) { console.log(`  ✗ ${show.id}: no live first-party page`); continue; }
    console.log(`  ✓ ${show.id}: officialUrl ${url}`);
    if (!DRY_RUN) {
      show.officialUrl = url;
    }
    officialAdded++;
  }
  console.log(`\nSERP phase: ${targets.length} show(s) still without ticketLinks.`);

  if (targets.length > LIMIT) {
    // Day-of-month rotation so permanently-unfindable shows at the head of
    // the list can't starve the tail forever (every gap show gets attempts
    // across successive daily runs).
    const offset = (new Date().getUTCDate() * LIMIT) % targets.length;
    targets = targets.slice(offset).concat(targets.slice(0, offset)).slice(0, LIMIT);
    console.log(`Attempting ${LIMIT} this run (--limit, rotation offset ${offset}); the daily cron cycles the rest.`);
  }

  for (const show of targets) {
    if (!timeBudget.canStartItem(MIN_REMAINING_MS_TO_START)) {
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
    // BRO-6280: the SERP can return another row's TodayTix listing (a tour's Broadway
    // parent, the real row of a duplicate stub); writing it mints a shared-ticket-identity pair.
    const holder = findTicketUrlHolder(shows, show, pick.url);
    if (holder) {
      console.log(`  ✗ ${pick.url} is already ${holder.id}'s listing`);
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

  console.log(`\nDone: ${added} link(s) discovered, ${officialAdded} official page(s) set, ${misses} miss(es).`);
  if (added + officialAdded > 0 && !DRY_RUN) {
    saveShows(data);
    console.log('shows.json updated.');
  } else if (DRY_RUN) {
    console.log('(dry run — nothing written)');
  }
}

// Exported for the colocated test suite; the sweep only runs when invoked
// directly (requiring this module must never trigger a live SERP run —
// the cousin --help bug class, in require() form).
module.exports = {
  probeUrl, isVenueSiteHost, collectVenueUrls, discoverVenuePage,
  needsOfficialPage, hubDetailUrl, parseHubWebsite, probeFirstPartyUrl, discoverOfficialPage,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
