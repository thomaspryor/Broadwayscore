#!/usr/bin/env node
'use strict';
// venue-write-guard-ok: the log/rejection/summary objects and the dedup pool copy candidate or existing-row venues for reporting only; the one shows.json write goes through buildWestEndAggregatorShowEntry + the shows write guard, unchanged by S4-T9/T10.
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

const { showTypeFor } = require('./lib/title-says-musical');
const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
const { findExistingMatch } = require('./lib/candidate-dedup');
const { WEST_END_VENUES, normalizeVenueName, sanitizeVenueForWrite } = require('./lib/venue-classification');
const { foldDiacritics } = require('./lib/title-match');
const { withMarketSuffix } = require('./lib/market-slug');
const {
  fetchWetRecentRoundups,
  fetchWetPostVenue,
  fetchLboRecentRoundups,
  fetchLboArticleDate,
} = require('./lib/we-listing-discover');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { normalizeShowTitle, buildVenueVocabulary } = require('./lib/show-title-normalize');
const {
  loadRejectedCandidates,
  priorRejection,
  recordRejection,
  writeRejectedCandidates,
  REJECTED_FILE,
} = require('./lib/we-rejected-candidates');

const USAGE = `promote-we-aggregator-candidates.js — West End aggregator-roundup auto-promotion backstop.

Usage:
  node scripts/promote-we-aggregator-candidates.js [options]
  node scripts/promote-we-aggregator-candidates.js --help, -h    print this usage and exit

Options:
  --dry-run     show what would be promoted; don't write
  --limit=N     cap WET per-post venue fetches this run (default 15)
  --email       best-effort "went live" digest notification
  --time-budget-min=N  wall-clock budget in minutes (0/omitted = unlimited)
`;

const PROMOTION_LOG = path.join(__dirname, '..', 'data', 'audit', 'we-promotion-log.jsonl');
// Own file, NOT the OB script's shared data/audit/last-promotion-ids.json —
// two independent daily crons writing the same filename would race (whichever
// runs later wins, silently dropping the other's image-fetch dispatch).
// dispatch-new-show-images.js is called with --ids= explicitly derived from
// this file in promote-we-aggregator.yml.
const LAST_PROMOTION_FILE = path.join(__dirname, '..', 'data', 'audit', 'we-last-promotion-ids.json');
const WE_AGGREGATOR_MAX_STALENESS_DAYS = 400; // mirrors OB_AGGREGATOR_MAX_STALENESS_DAYS
// Roundups older than this are treated as closed runs and refused (BRO-4883);
// see decideWestEndAggregatorPromotion.
const WE_AGGREGATOR_OPEN_MAX_AGE_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
// Conservative first-run cap (smaller than OB's MAX_ACCEPT=50 — this path is
// new and untested against a real production LBO/WET backlog; live-tested
// 2026-08-14 surfaced 52 candidates against a full LBO history crawl on the
// very first run). Raise deliberately once the backlog is triaged down.
const MAX_PROMOTE_PER_RUN = 20;

// `rejected` (BRO-4204 S4-T9/T10): the candidates THIS run rejected and
// remembered in data/audit/we-rejected-candidates.json, so the workflow's
// job-summary step can list them next to the promoted ids without parsing
// the jsonl log. Additive — the CI image-dispatch step reads only `.promoted`.
function writeLastPromotionFile(promoted, rejected = []) {
  const fs = require('fs');
  const out = {
    generatedAt: new Date().toISOString(),
    promoted: promoted.map(p => ({ id: p.entry.id, source: p.candidate.source, sourceUrl: p.candidate.sourceUrl || null })),
    rejected: rejected.map(r => ({ title: r.title, venue: r.venue, source: r.source, sourceUrl: r.sourceUrl || null, kind: r.kind, reason: r.reason })),
  };
  const tmp = LAST_PROMOTION_FILE + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(LAST_PROMOTION_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, LAST_PROMOTION_FILE);
}

function logEntry(entry) {
  // A --dry-run must not append to the tracked promotion log (BRO-4396: every
  // dry run left data/audit/*promotion-log.jsonl modified in the checkout).
  if (process.argv.includes('--dry-run')) return;
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

  // `persistent` (BRO-4204 S4-T9): is this refusal a property of the
  // candidate itself (same answer next run — worth remembering in
  // we-rejected-candidates.json so the next run skips it before spending a
  // fetch) or of THIS run's fetches (a null WET venue or a missing LBO date
  // usually means the page fetch failed; retry tomorrow, never remember)?
  if (!candidate || candidate.category !== 'west-end') {
    return { confirmed: false, persistent: true, reason: 'not a west-end candidate' };
  }
  if (!candidate.venue) {
    return { confirmed: false, persistent: false, reason: 'null venue' };
  }
  let venueKnown;
  try { venueKnown = isKnownVenue(candidate.venue); } catch { venueKnown = false; }
  if (!venueKnown) {
    return { confirmed: false, persistent: true, reason: `venue "${candidate.venue}" is not a canonical West End venue — refusing to auto-promote (no curated Off-West-End directory exists to fall back on)` };
  }

  const published = candidate.articlePublishedAt ? new Date(candidate.articlePublishedAt) : null;
  const discovered = candidate.discoveredAt ? new Date(candidate.discoveredAt) : null;
  if (!published || Number.isNaN(published.getTime()) || !discovered || Number.isNaN(discovered.getTime())) {
    return { confirmed: false, persistent: false, reason: 'missing or unparseable articlePublishedAt/discoveredAt' };
  }
  if (discovered.getTime() < published.getTime() - DAY_MS) {
    return { confirmed: false, persistent: true, reason: `date mismatch: discoveredAt (${candidate.discoveredAt}) precedes articlePublishedAt (${candidate.articlePublishedAt})` };
  }
  const stalenessDays = (discovered.getTime() - published.getTime()) / DAY_MS;
  if (stalenessDays > WE_AGGREGATOR_MAX_STALENESS_DAYS) {
    return { confirmed: false, persistent: true, reason: `articlePublishedAt is ${Math.round(stalenessDays)}d stale relative to discoveredAt — refusing to auto-promote as currently open` };
  }
  // BRO-4883: a roundup older than this is most likely a closed run, and this
  // path has no closing date to write — a closed row with a null closingDate
  // is never revisited (audit-we-closing-dates.js only scans open rows) and
  // fails validate-data.js. Closed seasons belong to the WE historical
  // pipeline (discover-historical-shows-we.js → promote-historical-we.js),
  // which carries real run dates plus its own genre and duplicate checks. On
  // 2026-10-08 this path wrote 10 closed dateless rows: 3 duplicates of
  // existing shows under truncated LBO slugs, 6 operas/ballets/one-night
  // concerts that pipeline had already rejected.
  if (stalenessDays > WE_AGGREGATOR_OPEN_MAX_AGE_DAYS) {
    return { confirmed: false, persistent: true, reason: `roundup is ${Math.round(stalenessDays)}d old (> ${WE_AGGREGATOR_OPEN_MAX_AGE_DAYS}d) — most likely a closed run with no known closing date; closed seasons are promoted by the WE historical pipeline` };
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
// short-engagement regional tryouts. Those older roundups are refused in
// decideWestEndAggregatorPromotion (BRO-4883: this builder used to write them
// as status 'closed' with a null closingDate), so every row built here is a
// current run and is written 'open'; audit-we-closing-dates.js then finds its
// real closing date like any other open West End show.

function buildWestEndAggregatorShowEntry(candidate, venueVocabulary) {
  const dm = String(candidate.articlePublishedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const year = dm ? Number(dm[1]) : new Date().getFullYear();
  const openingDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
  // withMarketSuffix() strips any pre-existing market suffix before re-appending —
  // idempotent. candidate.slug isn't guaranteed fresh from the raw title (it may
  // have round-tripped through another WE discovery path already carrying the
  // suffix); without this guard it doubles, producing IDs like
  // `beetlejuice-the-musical-west-end-west-end-2026` (BRO-3237).
  // BRO-3863 — normalise BEFORE the slug/id are derived from the title.
  // Aggregator listings disambiguate same-title productions by appending the
  // venue ("The Cherry Orchard (Park Avenue Armory)"); taken verbatim, that
  // suffix reaches the reader AND the row's slug and id. Same canonical
  // normaliser the validate-data.js gate and fix-show-titles.js use, so a row
  // written here can never fail the gate that guards it.
  const normalizedTitle = normalizeShowTitle({ title: candidate.title, venue: candidate.venue }, { venueVocabulary }).title;

  const slugBase = (candidate.slug || foldDiacritics(normalizedTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  const slug = withMarketSuffix(slugBase, 'west-end');
  const id = `${slug}-${year}`;
  return {
    id,
    title: normalizedTitle,
    slug,
    // Write-time placeholder/neighbourhood-blob guard (S0-T3, card #994) —
    // cousin of BRO-160's buildShowEntry fix (card #1921). Returns null on a
    // placeholder venue; main()'s `if (!entry.venue)` check refuses to
    // promote rather than write a garbage venue string.
    venue: sanitizeVenueForWrite(candidate.venue),
    openingDate,
    openingDateSource: openingDate ? 'aggregator-roundup' : null,
    previewsStartDate: null,
    closingDate: null,
    status: 'open',
    category: 'west-end',
    market: 'west-end',
    // 'play' (not null) when the title doesn't say "musical" — status is
    // 'open' here (a roundup already exists), and validate-market-
    // expansion.js's required-fields check only exempts type when
    // status==='announced'. A null type on a status='open' show fails CI
    // (BRO-3716: main red for 19.8h+ on exactly this). 'play' is also the
    // correct guess in the overwhelming majority of cases — plays outnumber
    // musicals ~2:1 in shows.json, and this heuristic already only fires
    // when "musical" is absent from the title.
    type: showTypeFor(candidate.title, candidate.listingGenre),
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
  const { log, limit, timeBudget } = opts;
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
    if (timeBudget && timeBudget.exceeded()) {
      log(`  ⏱ Time budget (${timeBudget.minutes} min) reached — skipping remaining WET posts this run`);
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

/**
 * Per-candidate evaluation loop — extracted from main() (BRO-4204 S4-T9,
 * CLAUDE.md §15) so the two batch-safety properties it now carries are
 * testable against the real code:
 *
 *   1. A candidate remembered in data/audit/we-rejected-candidates.json
 *      (see lib/we-rejected-candidates.js) is skipped BEFORE it costs an LBO
 *      date fetch, so known-bad candidates can no longer eat the --limit
 *      budget every run and defer the genuinely new ones forever.
 *   2. Each candidate is evaluated inside its own try/catch. A throw is
 *      recorded as a `candidate-error` rejection and the loop CONTINUES —
 *      previously it unwound main() with nothing written and every other
 *      candidate in the batch lost with it.
 *
 * Only refusals that are properties of the candidate itself are remembered
 * (decideWestEndAggregatorPromotion's `persistent` flag, a shouted title, a
 * sanitize-rejected venue, an id collision, a throw). A null WET venue or a
 * missing LBO date usually means THIS run's page fetch failed — those retry
 * next run and are never persisted. Pass no `rejectedStore` to disable the
 * memory (the loop still never aborts on a throw).
 *
 * @param {Array<object>} candidates from collectCandidates()
 * @param {object} ctx
 * @param {Array<{id,title,venue,category}>} ctx.existingCandidates London-pool rows (mutated: promotions are appended)
 * @param {Set<string>} ctx.existingIds (mutated: promoted ids are added)
 * @param {object} ctx.venueVocabulary from buildVenueVocabulary()
 * @param {number} ctx.limit LBO date-fetch cap this run
 * @param {{exceeded(): boolean, minutes: number}} [ctx.timeBudget]
 * @param {Function} [ctx.log]
 * @param {object} [ctx.rejectedStore] from loadRejectedCandidates()
 * @param {Function} [ctx.fetchLboArticleDate] injectable for tests / offline runs
 * @param {Function} [ctx.fetchPage] passed through to the date fetch
 * @param {Function} [ctx.logEntry] injectable audit-log sink
 * @param {Function} [ctx.now] clock, for TTL tests
 * @returns {Promise<{promoted: Array, skipped: Array, rejectedThisRun: Array}>}
 */
async function evaluateCandidates(candidates, ctx) {
  const {
    existingCandidates,
    existingIds,
    venueVocabulary,
    limit,
    timeBudget = null,
    log = () => {},
    rejectedStore = null,
    fetchLboArticleDate: fetchDate = fetchLboArticleDate,
    fetchPage = undefined,
    logEntry: logEntryFn = logEntry,
    now = () => new Date(),
  } = ctx;
  const promoted = [];
  const skipped = [];
  const rejectedThisRun = [];
  let lboDateFetches = 0;

  const reject = (c, kind, reason, extra = {}) => {
    skipped.push({ candidate: c, reason });
    logEntryFn({ kind, title: c.title, venue: c.venue, source: c.source, reason, ...extra });
    if (rejectedStore) {
      recordRejection(rejectedStore, c, { kind, reason }, now());
      rejectedThisRun.push({ title: c.title, venue: c.venue, source: c.source, sourceUrl: c.sourceUrl || null, kind, reason });
    }
  };

  for (const c of candidates) {
    if (timeBudget && timeBudget.exceeded()) {
      log(`\n⏱ Time budget (${timeBudget.minutes} min) reached — remaining candidates deferred to next run.`);
      break;
    }
    try {
      const existingMatch = findExistingMatch(c, existingCandidates);
      if (existingMatch) {
        skipped.push({ candidate: c, reason: `already in shows.json as ${existingMatch.match.id} (${existingMatch.reason})` });
        logEntryFn({ kind: 'skip-duplicate', title: c.title, venue: c.venue, source: c.source, matchedTo: existingMatch.match.id, matchReason: existingMatch.reason });
        continue;
      }

      // Remembered rejection — checked AFTER dedup (a row that has since
      // been added by hand should log as the duplicate it now is) and BEFORE
      // the LBO date fetch (the whole point: no budget spent on it).
      const prior = rejectedStore ? priorRejection(rejectedStore, c, now()) : null;
      if (prior) {
        skipped.push({ candidate: c, reason: `previously rejected ${String(prior.lastSeen).slice(0, 10)} (${prior.kind}: ${prior.reason}) — held until ${String(prior.expiresAt).slice(0, 10)}` });
        logEntryFn({ kind: 'skip-prior-rejection', title: c.title, venue: c.venue, source: c.source, priorKind: prior.kind, firstSeen: prior.firstSeen, expiresAt: prior.expiresAt });
        continue;
      }

      // LBO candidates only get a real articlePublishedAt here, AFTER dedup —
      // an already-known show never costs a live fetch. Bounded like WET's
      // per-post venue fetch (see collectCandidates) so a large new-listing
      // run can't spend unbounded fetches.
      if (c.source === 'lbo-sitemap' && !c.articlePublishedAt) {
        if (lboDateFetches >= limit) {
          skipped.push({ candidate: c, reason: `deferred: --limit=${limit} LBO date fetches reached this run` });
          logEntryFn({ kind: 'skip-limit', title: c.title, venue: c.venue, source: c.source });
          continue;
        }
        lboDateFetches++;
        const { articlePublishedAt } = await fetchDate(c.sourceUrl, { log, fetchPage });
        c.articlePublishedAt = articlePublishedAt;
      }

      const r = decideWestEndAggregatorPromotion(c);
      if (!r.confirmed) {
        if (r.persistent) {
          reject(c, 'skip-unconfirmed', r.reason);
        } else {
          skipped.push({ candidate: c, reason: r.reason });
          logEntryFn({ kind: 'skip-unconfirmed', title: c.title, venue: c.venue, source: c.source, reason: r.reason });
        }
        continue;
      }

      // BRO-3920 — a shouted title is detection-only now (no more guessed
      // casing), so it must be held here rather than written: buildShowEntry
      // below writes candidate.title through unchanged, and validate-data.js's
      // gate would only catch it AFTER this run already committed it, failing
      // CI for the whole batch instead of holding the one bad candidate.
      const titleCheck = normalizeShowTitle({ title: c.title, venue: c.venue }, { venueVocabulary });
      if (titleCheck.manualReview) {
        reject(c, 'skip-shouted-title', 'shouted title — needs a human to check the source\'s structured metadata (scripts/lib/title-display-case.js)');
        continue;
      }

      const entry = buildWestEndAggregatorShowEntry(c, venueVocabulary);
      // sanitizeVenueForWrite (S0-T3, card #994) returns null for a
      // placeholder/neighbourhood-blob venue — refuse to write a garbage venue
      // string rather than silently promoting it (card #1921, cousin of
      // BRO-160). decideWestEndAggregatorPromotion already checked
      // c.venue against the canonical WEST_END_VENUES list above, so this
      // should be unreachable in practice — kept as defense in depth, same
      // pattern as the OB script's identical guard.
      if (!entry.venue) {
        reject(c, 'skip-invalid-venue', `venue "${c.venue}" failed sanitizeVenueForWrite (placeholder/neighbourhood blob)`);
        continue;
      }
      if (existingIds.has(entry.id)) {
        reject(c, 'skip-id-collision', `id ${entry.id} already exists`, { id: entry.id });
        continue;
      }
      promoted.push({ candidate: c, entry, confirmationReason: r.reason });
      existingIds.add(entry.id);
      existingCandidates.push({ id: entry.id, title: entry.title, venue: entry.venue, category: entry.category });
      // NOT logged here — deferred until after the MAX_PROMOTE_PER_RUN check
      // in main(). Logging eagerly (as an earlier version of this script did)
      // wrote kind:'promote' lines for candidates that were then aborted with
      // NOTHING written to shows.json, leaving the audit log claiming
      // promotions that never happened (adversarial ship-check review,
      // 2026-08-14). See the abort branch's own logEntry call.
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      reject(c, 'candidate-error', `threw during evaluation: ${msg}`);
      log(`  ::warning::candidate "${c.title}" (${c.venue || 'no venue'}) threw — recorded as rejected, batch continues: ${msg}`);
    }
  }

  return { promoted, skipped, rejectedThisRun };
}

/**
 * @param {string[]} [argv] CLI args (default process.argv)
 * @param {object} [io] injectable I/O for tests and offline runs:
 *   fetchPage / fetchJSON are passed through to lib/we-listing-discover.js's
 *   listing + per-page fetchers; log replaces console.log; logEntry replaces
 *   the jsonl audit-log append (a sandbox dry-run must not touch data/).
 * @returns {Promise<{promoted: Array, skipped: Array, rejectedThisRun: Array}|undefined>}
 */
async function main(argv = process.argv.slice(2), io = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = argv;
  const dryRun = args.includes('--dry-run');
  const emailAlerts = args.includes('--email');
  const limit = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '15', 10);
  const log = io.log || ((...a) => console.log(...a));
  const timeBudget = createRunBudget(parseTimeBudgetMin(args));
  const fetchOpts = {};
  if (io.fetchPage) fetchOpts.fetchPage = io.fetchPage;
  if (io.fetchJSON) fetchOpts.fetchJSON = io.fetchJSON;

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

  // BRO-3863 — the gate (validate-data.js) builds the corpus venue vocabulary
  // and this writer must too, or the two disagree: a "(Bridge)" suffix would
  // survive promotion here and then fail validation because some OTHER show's
  // venue is "Bridge". Writer/gate equivalence is the point of routing both
  // through normalizeShowTitle (adversarial review finding).
  const venueVocabulary = buildVenueVocabulary(showsData.shows);
  // `category` is carried so findExistingMatch's London-pool title fallback
  // (lib/candidate-dedup.js, BRO-4204 S4-T9) can apply — without it a venue-
  // string mismatch ("noel coward" vs "Noël Coward Theatre") minted a
  // same-title duplicate that validate-data then refused, batch and all.
  const existingCandidates = showsData.shows
    .filter(s => s.category === 'west-end' || s.category === 'off-west-end')
    .map(s => ({ id: s.id, title: s.title, venue: s.venue, category: s.category }));

  // Remembered rejections (lib/we-rejected-candidates.js). Read in dry-run
  // too so a dry-run reports what a real run would do; written only below,
  // and only on a real run.
  const rejectedStore = loadRejectedCandidates(REJECTED_FILE, { warn: (m) => log(`::warning::${m}`) });
  const priorCount = Object.keys(rejectedStore.rejected).length;
  if (priorCount > 0) log(`Loaded ${priorCount} remembered rejection(s) from ${path.relative(process.cwd(), REJECTED_FILE)}.`);

  const candidates = await collectCandidates({ log, limit, timeBudget, ...fetchOpts });
  log('');
  log(`Collected ${candidates.length} raw candidate(s) from WE aggregator listings.`);

  const { promoted, skipped, rejectedThisRun } = await evaluateCandidates(candidates, {
    existingCandidates,
    existingIds,
    venueVocabulary,
    limit,
    timeBudget,
    log,
    rejectedStore,
    fetchPage: io.fetchPage,
    ...(io.logEntry ? { logEntry: io.logEntry } : {}),
  });
  const result = { promoted, skipped, rejectedThisRun };

  log('');
  log(`Promotion summary: ${promoted.length} promote / ${skipped.length} skip (of ${candidates.length} candidates; ${rejectedThisRun.length} rejection(s) remembered for next run).`);
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
    return result;
  }

  // Persist remembered rejections regardless of whether anything promotes —
  // they are what keeps tomorrow's fetch budget for genuinely new candidates.
  // Written BEFORE the over-cap abort below for the same reason.
  const remembered = writeRejectedCandidates(rejectedStore);
  log(`Wrote ${remembered} remembered rejection(s) to ${path.relative(process.cwd(), REJECTED_FILE)}.`);

  if (promoted.length === 0) {
    writeLastPromotionFile([], rejectedThisRun);
    log('Nothing to promote; shows.json unchanged.');
    return result;
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
  writeLastPromotionFile(promoted, rejectedThisRun);

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
  return result;
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

module.exports = {
  decideWestEndAggregatorPromotion,
  buildWestEndAggregatorShowEntry,
  collectCandidates,
  evaluateCandidates,
  main,
  MAX_PROMOTE_PER_RUN,
};
