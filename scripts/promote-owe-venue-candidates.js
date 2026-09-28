#!/usr/bin/env node
'use strict';
/**
 * Off-West End venue-page promotion (BRO-4204 S4-T11) — the OWE analogue of
 * promote-we-aggregator-candidates.js (West End, aggregator listings) and
 * promote-ob-venue-candidates.js (Off-Broadway, venue-page staging).
 *
 * Problem: since BRO-182 the Off-West End venue pages in
 * discover-new-shows.js's VENUE_LISTING_PAGES (Almeida, Menier, Southwark,
 * The Other Palace, Orange Tree, Park, ...) stage what they find in
 * data/audit/owe-venue-candidates.json instead of writing shows.json
 * directly — venue pages list one-night events, talks and tribute concerts
 * next to real productions, so a direct write was unsafe. Nothing ever read
 * that staging file back: 106 candidates sat there (audit 2026-09-28) and
 * the reviewed Off-West End productions they represent were missing from
 * the site.
 *
 * Confirmation rule (the S4-T11 spec): a staged candidate is promoted when
 *   1. its venue is one of VENUE_LISTING_PAGES (the curated OWE venue pages
 *      discovery scrapes — there is no curated Off-West End venue directory
 *      to fall back on, unlike WEST_END_VENUES / OFF_BROADWAY_VENUES), AND
 *   2. that venue page STILL lists the title on a live re-fetch through
 *      fetchPage() (scripts/lib/scraper.js — the scraper rule), parsed by
 *      the same parseVenueListingPage() that staged it (CLAUDE.md §15).
 * Before either check: the S4-T6 ingest gate (isNonTheatreVenue /
 * isLondonReceivingHouse / isNonTheaterContent with market:'london') refuses
 * stadiums, arenas, concert halls, cabaret rooms, receiving-house tour
 * stops and festival/panel/screening titles outright — this promoter is
 * NOT an aggregator promoter, so docs/show-inclusion-policy.md's "safety
 * valve" (reviews prove a production) does not apply: a venue listing is
 * not review evidence.
 *
 * Dedup: lib/candidate-dedup.js's findExistingMatch (with the S4-T9 London-
 * pool title fallback) against every west-end / off-west-end row, then the
 * retired-id registry (lib/retired-show-ids.js matchesRetired on the minted
 * id AND on title+venue), then an id collision check.
 *
 * Writes: rows go to shows.json ONLY through createShowsWriteGuard(...)
 * .saveShows with a reason; --dry-run builds the guard with dryRun:true so
 * every write is suppressed at the seam (nothing on disk is touched — not
 * shows.json, not the staging file, not the audit log). Promoted rows are
 * `provisional: true` with discoverySource venue-page:<slug>, so
 * validate-show-venue.js --all-provisional keeps cross-checking them, and
 * status 'announced' (type null) unless the candidate carries real dates —
 * the same dateless rule discover-new-shows.js applies; update-show-
 * status.js's Check 2e/2d promote them once dates or reviews appear.
 *
 * Staging is pruned through lib/owe-venue-staging.js's updateStaging (a
 * removal set over candidateHash under the file lock, never a pre-computed
 * array): promoted rows and PERSISTENT refusals (a duplicate, a retired id,
 * a non-theatre venue, a title the venue page no longer lists) leave
 * staging; fetch-dependent holds (the venue page failed to fetch, parsed to
 * nothing, or was skipped by --limit / the time budget) stay for the next
 * run. Discovery re-stages anything a venue page still lists, so a pruned
 * refusal that is genuinely still listed simply comes back tomorrow and is
 * refused again — cheap, and never a lost candidate.
 *
 * Flags:
 *   --dry-run            evaluate and report; write nothing (default: writes)
 *   --limit=N            cap venue-page fetches this run (default 20 — one per
 *                        distinct staged venue; there are ~12)
 *   --max-promote=N      cap rows written this run (default MAX_PROMOTE_PER_RUN;
 *                        the remainder is HELD in staging for the next run,
 *                        not aborted — every row here was confirmed against
 *                        the venue's own page, and the first run drains a
 *                        real 100-candidate backlog)
 *   --time-budget-min=N  wall-clock budget (0/omitted = unlimited)
 */

const fs = require('fs');
const path = require('path');
const { createShowsWriteGuard, SHOWS_PATH } = require('./lib/shows-write-guard');
const { AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
const { findExistingMatch } = require('./lib/candidate-dedup');
const {
  isNonTheatreVenue,
  isLondonReceivingHouse,
  sanitizeVenueForWrite,
  marketForCategory,
  normalizeVenueName,
} = require('./lib/venue-classification');
const { matchesRetired, loadRetiredIds } = require('./lib/retired-show-ids');
const { normalizeShowTitle, buildVenueVocabulary } = require('./lib/show-title-normalize');
const { normalizeTitle } = require('./lib/title-match');
const { urlFragmentReason } = require('./lib/url-fragment-title');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { loadStaging, updateStaging, STAGING_PATH } = require('./lib/owe-venue-staging');

// venue-write-guard-ok: the ONLY shows.json venue write in this file is
// buildOffWestEndVenueShowEntry's `venue: sanitizeVenueForWrite(candidate.venue)`
// (and evaluateCandidates refuses the row when that returns null). Every other
// `venue:` literal here propagates an already-written or already-staged venue
// string into the dedup pool, the jsonl audit log, the state file the workflow
// summarises, or a gate/normaliser INPUT — none of them a shows.json write.
// Same shape as promote-we-aggregator-candidates.js / we-rejected-candidates.js.

const USAGE = `promote-owe-venue-candidates.js — promote Off-West End venue-page candidates from staging → shows.json.

Usage:
  node scripts/promote-owe-venue-candidates.js [options]
  node scripts/promote-owe-venue-candidates.js --help, -h    print this usage and exit

Options:
  --dry-run            evaluate and report; write nothing
  --limit=N            cap venue-page fetches this run (default 20)
  --max-promote=N      cap rows written this run; the rest stay staged (default 25)
  --time-budget-min=N  wall-clock budget in minutes (0/omitted = unlimited)
`;

const PROMOTION_LOG = path.join(__dirname, '..', 'data', 'audit', 'owe-promotion-log.jsonl');
// Own state file — NOT the WE promoter's we-last-promotion-ids.json nor the
// OB script's last-promotion-ids.json: two crons writing one filename race,
// and promote-owe-venue-candidates.yml's job-summary step reads THIS one.
const LAST_PROMOTION_FILE = path.join(__dirname, '..', 'data', 'audit', 'owe-last-promotion-ids.json');
const MAX_PROMOTE_PER_RUN = 25;
const DEFAULT_FETCH_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

// discover-new-shows.js parses process.argv at module load (its own --help
// prints ITS usage and exits, its --dry-run/--time-budget-min consts are
// read at require time) — so it is required lazily, after this script's
// own help check, and never at the top level.
let _discovery = null;
function discovery() {
  if (!_discovery) _discovery = require('./discover-new-shows');
  return _discovery;
}

// Same shape as the WE promoter's we-last-promotion-ids.json, so
// scripts/we-promotion-job-summary.js renders it with --state=<this file>.
function writeLastPromotionFile(promoted, rejected = [], file = LAST_PROMOTION_FILE) {
  const out = {
    generatedAt: new Date().toISOString(),
    promoted: promoted.map(p => ({ id: p.entry.id, source: p.candidate.source || null, sourceUrl: p.sourceUrl || null })),
    rejected: rejected.map(r => ({ title: r.title, venue: r.venue, source: r.source || null, sourceUrl: r.sourceUrl || null, kind: r.kind, reason: r.reason })),
  };
  const tmp = file + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function logEntry(entry) {
  try {
    fs.mkdirSync(path.dirname(PROMOTION_LOG), { recursive: true });
    fs.appendFileSync(PROMOTION_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`Failed to append promotion log: ${e.message}`);
  }
}

/**
 * The VENUE_LISTING_PAGES entry a staged candidate's venue string names, or
 * null. Matched on normalizeVenueName equality ("The Other Palace" ↔ "other
 * palace", "Almeida Theatre" ↔ "almeida") so a hand-staged candidate with a
 * slightly different spelling still finds its page; never a substring match
 * (that is how "Park Theatre" would swallow "Hampstead Theatre" — no; it is
 * how a first-word collision class of bug starts).
 */
function findVenueListingPage(venue, listingPages) {
  if (!venue) return null;
  const pages = Array.isArray(listingPages) ? listingPages : discovery().VENUE_LISTING_PAGES;
  const key = normalizeVenueName(venue);
  if (!key) return null;
  return pages.find(p => p && p.category === 'off-west-end' && normalizeVenueName(p.name) === key) || null;
}

/**
 * Pure promotion rule for one staged Off-West End venue-page candidate
 * ({title, venue, category, source, description, ...}). Testable in
 * isolation (CLAUDE.md §15). `persistent` says whether the refusal is a
 * property of the candidate (prune it from staging — discovery re-stages it
 * if the venue page still lists it) or of THIS run's fetches (hold it).
 *
 * @param {object} candidate
 * @param {object} [ctx]
 * @param {Map<string, {titles: Set<string>|null, error: string|null}>} [ctx.venueListings]
 *   keyed by VENUE_LISTING_PAGES `name`; `titles` are normalizeTitle()d
 *   titles parsed from the live page (see fetchVenueListing). Missing key =
 *   not fetched this run.
 * @param {Array<object>} [ctx.listingPages] defaults to VENUE_LISTING_PAGES
 * @param {Function} [ctx.isNonTheaterContent] defaults to discovery's gate
 * @param {Function} [ctx.shouldExcludeVenueShow] defaults to discovery's venue-page title exclusions
 * @returns {{confirmed: boolean, persistent?: boolean, reason: string, source?: string, page?: object}}
 */
function decideOffWestEndVenuePromotion(candidate, ctx = {}) {
  const venueListings = ctx.venueListings instanceof Map ? ctx.venueListings : new Map();
  const gate = typeof ctx.isNonTheaterContent === 'function' ? ctx.isNonTheaterContent : discovery().isNonTheaterContent;
  const excludeTitle = typeof ctx.shouldExcludeVenueShow === 'function' ? ctx.shouldExcludeVenueShow : discovery().shouldExcludeVenueShow;

  if (!candidate || candidate.category !== 'off-west-end') {
    return { confirmed: false, persistent: true, reason: 'not an off-west-end candidate' };
  }
  if (!candidate.title || !candidate.venue) {
    return { confirmed: false, persistent: true, reason: 'missing title or venue' };
  }

  // A title that is a URL fragment ("?tab=dates") is a phantom row minted
  // from a tab/pagination control (BRO-3915) — validate-data.js refuses it
  // after the fact; refuse it here so it never costs the batch.
  const fragment = urlFragmentReason(candidate.title);
  if (fragment) {
    return { confirmed: false, persistent: true, reason: `title "${candidate.title}" is a URL fragment (${fragment}) — phantom listing-scraper row, never a production` };
  }
  // Discovery's own venue-page exclusions (workshops, galas, Q&As, coffee
  // concerts, labs, ...) re-applied at promotion time so a candidate staged
  // BEFORE a phrase was added is still caught.
  if (excludeTitle(candidate.title)) {
    return { confirmed: false, persistent: true, reason: `"${candidate.title}" matches a venue-page exclusion phrase (VENUE_PAGE_EXCLUDE_PATTERNS / NON_THEATER_PATTERNS) — not a production` };
  }

  // S4-T6 ingest gate — London paths reject these outright (no TodayTix
  // Plays/Musicals override): a venue listing is not review evidence.
  if (isNonTheatreVenue(candidate.venue)) {
    return { confirmed: false, persistent: true, reason: `venue "${candidate.venue}" matches NON_THEATRE_VENUE_RE (stadium/arena/concert hall/cabaret room) — refused at ingest (docs/show-inclusion-policy.md)` };
  }
  if (isLondonReceivingHouse(candidate.venue)) {
    return { confirmed: false, persistent: true, reason: `venue "${candidate.venue}" is a Greater London receiving house (UK tour stops) — refused at ingest (docs/show-inclusion-policy.md)` };
  }
  if (gate({ name: candidate.title, venue: candidate.venue, description: candidate.description || '' }, { market: 'london' })) {
    return { confirmed: false, persistent: true, reason: `"${candidate.title}" @ ${candidate.venue} fails the London ingest gate (isNonTheaterContent: festival/panel/screening/one-off title or non-theatre venue)` };
  }

  const page = findVenueListingPage(candidate.venue, ctx.listingPages);
  if (!page) {
    return { confirmed: false, persistent: true, reason: `venue "${candidate.venue}" is not one of the curated VENUE_LISTING_PAGES Off-West End venue pages — venue-page confirmation is impossible (add the venue to VENUE_LISTING_PAGES in scripts/discover-new-shows.js, or add the show by hand)` };
  }
  const listing = venueListings.get(page.name);
  if (!listing) {
    return { confirmed: false, persistent: false, reason: `venue page for ${page.name} was not fetched this run (--limit / time budget) — held`, page };
  }
  if (listing.error || !(listing.titles instanceof Set)) {
    return { confirmed: false, persistent: false, reason: `venue page fetch failed for ${page.name} (${listing.error || 'no titles'}) — held for the next run`, page };
  }
  if (listing.titles.size === 0) {
    // A venue's own what's-on page listing zero productions is a fetch or
    // parser failure (interstitial, blocked, markup change), never proof
    // the show is gone — treating it as "no longer listed" would let one
    // markup change prune the whole venue out of staging.
    return { confirmed: false, persistent: false, reason: `venue page for ${page.name} parsed to 0 listings — treated as a fetch/parser failure, held`, page };
  }
  if (!listing.titles.has(normalizeTitle(candidate.title))) {
    return { confirmed: false, persistent: true, reason: `venue page ${page.url} no longer lists "${candidate.title}" (${listing.titles.size} listed) — dropped from staging; discovery re-stages it if it reappears`, page };
  }
  return { confirmed: true, persistent: false, reason: `venue page ${page.name} (${page.url}) lists "${candidate.title}" on re-fetch`, source: 'venue-page', page };
}

function validDateOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v).getTime()) ? v : null;
}

/**
 * Show entry for a candidate confirmed via decideOffWestEndVenuePromotion.
 * Dateless in the ordinary case (link-extracted venue pages carry no
 * dates), so status is 'announced' with type null — the same rule
 * discover-new-shows.js applies to a candidate with no opening or preview
 * date, and the shape promote-ob-venue-candidates.js's buildShowEntry
 * writes for the OB venue-page class. A candidate that DOES carry dates
 * (JSON-LD venues, a hand-staged S8-T3 row) gets the matching discovery
 * status, and then a non-null type, because validate-market-expansion.js
 * requires `type` on every status but 'announced' (BRO-3716 kept main red
 * for 19.8h on exactly that).
 *
 * The id is minted by discovery's own mintCandidateId (idYear from the
 * dates, else the current year; withMarketSuffix is idempotent) so the id
 * this row gets is the id discovery would have minted — which is what the
 * retired-id registry compares against.
 */
function buildOffWestEndVenueShowEntry(candidate, venueVocabulary, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  // BRO-3863 — normalise BEFORE the slug/id are derived from the title, with
  // the same normaliser validate-data.js gates on, so a row written here can
  // never fail the gate that guards it.
  const normalizedTitle = normalizeShowTitle({ title: candidate.title, venue: candidate.venue }, { venueVocabulary }).title;
  const openingDate = validDateOrNull(candidate.openingDate);
  const previewsStartDate = validDateOrNull(candidate.previewsStartDate);
  const closingDate = validDateOrNull(candidate.closingDate);
  const minted = discovery().mintCandidateId({
    title: normalizedTitle,
    category: 'off-west-end',
    openingDate,
    previewsStartDate,
    closingDate,
  }, now);

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let status = 'announced';
  if (openingDate) {
    status = new Date(openingDate + 'T00:00:00Z') > today ? 'upcoming' : 'open';
  } else if (previewsStartDate) {
    status = new Date(previewsStartDate + 'T00:00:00Z') > today ? 'upcoming' : 'previews';
  }
  if (status !== 'announced' && closingDate && new Date(closingDate + 'T00:00:00Z').getTime() < today.getTime() - DAY_MS) {
    status = 'closed';
  }

  return {
    id: minted.showId,
    title: normalizedTitle,
    slug: minted.marketSlug,
    // Write-time placeholder/neighbourhood-blob guard (S0-T3, card #994):
    // null on a placeholder venue; evaluateCandidates refuses to promote
    // rather than write a garbage venue string.
    venue: sanitizeVenueForWrite(candidate.venue),
    openingDate,
    openingDateSource: openingDate ? 'venue-page' : null,
    previewsStartDate,
    closingDate,
    status,
    category: 'off-west-end',
    market: marketForCategory('off-west-end'),
    type: status === 'announced' ? null : (/\bmusical\b/i.test(normalizedTitle) ? 'musical' : 'play'),
    discoverySource: candidate.source || candidate.discoverySource || 'venue-page',
    discoveredAt: candidate.discoveredAt || now.toISOString(),
    // Provisional — no cross-source corroboration beyond the venue's own
    // page; validate-show-venue.js --all-provisional keeps checking it, and
    // images/cast/exact dates arrive via later enrichment.
    provisional: true,
  };
}

/**
 * Staged candidates, in the shape evaluateCandidates expects. Reads the
 * staging file lib/owe-venue-staging.js manages (never re-derives from the
 * venue pages — that is discovery's job). Legacy rows without `source` get
 * it from `discoverySource`, and every row is given its candidateHash so
 * the prune below can address it.
 */
function collectCandidates(opts = {}) {
  const stagingPath = opts.stagingPath || STAGING_PATH;
  const staged = Array.isArray(opts.staged) ? opts.staged : loadStaging(stagingPath);
  const { candidateHash } = require('./lib/owe-venue-staging');
  return staged
    .filter(c => c && typeof c === 'object')
    .map(c => ({
      ...c,
      source: c.source || c.discoverySource || null,
      category: c.category || 'off-west-end',
      candidateHash: c.candidateHash || candidateHash(c),
    }));
}

/**
 * Live re-fetch of ONE venue page through fetchPage(), parsed by discovery's
 * parseVenueListingPage. Never throws: a failure is reported as
 * {titles: null, error} so decideOffWestEndVenuePromotion holds (not
 * prunes) that venue's candidates.
 */
async function fetchVenueListing(page, opts = {}) {
  const fetchPage = opts.fetchPage || require('./lib/scraper').fetchPage;
  const log = opts.log || console.log;
  try {
    const fetchOpts = { renderJs: false };
    if (page.preferPlaywright) fetchOpts.preferPlaywright = true;
    const result = await fetchPage(page.url, fetchOpts);
    const html = result && result.content ? result.content : '';
    if (!html) return { page, titles: null, rowCount: 0, error: 'empty response' };
    const rows = discovery().parseVenueListingPage(page, html);
    const titles = new Set(rows.map(r => normalizeTitle(r.title)).filter(Boolean));
    log(`  ${page.name}: ${rows.length} listing(s) on re-fetch`);
    return { page, titles, rowCount: rows.length, error: null };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log(`  ${page.name}: fetch failed (${msg.slice(0, 120)})`);
    return { page, titles: null, rowCount: 0, error: msg };
  }
}

/**
 * One fetch per distinct staged venue that has a VENUE_LISTING_PAGES entry,
 * bounded by --limit and the time budget. Candidates at venues with no
 * listing page cost no fetch (decideOffWestEndVenuePromotion refuses them
 * without one).
 * @returns {Promise<Map<string, object>>} keyed by page name
 */
async function fetchVenueListings(candidates, opts = {}) {
  const { limit = DEFAULT_FETCH_LIMIT, timeBudget = null, log = () => {} } = opts;
  const pages = new Map();
  for (const c of candidates) {
    const page = findVenueListingPage(c && c.venue, opts.listingPages);
    if (page && !pages.has(page.name)) pages.set(page.name, page);
  }
  const listings = new Map();
  let fetches = 0;
  for (const [name, page] of pages) {
    if (fetches >= limit) {
      log(`  [limit] reached --limit=${limit} venue fetches; ${pages.size - fetches} venue(s) held until the next run`);
      break;
    }
    if (timeBudget && timeBudget.exceeded()) {
      log(`  ⏱ Time budget (${timeBudget.minutes} min) reached — remaining venue pages held until the next run`);
      break;
    }
    fetches++;
    listings.set(name, await fetchVenueListing(page, opts));
  }
  return listings;
}

/**
 * Per-candidate evaluation loop (mirrors promote-we-aggregator-candidates.js's
 * evaluateCandidates, CLAUDE.md §15): dedup → retired-id registry → S4-T6
 * gate + venue-page confirmation → title sanity → entry → id collision.
 * Each candidate is evaluated in its own try/catch so one throw is
 * recorded as a `candidate-error` hold and the batch continues.
 *
 * @param {Array<object>} candidates from collectCandidates()
 * @param {object} ctx
 * @param {Array<{id,title,venue,category}>} ctx.existingCandidates London-pool rows (mutated: promotions appended)
 * @param {Set<string>} ctx.existingIds (mutated: promoted ids added)
 * @param {object} ctx.venueVocabulary from buildVenueVocabulary()
 * @param {Map<string, object>} ctx.venueListings from fetchVenueListings()
 * @param {Array<object>} [ctx.retiredEntries] registry entries (default: cached on-disk list)
 * @param {Array<object>} [ctx.listingPages] default VENUE_LISTING_PAGES
 * @param {number} [ctx.maxPromote] cap on promotions this run; the rest are held
 * @param {{exceeded(): boolean, minutes: number}} [ctx.timeBudget]
 * @param {Function} [ctx.log]
 * @param {Function} [ctx.logEntry] injectable audit-log sink
 * @param {Function} [ctx.now] clock
 * @returns {Promise<{promoted: Array, held: Array, pruned: Array}>}
 *   pruned = candidates that leave staging (promoted + persistent refusals)
 */
async function evaluateCandidates(candidates, ctx) {
  const {
    existingCandidates,
    existingIds,
    venueVocabulary,
    venueListings = new Map(),
    retiredEntries = undefined,
    listingPages = undefined,
    maxPromote = MAX_PROMOTE_PER_RUN,
    timeBudget = null,
    log = () => {},
    logEntry: logEntryFn = logEntry,
    now = () => new Date(),
  } = ctx;
  const promoted = [];
  const held = [];
  const pruned = [];

  const hold = (c, kind, reason, extra = {}) => {
    held.push({ candidate: c, kind, reason });
    logEntryFn({ kind, title: c.title, venue: c.venue, source: c.source, reason, ...extra });
  };
  const prune = (c, kind, reason, extra = {}) => {
    pruned.push({ candidate: c, kind, reason });
    logEntryFn({ kind, title: c.title, venue: c.venue, source: c.source, reason, ...extra });
  };

  for (const c of candidates) {
    if (timeBudget && timeBudget.exceeded()) {
      log(`\n⏱ Time budget (${timeBudget.minutes} min) reached — remaining candidates held for the next run.`);
      for (const rest of candidates.slice(candidates.indexOf(c))) held.push({ candidate: rest, kind: 'skip-time-budget', reason: 'time budget reached' });
      break;
    }
    try {
      // 1. Already in shows.json (venue-gated match, then the London-pool
      //    title fallback) — the ordinary way a staged candidate resolves
      //    once TodayTix/OLT/a hand add landed the same production.
      const existingMatch = findExistingMatch(c, existingCandidates);
      if (existingMatch) {
        prune(c, 'skip-duplicate', `already in shows.json as ${existingMatch.match.id} (${existingMatch.reason})`, { matchedTo: existingMatch.match.id, matchReason: existingMatch.reason });
        continue;
      }

      // 2. Retired-id registry (S0-T2), BEFORE any venue-page evidence is
      //    consulted: on the id this row would mint AND on title+venue (a
      //    blockTitleVenue retirement — the "?tab=dates" phantom class —
      //    must never come back under any id, and must never depend on a
      //    fetch to be refused). The entry is built first because the
      //    registry compares the MINTED id (mintCandidateId, same as
      //    discovery) and the sanitized venue.
      const entry = buildOffWestEndVenueShowEntry(c, venueVocabulary, { now: now() });
      const retiredHit = matchesRetired({ id: entry.id, title: entry.title, venue: entry.venue }, retiredEntries);
      if (retiredHit) {
        prune(c, 'skip-retired', `matches retired ${retiredHit.id} by ${retiredHit.matchedBy} — never re-add (data/retired-show-ids.json)`, { retiredId: retiredHit.id, matchedBy: retiredHit.matchedBy });
        continue;
      }

      // 3. Confirmation: phantom/excluded titles, the S4-T6 ingest gate, then
      //    the venue page itself.
      const decision = decideOffWestEndVenuePromotion(c, { venueListings, listingPages });
      if (!decision.confirmed) {
        if (decision.persistent) prune(c, 'skip-unconfirmed', decision.reason);
        else hold(c, 'skip-unconfirmed', decision.reason);
        continue;
      }

      // 4. BRO-3920 — a shouted title is detection-only: hold it for a human
      //    rather than write it and fail validate-data for the whole batch.
      const titleCheck = normalizeShowTitle({ title: c.title, venue: c.venue }, { venueVocabulary });
      if (titleCheck.manualReview) {
        hold(c, 'skip-shouted-title', 'shouted title — needs a human to check the venue page\'s structured metadata (scripts/lib/title-display-case.js)');
        continue;
      }

      if (!entry.venue) {
        prune(c, 'skip-invalid-venue', `venue "${c.venue}" failed sanitizeVenueForWrite (placeholder/neighbourhood blob)`);
        continue;
      }

      if (existingIds.has(entry.id)) {
        prune(c, 'skip-id-collision', `id ${entry.id} already exists`, { id: entry.id });
        continue;
      }

      if (promoted.length >= maxPromote) {
        hold(c, 'skip-cap-deferred', `confirmed, but --max-promote=${maxPromote} reached this run — held for the next run`);
        continue;
      }

      promoted.push({ candidate: c, entry, confirmationReason: decision.reason, sourceUrl: decision.page ? decision.page.url : null });
      existingIds.add(entry.id);
      existingCandidates.push({ id: entry.id, title: entry.title, venue: entry.venue, category: entry.category });
      pruned.push({ candidate: c, kind: 'promote', reason: decision.reason });
      // The `promote` audit line is written by main() only after the
      // shows.json write landed (see promote-we-aggregator-candidates.js for
      // why logging eagerly leaves the log claiming ghosts).
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      hold(c, 'candidate-error', `threw during evaluation: ${msg}`);
      log(`  ::warning::candidate "${c && c.title}" (${(c && c.venue) || 'no venue'}) threw — held, batch continues: ${msg}`);
    }
  }

  return { promoted, held, pruned };
}

function parseIntFlag(argv, name, fallback) {
  const raw = (argv.find(a => a.startsWith(`${name}=`)) || '').split('=')[1];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * @param {string[]} [argv] CLI args (default process.argv)
 * @param {object} [io] injectable I/O for tests and offline runs:
 *   fetchPage replaces lib/scraper.js's; log replaces console.log; logEntry
 *   replaces the jsonl audit-log append; showsPath / stagingPath redirect
 *   the two data files, lastPromotionFile the state file the workflow
 *   summarises; retiredEntries replaces the on-disk registry.
 * @returns {Promise<{promoted: Array, held: Array, pruned: Array, dryRun: boolean, suppressedWrites: Array}|undefined>}
 */
async function main(argv = process.argv.slice(2), io = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const dryRun = argv.includes('--dry-run');
  const limit = parseIntFlag(argv, '--limit', DEFAULT_FETCH_LIMIT);
  const maxPromote = parseIntFlag(argv, '--max-promote', MAX_PROMOTE_PER_RUN);
  const log = io.log || ((...a) => console.log(...a));
  const timeBudget = createRunBudget(parseTimeBudgetMin(argv));
  const showsPath = io.showsPath || SHOWS_PATH;
  const stagingPath = io.stagingPath || STAGING_PATH;
  const lastPromotionFile = io.lastPromotionFile || LAST_PROMOTION_FILE;
  // Every shows.json write goes through this guard; --dry-run builds it
  // dryRun so saveShows() records the intended write instead of touching
  // disk (the same seam validate-data.js --dry-run uses, S0-T1).
  const showsGuard = createShowsWriteGuard(showsPath, { dryRun });
  // A dry run must not touch data/ at all — the audit log included.
  const logEntryFn = io.logEntry || (dryRun ? () => {} : logEntry);

  // Reset up front so a crash mid-run can never leave a stale file claiming
  // a prior run's promotions happened again.
  if (!dryRun) writeLastPromotionFile([], [], lastPromotionFile);

  const candidates = collectCandidates({ stagingPath });
  log(`Loaded ${candidates.length} staged Off-West End venue-page candidate(s) from ${path.relative(process.cwd(), stagingPath)}.`);
  const result = { promoted: [], held: [], pruned: [], dryRun, suppressedWrites: showsGuard.suppressedWrites };
  if (candidates.length === 0) {
    log('No staged candidates to promote.');
    if (!dryRun) writeLastPromotionFile([], [], lastPromotionFile);
    return result;
  }

  let showsData;
  try {
    showsData = showsGuard.loadShows();
  } catch (e) {
    console.error(`Failed to load ${showsPath}: ${e.message}`);
    process.exit(1);
  }
  const existingIds = new Set(showsData.shows.map(s => s.id));
  // Writer/gate equivalence (BRO-3863): the same corpus venue vocabulary
  // validate-data.js normalises titles with.
  const venueVocabulary = buildVenueVocabulary(showsData.shows);
  // `category` carried so findExistingMatch's London-pool title fallback
  // (S4-T9) applies to off-west-end candidates too.
  const existingCandidates = showsData.shows
    .filter(s => s.category === 'west-end' || s.category === 'off-west-end')
    .map(s => ({ id: s.id, title: s.title, venue: s.venue, category: s.category }));
  // Loud on a malformed registry (loadRetiredIds throws) — silently treating
  // it as empty is exactly how a retired id slips back in.
  const retiredEntries = Array.isArray(io.retiredEntries) ? io.retiredEntries : loadRetiredIds();
  if (retiredEntries.length > 0) log(`Retired-id registry: ${retiredEntries.length} entr${retiredEntries.length === 1 ? 'y' : 'ies'}.`);

  log('Re-fetching venue pages for confirmation...');
  const fetchOpts = { limit, timeBudget, log, listingPages: io.listingPages };
  if (io.fetchPage) fetchOpts.fetchPage = io.fetchPage;
  const venueListings = await fetchVenueListings(candidates, fetchOpts);

  const { promoted, held, pruned } = await evaluateCandidates(candidates, {
    existingCandidates,
    existingIds,
    venueVocabulary,
    venueListings,
    retiredEntries,
    listingPages: io.listingPages,
    maxPromote,
    timeBudget,
    log,
    logEntry: logEntryFn,
    ...(io.now ? { now: io.now } : {}),
  });
  Object.assign(result, { promoted, held, pruned });
  const rejected = pruned.filter(p => p.kind !== 'promote');

  log('');
  log(`Promotion summary: ${promoted.length} promote / ${rejected.length} drop from staging / ${held.length} hold (of ${candidates.length} staged).`);
  if (promoted.length > 0) {
    log('Promoting:');
    for (const p of promoted) log(`  + [${p.candidate.source || 'unknown'}] ${p.entry.id} (${p.entry.status}; ${p.confirmationReason})`);
  }
  if (rejected.length > 0) {
    log('Dropping from staging:');
    for (const r of rejected.slice(0, 40)) log(`  - [${r.kind}] ${r.candidate.title} (${r.candidate.venue || 'no venue'}): ${r.reason}`);
    if (rejected.length > 40) log(`  ... +${rejected.length - 40} more`);
  }
  if (held.length > 0) {
    log('Holding in staging:');
    for (const h of held.slice(0, 20)) log(`  ~ [${h.kind}] ${h.candidate.title} (${h.candidate.venue || 'no venue'}): ${h.reason}`);
    if (held.length > 20) log(`  ... +${held.length - 20} more`);
  }

  if (dryRun) {
    log('');
    log(`(dry-run: no writes — ${showsGuard.suppressedWrites.length} shows.json write(s) suppressed, staging and audit log untouched)`);
    return result;
  }

  const rejectedRows = rejected.map(r => ({ title: r.candidate.title, venue: r.candidate.venue, source: r.candidate.source, sourceUrl: null, kind: r.kind, reason: r.reason }));
  const prunedHashes = new Set(pruned.map(p => p.candidate.candidateHash).filter(Boolean));
  const rewriteStaging = () => {
    const next = updateStaging((current) => current.filter((c) => !prunedHashes.has(c.candidateHash)), stagingPath);
    log(`Staging file: ${next.length} candidate(s) remain (${prunedHashes.size} removed).`);
  };

  if (promoted.length === 0) {
    writeLastPromotionFile([], rejectedRows, lastPromotionFile);
    log('Nothing to promote; shows.json unchanged.');
    // Persistent refusals still leave staging on a zero-promotion run, or
    // stale entries linger forever (the OB promoter's QA 2026-07-08 lesson).
    if (prunedHashes.size > 0) rewriteStaging();
    return result;
  }

  for (const p of promoted) showsData.shows.push(p.entry);
  try {
    const r = showsGuard.saveShows(showsData, { reason: `promote-owe-venue-candidates: ${promoted.length} venue-page promotion(s)` });
    log(`Wrote shows.json: ${r.lineCountBefore} → ${r.lineCountAfter} lines.`);
  } catch (e) {
    if (e instanceof AtomicWriteShrinkError) {
      console.error(`::error::${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  // Only after the shows.json write landed: the audit `promote` lines, the
  // state file the workflow summarises, and the staging prune — written
  // before, a shrink-gate abort would leave all three claiming promotions
  // that never happened.
  for (const p of promoted) {
    logEntryFn({ kind: 'promote', title: p.candidate.title, venue: p.candidate.venue, id: p.entry.id, status: p.entry.status, source: p.candidate.source, sourceUrl: p.sourceUrl });
  }
  writeLastPromotionFile(promoted, rejectedRows, lastPromotionFile);
  rewriteStaging();
  return result;
}

if (require.main === module) {
  let failed = false;
  main()
    .catch(err => {
      console.error('Fatal error:', err);
      failed = true;
    })
    .finally(async () => {
      // fetchPage() may have opened a Playwright browser on the fallback
      // tier — release it (scripts/lib/scraper.js cleanup) so the process
      // exits instead of hanging on a dangling handle (task #438 class).
      try { await require('./lib/scraper').cleanup(); } catch (e) { console.error(e); }
      process.exit(failed ? 1 : 0);
    });
}

module.exports = {
  decideOffWestEndVenuePromotion,
  buildOffWestEndVenueShowEntry,
  collectCandidates,
  fetchVenueListing,
  fetchVenueListings,
  findVenueListingPage,
  evaluateCandidates,
  main,
  MAX_PROMOTE_PER_RUN,
  DEFAULT_FETCH_LIMIT,
  LAST_PROMOTION_FILE,
  PROMOTION_LOG,
};
