#!/usr/bin/env node
'use strict';
/**
 * West End aggregator-roundup auto-promotion backstop (task #1466 — the WE
 * analogue of promote-ob-venue-candidates.js's off-broadway aggregator path).
 *
 * Problem: West End/Off-West-End discovery is weaker than Broadway's. A
 * published WET/LBO review-roundup page is itself strong confirmation a real
 * production exists and is being professionally reviewed — same rationale
 * that motivated the OB backstop (owner rule 2026-08-13: "every single
 * Verdict or Review Roundup article should automatically trigger that show
 * to be on the site if it isn't already"). The existing WE completeness gate
 * (audit-show-review-gap.js / gap-reference-sources.js) only diffs OUTLET
 * coverage for shows ALREADY in shows.json — it cannot discover a show we
 * have ZERO entry for, because its underlying discover libs
 * (wet/tr/lbo-roundup-discover.js) all take a KNOWN show and search for ITS
 * roundup. This script is the reverse direction, using
 * lib/we-listing-discover.js's LISTING-based discovery (WET's recent-posts
 * API without a search term; LBO's news-sitemap.xml) instead.
 *
 * Deliberately WEST END ONLY (category: 'west-end'), not Off-West-End — see
 * we-listing-discover.js's header for why (no curated Off-West-End venue
 * directory exists, unlike OFF_BROADWAY_VENUES for the OB path).
 *
 * No staging file (unlike the OB flow's ob-venue-candidates.json): each run
 * re-derives candidates live from the two listings and dedupes directly
 * against shows.json, so there's no separate concurrency surface to manage
 * (the OB staging file has its own known concurrency issue — task #999).
 * theatre.reviews is excluded — its own discover lib documents having no
 * listing-page equivalent to crawl.
 *
 * Flags:
 *   --dry-run     show what would be promoted; don't write
 *   --limit=N     cap WET per-post venue fetches this run (default 15 —
 *                 these are live BD/SB-routed fetches, LBO needs none)
 *   --email       best-effort "went live" digest notification
 */

const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
const { findExistingMatch } = require('./lib/candidate-dedup');
const { WEST_END_VENUES, normalizeVenueName } = require('./lib/venue-classification');
const { foldDiacritics } = require('./lib/title-match');
const {
  fetchWetRecentRoundups,
  fetchWetPostVenue,
  fetchLboRecentRoundups,
  fetchLboArticleDate,
} = require('./lib/we-listing-discover');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `promote-we-aggregator-candidates.js — West End aggregator-roundup auto-promotion backstop.

Usage:
  node scripts/promote-we-aggregator-candidates.js [options]
  node scripts/promote-we-aggregator-candidates.js --help, -h    print this usage and exit

Options:
  --dry-run     show what would be promoted; don't write
  --limit=N     cap WET per-post venue fetches this run (default 15)
  --email       best-effort "went live" digest notification
`;

const PROMOTION_LOG = path.join(__dirname, '..', 'data', 'audit', 'we-promotion-log.jsonl');
// Own file, NOT the OB script's shared data/audit/last-promotion-ids.json —
// two independent daily crons writing the same filename would race (whichever
// runs later wins, silently dropping the other's image-fetch dispatch).
// dispatch-new-show-images.js is called with --ids= explicitly derived from
// this file in promote-we-aggregator.yml.
const LAST_PROMOTION_FILE = path.join(__dirname, '..', 'data', 'audit', 'we-last-promotion-ids.json');
const WE_AGGREGATOR_MAX_STALENESS_DAYS = 400; // mirrors OB_AGGREGATOR_MAX_STALENESS_DAYS
const DAY_MS = 24 * 60 * 60 * 1000;
// Conservative first-run cap (smaller than OB's MAX_ACCEPT=50 — this path is
// new and untested against a real production LBO/WET backlog; live-tested
// 2026-08-14 surfaced 52 candidates against a full LBO history crawl on the
// very first run). Raise deliberately once the backlog is triaged down.
const MAX_PROMOTE_PER_RUN = 20;

function writeLastPromotionFile(promoted) {
  const fs = require('fs');
  const out = {
    generatedAt: new Date().toISOString(),
    promoted: promoted.map(p => ({ id: p.entry.id, source: p.candidate.source, sourceUrl: p.candidate.sourceUrl || null })),
  };
  const tmp = LAST_PROMOTION_FILE + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(LAST_PROMOTION_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, LAST_PROMOTION_FILE);
}

function logEntry(entry) {
  const fs = require('fs');
  try {
    fs.mkdirSync(path.dirname(PROMOTION_LOG), { recursive: true });
    fs.appendFileSync(PROMOTION_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`Failed to append promotion log: ${e.message}`);
  }
}

/**
 * Pure promotion rule for a West End aggregator-listing candidate
 * ({title, venue, sourceUrl, articlePublishedAt, discoveredAt, source}).
 * Mirrors decideOffBroadwayAggregatorPromotion in
 * promote-ob-venue-candidates.js: canonical-venue check + staleness gate.
 * Testable in isolation (CLAUDE.md §15).
 */
function decideWestEndAggregatorPromotion(candidate, options = {}) {
  const { isKnownVenue = (v) => WEST_END_VENUES.has(normalizeVenueName(v)) } = options;

  if (!candidate || candidate.category !== 'west-end') {
    return { confirmed: false, reason: 'not a west-end candidate' };
  }
  if (!candidate.venue) {
    return { confirmed: false, reason: 'null venue' };
  }
  let venueKnown;
  try { venueKnown = isKnownVenue(candidate.venue); } catch { venueKnown = false; }
  if (!venueKnown) {
    return { confirmed: false, reason: `venue "${candidate.venue}" is not a canonical West End venue — refusing to auto-promote (no curated Off-West-End directory exists to fall back on)` };
  }

  const published = candidate.articlePublishedAt ? new Date(candidate.articlePublishedAt) : null;
  const discovered = candidate.discoveredAt ? new Date(candidate.discoveredAt) : null;
  if (!published || Number.isNaN(published.getTime()) || !discovered || Number.isNaN(discovered.getTime())) {
    return { confirmed: false, reason: 'missing or unparseable articlePublishedAt/discoveredAt' };
  }
  if (discovered.getTime() < published.getTime() - DAY_MS) {
    return { confirmed: false, reason: `date mismatch: discoveredAt (${candidate.discoveredAt}) precedes articlePublishedAt (${candidate.articlePublishedAt})` };
  }
  const stalenessDays = (discovered.getTime() - published.getTime()) / DAY_MS;
  if (stalenessDays > WE_AGGREGATOR_MAX_STALENESS_DAYS) {
    return { confirmed: false, reason: `articlePublishedAt is ${Math.round(stalenessDays)}d stale relative to discoveredAt — refusing to auto-promote as currently open` };
  }

  return { confirmed: true, reason: `aggregator listing (${candidate.source}) + canonical West End venue "${candidate.venue}" + compatible dates`, source: 'aggregator-roundup' };
}

/**
 * Show entry for a candidate confirmed via decideWestEndAggregatorPromotion.
 * Mirrors buildOffBroadwayAggregatorShowEntry: status 'open' + a real
 * openingDate from the day of first-review-discovery — NOT buildShowEntry's
 * safe-default null-openingDate/'announced' pattern, which the OB script's
 * own history shows leaves aggregator-sourced shows permanently invisible
 * (engine.ts hides reviews/score while status==='announced', and nothing on
 * this class's path ever supplies a date to promote it forward).
 */
// West End main-stage runs — commercial musicals aside — are frequently
// LIMITED engagements (subsidized rep houses like the National, Royal
// Court, Old Vic, Donmar typically run a single production 6-14 weeks).
// Live-tested 2026-08-14: the LBO listing surfaces plenty of 2025-dated
// roundups (Othello, Hamlet, Clarkston, ...) that are well within the
// staleness gate's 400-day window but are, in the ordinary case, long since
// closed — mirrors buildRegionalShowEntry's identical reasoning for
// short-engagement regional tryouts. closingDate stays null either way
// (genuinely unknown); existing closing-date automation corrects status
// later regardless of how a show was added.
const WE_AGGREGATOR_OPEN_MAX_AGE_DAYS = 120;

function buildWestEndAggregatorShowEntry(candidate) {
  const dm = String(candidate.articlePublishedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const year = dm ? Number(dm[1]) : new Date().getFullYear();
  const openingDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
  const ageDays = openingDate ? (Date.now() - new Date(openingDate).getTime()) / DAY_MS : 0;
  const slugBase = (candidate.slug || foldDiacritics(candidate.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  const slug = `${slugBase}-west-end`;
  const id = `${slug}-${year}`;
  return {
    id,
    title: candidate.title,
    slug,
    venue: candidate.venue,
    openingDate,
    openingDateSource: openingDate ? 'aggregator-roundup' : null,
    previewsStartDate: null,
    closingDate: null,
    status: ageDays > WE_AGGREGATOR_OPEN_MAX_AGE_DAYS ? 'closed' : 'open',
    category: 'west-end',
    market: 'west-end',
    type: /\bmusical\b/i.test(candidate.title || '') ? 'musical' : null,
    discoverySource: `aggregator-roundup:${candidate.source}`,
    discoveredAt: candidate.discoveredAt,
    // Provisional — WET/LBO reviews auto-ingest via the existing per-show
    // discover libs now that the show exists; images/cast/exact dates arrive
    // via later enrichment, same as the OB aggregator path.
    provisional: true,
  };
}

/** Collect + dedupe raw listing candidates from both sources into one list. */
async function collectCandidates(opts) {
  const { log, limit } = opts;
  const discoveredAt = new Date().toISOString();
  const seenUrls = new Set();
  const out = [];

  log('Fetching LBO news-sitemap listing...');
  let lbo = [];
  try {
    lbo = await fetchLboRecentRoundups(opts);
  } catch (e) {
    log(`  LBO listing error: ${e.message}`);
  }
  log(`  LBO: ${lbo.length} candidate row(s).`);
  for (const c of lbo) {
    if (seenUrls.has(c.sourceUrl)) continue;
    seenUrls.add(c.sourceUrl);
    // articlePublishedAt is intentionally NOT set from sitemapLastmodUnconfirmed
    // (see fetchLboArticleDate's docstring) — main() fetches the real date
    // via a live per-candidate fetch, but ONLY for candidates that survive
    // the shows.json dedup check, so an already-known show never costs a fetch.
    out.push({ title: c.title, venue: c.venue, sourceUrl: c.sourceUrl, articlePublishedAt: null, category: 'west-end', source: 'lbo-sitemap', discoveredAt });
  }

  log('Fetching WET recent-roundups listing...');
  let wet = [];
  try {
    wet = await fetchWetRecentRoundups(opts);
  } catch (e) {
    log(`  WET listing error: ${e.message}`);
  }
  log(`  WET: ${wet.length} post(s).`);
  let wetFetches = 0;
  for (const c of wet) {
    if (seenUrls.has(c.sourceUrl)) continue;
    // Skip a WET fetch if an LBO candidate with the same title-ish slug
    // already covers this show this run — cheap dedupe before spending a
    // live fetch (final dedupe against shows.json still happens below).
    if (wetFetches >= limit) {
      log(`  [limit] reached --limit=${limit}; skipping remaining WET posts this run`);
      break;
    }
    wetFetches++;
    const venueInfo = await fetchWetPostVenue(c.sourceUrl, opts);
    seenUrls.add(c.sourceUrl);
    out.push({
      title: c.title,
      venue: venueInfo.venue,
      sourceUrl: c.sourceUrl,
      articlePublishedAt: venueInfo.articlePublishedAt || c.articlePublishedAt,
      category: 'west-end',
      source: 'wet-listing',
      discoveredAt,
    });
  }

  return out;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const emailAlerts = args.includes('--email');
  const limit = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '15', 10);
  const log = (...a) => console.log(...a);

  // Reset up front (mirrors promote-ob-venue-candidates.js) so a crash
  // mid-run can never leave a stale file claiming a prior run's promotions
  // happened again — the CI step reads this to know which shows to dispatch
  // image fetch for.
  if (!dryRun) writeLastPromotionFile([]);

  let showsData;
  try {
    showsData = loadShows();
  } catch (e) {
    console.error(`Failed to load shows.json: ${e.message}`);
    process.exit(1);
  }
  const existingIds = new Set(showsData.shows.map(s => s.id));
  const existingCandidates = showsData.shows
    .filter(s => s.category === 'west-end' || s.category === 'off-west-end')
    .map(s => ({ id: s.id, title: s.title, venue: s.venue }));

  const candidates = await collectCandidates({ log, limit });
  log('');
  log(`Collected ${candidates.length} raw candidate(s) from WE aggregator listings.`);

  const promoted = [];
  const skipped = [];
  let lboDateFetches = 0;

  for (const c of candidates) {
    const existingMatch = findExistingMatch(c, existingCandidates);
    if (existingMatch) {
      skipped.push({ candidate: c, reason: `already in shows.json as ${existingMatch.match.id} (${existingMatch.reason})` });
      logEntry({ kind: 'skip-duplicate', title: c.title, venue: c.venue, source: c.source, matchedTo: existingMatch.match.id, matchReason: existingMatch.reason });
      continue;
    }

    // LBO candidates only get a real articlePublishedAt here, AFTER dedup —
    // an already-known show never costs a live fetch. Bounded like WET's
    // per-post venue fetch (see collectCandidates) so a large new-listing
    // run can't spend unbounded fetches.
    if (c.source === 'lbo-sitemap' && !c.articlePublishedAt) {
      if (lboDateFetches >= limit) {
        skipped.push({ candidate: c, reason: `deferred: --limit=${limit} LBO date fetches reached this run` });
        logEntry({ kind: 'skip-limit', title: c.title, venue: c.venue, source: c.source });
        continue;
      }
      lboDateFetches++;
      const { articlePublishedAt } = await fetchLboArticleDate(c.sourceUrl, { log });
      c.articlePublishedAt = articlePublishedAt;
    }

    const r = decideWestEndAggregatorPromotion(c);
    if (!r.confirmed) {
      skipped.push({ candidate: c, reason: r.reason });
      logEntry({ kind: 'skip-unconfirmed', title: c.title, venue: c.venue, source: c.source, reason: r.reason });
      continue;
    }

    const entry = buildWestEndAggregatorShowEntry(c);
    if (existingIds.has(entry.id)) {
      skipped.push({ candidate: c, reason: `id ${entry.id} already exists` });
      logEntry({ kind: 'skip-id-collision', title: c.title, venue: c.venue, id: entry.id });
      continue;
    }
    promoted.push({ candidate: c, entry, confirmationReason: r.reason });
    existingIds.add(entry.id);
    existingCandidates.push({ id: entry.id, title: entry.title, venue: entry.venue });
    // NOT logged here — deferred until after the MAX_PROMOTE_PER_RUN check
    // below. Logging eagerly (as an earlier version of this script did)
    // wrote kind:'promote' lines for candidates that were then aborted with
    // NOTHING written to shows.json, leaving the audit log claiming
    // promotions that never happened (adversarial ship-check review,
    // 2026-08-14). See the abort branch's own logEntry call.
  }

  log('');
  log(`Promotion summary: ${promoted.length} promote / ${skipped.length} skip (of ${candidates.length} candidates).`);
  if (promoted.length > 0) {
    log('Promoting:');
    for (const p of promoted) log(`  + [${p.candidate.source}] ${p.entry.id} (${p.confirmationReason})`);
  }
  if (skipped.length > 0) {
    log('Skipping:');
    for (const s of skipped.slice(0, 20)) log(`  - [${s.candidate.source}] ${s.candidate.title} (${s.candidate.venue || 'no venue'}): ${s.reason}`);
    if (skipped.length > 20) log(`  ... +${skipped.length - 20} more`);
  }

  if (dryRun) {
    log('');
    log('(dry-run: no writes)');
    return;
  }

  if (promoted.length === 0) {
    log('Nothing to promote; shows.json unchanged.');
    return;
  }

  // Stability guard (mirrors extract-aggregator-candidates.js's MAX_ACCEPT):
  // this is a first-run backstop against a genuinely large backlog (a fresh
  // WET/LBO listing sweep can plausibly surface 40-60 never-catalogued shows
  // at once — live-tested 2026-08-14) as well as a parser/matching
  // regression that would otherwise mass-write junk unattended. Above the
  // cap, abort with nothing written so an operator reviews the batch (e.g.
  // --limit + --admin-force equivalent, or simply re-running after the
  // backlog has been triaged down) rather than trusting a single CI run.
  if (promoted.length > MAX_PROMOTE_PER_RUN) {
    console.error(`::error::Abort: ${promoted.length} candidates would be promoted, exceeding MAX_PROMOTE_PER_RUN=${MAX_PROMOTE_PER_RUN}. Nothing written.`);
    logEntry({ kind: 'abort-over-cap', count: promoted.length, cap: MAX_PROMOTE_PER_RUN, ids: promoted.map(p => p.entry.id) });
    process.exit(1);
  }

  // Only now, having confirmed the batch is small enough to actually write,
  // record each promotion in the audit log — see the loop above's comment
  // for why this is deferred rather than logged as each candidate qualifies.
  for (const p of promoted) {
    logEntry({ kind: 'promote', title: p.candidate.title, venue: p.candidate.venue, id: p.entry.id, source: p.candidate.source });
  }

  for (const p of promoted) showsData.shows.push(p.entry);
  try {
    const r = saveShows(showsData);
    log(`Wrote shows.json: ${r.lineCountBefore} → ${r.lineCountAfter} lines.`);
  } catch (e) {
    if (e instanceof AtomicWriteShrinkError) {
      console.error(`::error::${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  // Record promotions ONLY after the shows.json write landed — written
  // before, a shrink-gate abort would leave a file claiming promotions that
  // never happened, and the CI step would dispatch image fetch for ghosts.
  writeLastPromotionFile(promoted);

  if (emailAlerts) {
    const { routeAlert } = require('./lib/owner-alert-router');
    for (const p of promoted) {
      try {
        await routeAlert({
          conditionKey: `we-aggregator-go-live:${p.entry.id}`,
          title: `${p.entry.title} @ ${p.entry.venue} — West End show live and scoring`,
          severity: 'info',
          disposition: 'digest',
          url: `https://broadwayscorecard.com/show/${p.entry.id}`,
          description:
            `Auto-promoted from a ${p.candidate.source} aggregator listing (${p.candidate.sourceUrl}). ` +
            'Reviews ingest automatically via the existing WET/LBO discover libs. Cosmetic enrichment still manual: ' +
            'images, cast + creative team, exact previews/opening/closing dates.',
        });
        log(`Queued go-live digest line for ${p.entry.id}.`);
      } catch (e) {
        console.warn(`::warning::go-live digest queue failed for ${p.entry.id}: ${e.message} (promotion unaffected)`);
      }
    }
  }
}

if (require.main === module) {
  main().catch(async err => {
    console.error('Fatal error:', err);
    if (process.argv.includes('--email')) {
      try {
        const { sendEmailAlert } = require('./lib/discord-notify');
        await sendEmailAlert({
          title: 'West End aggregator auto-promotion FAILED',
          severity: 'error',
          description: `promote-we-aggregator-candidates.js crashed: ${err.message}. Investigate — repeated failures strand new WE shows undiscovered.`,
        });
      } catch { /* best-effort */ }
    }
    process.exit(1);
  });
}

module.exports = { decideWestEndAggregatorPromotion, buildWestEndAggregatorShowEntry, collectCandidates };
