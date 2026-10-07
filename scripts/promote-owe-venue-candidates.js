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
 * Evidence-backed admin path (BRO-4204 S8-T3). The venue-page rule above
 * cannot admit the ~50 reviewed 2026 Off-West End productions the audit
 * found missing: most had CLOSED (no venue page lists them any more) and
 * many played venues outside VENUE_LISTING_PAGES (Arcola, King's Head,
 * Jermyn Street, Riverside, Wilton's, ...). A venue listing is not review
 * evidence, but a critic review IS — the owner's rule is "keep anything
 * that gets or might get reviewed" (docs/show-inclusion-policy.md). So a
 * staged candidate may carry
 *   evidence: [{ kind: 'review-url' | 'coverage-url', url, outletId? }]
 * and decideOffWestEndVenuePromotion confirms it — INSTEAD of the venue
 * page, which is never consulted for it — when at least one evidence URL's
 * host resolves to a registered outlet (lib/review-normalization.js
 * resolveOutletFromUrl over data/outlet-registry.json; a venue's own site
 * that happens to be registered as a defunct "outlet" does not count) AND
 * fetchPage() of that URL returns a page whose text names the candidate
 * title (pageTextContainsTitle: diacritics/punctuation-folded, whole-word).
 * 'review-url' is a critic review of the production (any run of it);
 * 'coverage-url' is a registered outlet's news/preview piece naming an
 * ANNOUNCED production — admitted under the "might get reviewed" half of
 * the rule, so the ~10 Q4-2026 productions the audit listed can be staged
 * before their press night. The S4-T6 gates still refuse first. A fetch
 * failure, an unfetched URL, or a fetched page that does not name the
 * title (paywall / interstitial / wrong URL) HOLDS — never prunes — a
 * hand-prepared candidate; only "no evidence URL resolves to a registered
 * outlet" is a persistent refusal. Rows built this way carry
 * discoverySource 'audit-review-evidence', provisional: true, evidenceUrls,
 * and the dates the candidate supplies (previewsStartDate / openingDate /
 * closingDate → status + type per buildOffWestEndVenueShowEntry; an
 * explicit `type` on the candidate is honoured).
 *
 * Candidates reach staging through --stage-file: a JSON array of hand-
 * prepared rows merged into data/audit/owe-venue-candidates.json by
 * lib/owe-venue-staging.js's locked upsert (writeStagingCandidates →
 * updateStaging, keyed by candidateHash) — never written directly. With
 * --dry-run the merge happens in memory only (mergeCandidates over the
 * current entries) so the evaluation still sees exactly the union a real
 * run would write. --stage-only merges and exits without evaluating, for a
 * coordinator that wants to commit the staging file and let the daily
 * workflow drain it.
 *
 * Flags:
 *   --dry-run            evaluate and report; write nothing (default: writes)
 *   --limit=N            cap venue-page fetches this run (default 20 — one per
 *                        distinct staged venue; there are ~12)
 *   --evidence-limit=N   cap evidence-URL fetches this run (default
 *                        DEFAULT_EVIDENCE_FETCH_LIMIT; one per distinct URL)
 *   --max-promote=N      cap rows written this run (default MAX_PROMOTE_PER_RUN;
 *                        the remainder is HELD in staging for the next run,
 *                        not aborted — every row here was confirmed against
 *                        the venue's own page, and the first run drains a
 *                        real 100-candidate backlog)
 *   --stage-file=<json>  merge a JSON array of hand-prepared candidates into
 *                        staging (in memory under --dry-run) before evaluating
 *   --stage-only         with --stage-file: merge and exit (no fetches)
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
const { normalizeTitle, foldDiacritics, titleTokens } = require('./lib/title-match');
const { urlFragmentReason } = require('./lib/url-fragment-title');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { loadStaging, updateStaging, mergeCandidates, writeStagingCandidates, STAGING_PATH } = require('./lib/owe-venue-staging');
const { resolveOutletFromUrl, loadOutletRegistry } = require('./lib/review-normalization');
const { stripHtml } = require('./lib/article-extractor');
const { showTypeFor, knownShowType } = require('./lib/title-says-musical');
const { decideVenueListingPromotion } = require('./lib/ob-cross-validation');
const { OWE_VENUE_CONFIGS } = require('./lib/venue-listing-discover');

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
  --evidence-limit=N   cap evidence-URL fetches this run (default 60)
  --max-promote=N      cap rows written this run; the rest stay staged (default 25)
  --stage-file=<json>  merge a JSON array of hand-prepared candidates (title, venue,
                       dates, evidence: [{kind:'review-url'|'coverage-url', url}]) into
                       data/audit/owe-venue-candidates.json before evaluating; with
                       --dry-run the merge is in memory only
  --stage-only         with --stage-file: merge into staging and exit (no fetches)
  --time-budget-min=N  wall-clock budget in minutes (0/omitted = unlimited)
`;

const PROMOTION_LOG = path.join(__dirname, '..', 'data', 'audit', 'owe-promotion-log.jsonl');
// Own state file — NOT the WE promoter's we-last-promotion-ids.json nor the
// OB script's last-promotion-ids.json: two crons writing one filename race,
// and promote-owe-venue-candidates.yml's job-summary step reads THIS one.
const LAST_PROMOTION_FILE = path.join(__dirname, '..', 'data', 'audit', 'owe-last-promotion-ids.json');
const MAX_PROMOTE_PER_RUN = 25;
const DEFAULT_FETCH_LIMIT = 20;
const DEFAULT_EVIDENCE_FETCH_LIMIT = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
// S8-T3 evidence path (see the header). 'review-url' = a critic review of
// the production; 'coverage-url' = a registered outlet's news/preview
// naming an announced production. Both are checked the same way.
const EVIDENCE_KINDS = new Set(['review-url', 'coverage-url']);
const AUDIT_EVIDENCE_SOURCE = 'audit-review-evidence';
// The `type` values shows.json rows carry (validate-market-expansion.js
// requires one on every non-announced row); an explicit candidate.type
// outside this set falls back to the title heuristic.
const VALID_SHOW_TYPES = new Set(['play', 'musical', 'opera', 'special']);

/**
 * The usable evidence entries on a staged candidate: `{kind, url}` objects
 * whose kind is one of EVIDENCE_KINDS and whose url parses as http(s).
 * Anything else (a bare string, an unknown kind, a mailto:) is ignored, so
 * a malformed entry can neither confirm nor refuse a candidate.
 */
function reviewEvidence(candidate) {
  const raw = candidate && Array.isArray(candidate.evidence) ? candidate.evidence : [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || !EVIDENCE_KINDS.has(e.kind) || typeof e.url !== 'string') continue;
    let parsed;
    try { parsed = new URL(e.url); } catch { continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    out.push({ kind: e.kind, url: e.url, outletId: typeof e.outletId === 'string' ? e.outletId : null });
  }
  return out;
}

/**
 * Which registered outlet an evidence URL's host belongs to, per
 * lib/review-normalization.js's resolveOutletFromUrl (the canonical domain
 * index with its collision rules) — or why it is not review evidence.
 * A registry entry whose accessModel is 'defunct' is refused: the London
 * "outlets" in that state are venues' own sites (almeida.co.uk,
 * oldvictheatre.com) registered years ago as pseudo-outlets, and a venue
 * page is exactly what this path must not accept as evidence.
 *
 * @returns {{outletId: string|null, tier: number|null, reason: string|null}}
 */
function resolveEvidenceOutlet(url, registry) {
  const resolved = resolveOutletFromUrl(url);
  const outletId = resolved && resolved.outletId ? String(resolved.outletId) : null;
  if (!outletId) return { outletId: null, tier: null, reason: 'host is not a registered outlet (data/outlet-registry.json)' };
  const reg = registry && registry.outlets ? registry.outlets : null;
  const entry = reg ? reg[outletId] : null;
  if (reg && !entry) return { outletId: null, tier: null, reason: `host resolves to "${outletId}", which is not in the registry` };
  if (entry && entry.accessModel === 'defunct') {
    return { outletId: null, tier: null, reason: `host resolves to "${outletId}", a defunct registry entry (a venue's own site is not review evidence)` };
  }
  return { outletId, tier: entry && entry.tier ? entry.tier : 3, reason: null };
}

/**
 * Text fold for the title-in-page check: the character handling of
 * title-match.js's normalizeTitle (diacritics, case, "&" → "and", joiners
 * dropped, separators → space) WITHOUT its leading-"the" strip and trailing
 * "musical" strip — applied to the needle those would turn "The Name" into
 * "name", which matches every English page; the haystack is a whole page.
 */
function foldText(s) {
  return foldDiacritics(String(s || ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['‘’"“”\-–—]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does a fetched page name the candidate title? Whole-phrase, folded on
 * both sides (foldText), over the page's visible text (article-extractor's
 * stripHtml drops scripts/styles/asides). A title that folds to nothing
 * never matches.
 */
function pageTextContainsTitle(htmlOrText, title) {
  const needle = foldText(title);
  if (!needle) return false;
  const hay = foldText(stripHtml(String(htmlOrText || '')));
  return (' ' + hay + ' ').includes(' ' + needle + ' ');
}

/**
 * The evidence half of decideOffWestEndVenuePromotion (called after the
 * S4-T6 gates, only for candidates that carry usable evidence). Walks the
 * evidence in order and confirms on the FIRST URL whose host is a
 * registered outlet and whose fetched text names the title. Everything
 * short of that is reported; the refusal is persistent only when NO
 * evidence URL resolves to a registered outlet (a property of the
 * candidate) — a fetch failure, an unfetched URL (--evidence-limit / time
 * budget) or a page that does not name the title holds the candidate for
 * the next run, so a paywall or a scraper block can never prune a hand-
 * prepared row.
 *
 * @param {object} candidate
 * @param {Array<{kind: string, url: string}>} evidence from reviewEvidence()
 * @param {Map<string, {text: string|null, error: string|null}>} evidencePages keyed by url
 * @param {object|null} registry loaded outlet-registry.json
 */
function decideByReviewEvidence(candidate, evidence, evidencePages, registry) {
  const problems = [];
  let registered = 0;
  for (const ev of evidence) {
    const outlet = resolveEvidenceOutlet(ev.url, registry);
    if (!outlet.outletId) { problems.push(`${ev.url}: ${outlet.reason}`); continue; }
    registered++;
    const page = evidencePages.get(ev.url);
    if (!page) { problems.push(`${ev.url}: not fetched this run (--evidence-limit / time budget)`); continue; }
    if (page.error || typeof page.text !== 'string' || !page.text) { problems.push(`${ev.url}: fetch failed (${page.error || 'empty response'})`); continue; }
    if (!pageTextContainsTitle(page.text, candidate.title)) {
      problems.push(`${ev.url}: fetched, but the page text does not name "${candidate.title}" (paywall / interstitial / wrong URL?)`);
      continue;
    }
    return {
      confirmed: true,
      persistent: false,
      reason: `${ev.kind} ${ev.url} (registered outlet ${outlet.outletId}, T${outlet.tier}) names "${candidate.title}" on fetch`,
      source: ev.kind,
      page: ev.url,
      outletId: outlet.outletId,
    };
  }
  if (registered === 0) {
    return { confirmed: false, persistent: true, reason: `none of the ${evidence.length} evidence URL(s) resolves to a registered outlet — not review evidence; ${problems.join('; ')}` };
  }
  return { confirmed: false, persistent: false, reason: `evidence not confirmed this run — held: ${problems.join('; ')}` };
}

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
  // A --dry-run must not append to the tracked promotion log (BRO-4396: every
  // dry run left data/audit/*promotion-log.jsonl modified in the checkout).
  if (process.argv.includes('--dry-run')) return;
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

/** Title tokens without season years ("Berlin_2027" → {berlin}). */
function tokensWithoutYears(title) {
  return new Set([...titleTokens(String(title || '').replace(/_/g, ' '))].filter(t => !/^(?:19|20)\d\d$/.test(t)));
}

/** Same house: normalized venue equal, or one is the other plus a room ("Southwark Playhouse Elephant"). */
function sameLondonHouse(a, b) {
  const ka = normalizeVenueName(a);
  const kb = normalizeVenueName(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.startsWith(`${kb} `) || kb.startsWith(`${ka} `);
}

/** A catalog row's own run window, or null when it carries no dates. */
function rowWindow(e) {
  const first = validDateOrNull(e.previewsStartDate) || validDateOrNull(e.openingDate);
  const last = validDateOrNull(e.closingDate);
  if (!first && !last) return null;
  return { first: first || last, last: last || '9999-12-31' };
}

function shiftDay(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A catalog row at the same house that is this candidate's production
 * under a variant title (BRO-4398). Slug-title readers minted rows such as
 * "Twenty Thousand Streets" and "Berlin_2027" that the dated readers now see
 * as "Twenty Thousand Streets Under the Sky" and "BERLIN";
 * findExistingMatch's normalized-equal test misses both.
 *   - Equal word sets (season years and punctuation ignored): the same
 *     show, unless the row closed more than 180 days before this run starts
 *     (an earlier production).
 *   - One title's words contained in the other's (two words at least):
 *     only for a dated candidate, and only when the row is undated (a stub
 *     minted from a slug) or its own run overlaps this one within 30 days.
 *     "Private Lives" is not "Private Lives of the Royals" three months
 *     later, and "A Doll's House Part 2" is not last year's "A Doll's House".
 *
 * @param {object} candidate
 * @param {Array<{id, title, venue, previewsStartDate?, openingDate?, closingDate?}>} pool
 * @returns {{match: object, reason: string}|null}
 */
function findSameHouseTokenMatch(candidate, pool) {
  const ct = tokensWithoutYears(candidate && candidate.title);
  if (ct.size === 0) return null;
  const run = listingRunDates(candidate);
  const start = validDateOrNull(candidate.listingFirstDate) || run.previewsStartDate || validDateOrNull(candidate.previewsStartDate) || validDateOrNull(candidate.openingDate);
  const end = validDateOrNull(candidate.listingLastDate) || start;
  const dated = isDatedListingCandidate(candidate) && start && end;
  const cutoff = start ? shiftDay(start, -180) : null;
  for (const e of Array.isArray(pool) ? pool : []) {
    if (!e || !e.title || typeof e.venue !== 'string' || !sameLondonHouse(candidate.venue, e.venue)) continue;
    const et = tokensWithoutYears(e.title);
    if (et.size === 0) continue;
    const equal = ct.size === et.size && [...ct].every(t => et.has(t));
    if (equal) {
      if (cutoff && typeof e.closingDate === 'string' && e.closingDate < cutoff) continue;
      return { match: e, reason: `same house, same title words ("${e.title}" vs "${candidate.title}")` };
    }
    if (!dated) continue;
    const [small, big] = ct.size <= et.size ? [ct, et] : [et, ct];
    if (small.size < 2 || ![...small].every(t => big.has(t))) continue;
    const w = rowWindow(e);
    if (w && !(w.first <= shiftDay(end, 30) && w.last >= shiftDay(start, -30))) continue;
    return { match: e, reason: `same house, title words contained, ${w ? 'overlapping run' : 'undated catalog row'} ("${e.title}" vs "${candidate.title}")` };
  }
  return null;
}

/**
 * BRO-4433 — the run a confirmed dated candidate supplies for the existing
 * row it deduped to, when that row carries no run dates at all (a slug-title
 * or TodayTix stub minted 'announced' before the venue's dated reader
 * existed). Only an 'announced' row, and only a run starting in the stub
 * id's year or the next. Fills null fields only; a row with any of previewsStartDate /
 * openingDate / closingDate is left alone (its dates came from a source we
 * do not second-guess here). Status is not touched: update-show-status.js
 * Check 2e (decideAnnouncedPromotion) moves an announced row once it has a
 * date, on its next run.
 *
 * Also offers a title when the row's title is a slug-derived truncation of
 * the dated title ("Twenty Thousand Streets" → "Twenty Thousand Streets
 * Under the Sky"): the dated title's words strictly contain the row's, it
 * carries no subtitle/venue tag (":" or "("), and it normalizes without a
 * manual-review flag. The id and slug never change.
 *
 * @param {object} candidate  a dated-listing candidate
 * @param {{previewsStartDate?, openingDate?, closingDate?, title?}} row
 * @param {object} [venueVocabulary]
 * @returns {{previewsStartDate?: string, closingDate?: string, title?: string, type?: string}|null}
 */
function datedBackfillFor(candidate, row, venueVocabulary) {
  if (!isDatedListingCandidate(candidate) || !row || rowWindow(row)) return null;
  if (row.status && row.status !== 'announced') return null;
  const run = listingRunDates(candidate);
  // An undated stub's id carries the year it was minted (discovery mints the
  // current year when it has no dates), so a run starting later than the
  // year after is a later production: an annual panto, a revival (BRO-4433
  // ship-check). A 2026 stub for a spring-2027 run is still the same one.
  const idYear = /-(20\d\d)$/.exec(String(row.id || ''));
  const runStart = run.previewsStartDate || validDateOrNull(candidate.listingFirstDate);
  if (idYear && runStart) {
    const y = Number(idYear[1]);
    const ry = Number(runStart.slice(0, 4));
    if (ry < y || ry > y + 1) return null;
  }
  const patch = {};
  if (run.previewsStartDate && row.previewsStartDate == null) patch.previewsStartDate = run.previewsStartDate;
  if (run.closingDate && row.closingDate == null) patch.closingDate = run.closingDate;
  if (Object.keys(patch).length === 0) return null;
  // The dated row will leave 'announced' (update-show-status Check 2e), where
  // a type is required: take it from the venue's genre label when that label
  // says what the show is (never a guess).
  if (row.type == null) {
    const t = knownShowType(candidate.title, candidate.listingGenre);
    if (t) patch.type = t;
  }
  const ct = tokensWithoutYears(candidate.title);
  const rt = tokensWithoutYears(row.title);
  if (rt.size > 0 && ct.size > rt.size && [...rt].every(t => ct.has(t)) && !/[:(]|\s[-–—]\s/.test(candidate.title)) {
    const norm = normalizeShowTitle({ title: candidate.title, venue: candidate.venue }, { venueVocabulary });
    if (!norm.manualReview && norm.title && norm.title !== row.title) patch.title = norm.title;
  }
  return patch;
}

/**
 * Duplicate check for one candidate. findExistingMatch's London-pool title
 * fallback (same title at any London venue) is right for an aggregator
 * row, but a dated venue listing is itself evidence of a production at THAT
 * house: Lyric Hammersmith's "Cinderella" is not the Palladium's, nor is
 * Barbican's "A Doll's House" the Almeida's (BRO-4398 review). For a dated
 * candidate the fallback only counts at the same house.
 */
function findDuplicate(candidate, pool) {
  if (!isDatedListingCandidate(candidate)) {
    return findExistingMatch(candidate, pool) || findSameHouseTokenMatch(candidate, pool);
  }
  const strict = findExistingMatch(candidate, pool, { londonPoolFallback: false });
  if (strict) return strict;
  const loose = findExistingMatch(candidate, pool);
  if (loose && loose.match && sameLondonHouse(candidate.venue, loose.match.venue)) return loose;
  return findSameHouseTokenMatch(candidate, pool);
}

/**
 * A candidate staged by one of OWE_VENUE_CONFIGS' dated readers (BRO-4398):
 * it carries the venue's own first/last performance dates.
 */
function isDatedListingCandidate(candidate) {
  return !!(candidate && (candidate.listingFirstDate || candidate.listingLastDate));
}

/**
 * Is `venue` one of the curated London venues discovery reads — a dated
 * reader (OWE_VENUE_CONFIGS) or a VENUE_LISTING_PAGES link reader? The OWE
 * analogue of isKnownOffBroadwayVenue for decideVenueListingPromotion:
 * a dated listing only counts as evidence at a house we chose to read.
 * normalizeVenueName equality, never a substring match.
 */
function isCuratedLondonVenue(venue, opts = {}) {
  if (datedReaderFor(venue, opts.datedConfigs)) return true;
  return !!findVenueListingPage(venue, opts.listingPages);
}

/**
 * The OWE_VENUE_CONFIGS dated reader for `venue`: its name or one of its
 * coversVenues / coverageExact rooms ("The Maria Theatre" → Young Vic),
 * compared by normalizeVenueName equality.
 */
function datedReaderFor(venue, datedConfigs) {
  const key = normalizeVenueName(venue);
  if (!key) return null;
  const dated = Array.isArray(datedConfigs) ? datedConfigs : OWE_VENUE_CONFIGS;
  return dated.find(d => d && [d.name, ...(d.coversVenues || []), ...(d.coverageExact || [])]
    .some(n => normalizeVenueName(n) === key)) || null;
}

/**
 * The run dates a dated listing supports, in show-entry terms: first
 * performance → previewsStartDate (London's first performance, as discovery
 * records TodayTix/OLT start dates), last → closingDate. Not when the
 * reader flags the first date as merely the next one on sale, or the last
 * as a booking horizon.
 */
function listingRunDates(candidate) {
  if (!isDatedListingCandidate(candidate)) return { previewsStartDate: null, closingDate: null };
  return {
    previewsStartDate: candidate.listingFirstDateIsNext ? null : validDateOrNull(candidate.listingFirstDate),
    closingDate: candidate.listingLastDateIsHorizon ? null : validDateOrNull(candidate.listingLastDate),
  };
}

// decideVenueListingPromotion refusals that change with time rather than
// with the listing: a run more than a year out becomes eligible later.
const DATED_LISTING_HOLD_RE = /\bmore than \d+d out\b/;

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
 * @param {Map<string, {text: string|null, error: string|null}>} [ctx.evidencePages]
 *   keyed by evidence url (see fetchEvidencePages); consulted only for a
 *   candidate that carries `evidence` (S8-T3). Missing key = not fetched.
 * @param {object} [ctx.outletRegistry] loaded outlet-registry.json (default: the real one)
 * @param {Function} [ctx.isNonTheaterContent] defaults to discovery's gate
 * @param {Function} [ctx.shouldExcludeVenueShow] defaults to discovery's venue-page title exclusions
 * @returns {{confirmed: boolean, persistent?: boolean, reason: string, source?: string, page?: object|string}}
 *   `page` is the VENUE_LISTING_PAGES entry on the venue-page path and the
 *   evidence URL string on the evidence path.
 */
function decideOffWestEndVenuePromotion(candidate, ctx = {}) {
  const venueListings = ctx.venueListings instanceof Map ? ctx.venueListings : new Map();
  const evidencePages = ctx.evidencePages instanceof Map ? ctx.evidencePages : new Map();
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

  // Discovery's own venue-page exclusions (workshops, galas, Q&As, coffee
  // concerts, labs, ...) re-applied at promotion time so a candidate staged
  // BEFORE a phrase was added is still caught. Runs AFTER the ingest gate
  // (2026-09-29): shouldExcludeVenueShow now also carries NON_THEATRE_TITLE_RE,
  // so a festival/panel title would otherwise be attributed here instead of
  // to the policy gate (docs/show-inclusion-policy.md) that owns that rule.
  if (excludeTitle(candidate.title)) {
    return { confirmed: false, persistent: true, reason: `"${candidate.title}" matches a venue-page exclusion phrase (VENUE_PAGE_EXCLUDE_PATTERNS / NON_THEATER_PATTERNS) — not a production` };
  }

  // S8-T3 — a candidate that carries review/coverage evidence is decided on
  // that evidence alone; the venue page is never consulted for it (the
  // production has usually closed, or plays a venue with no listing page).
  const evidence = reviewEvidence(candidate);
  if (evidence.length > 0) {
    const registry = ctx.outletRegistry !== undefined ? ctx.outletRegistry : loadOutletRegistry();
    return decideByReviewEvidence(candidate, evidence, evidencePages, registry);
  }

  // BRO-4398 — a dated reader's row is decided on the venue's own dated
  // listing, exactly as decideVenueListingPromotion decides an OB venue's:
  // a run (five-plus performances, or a multi-day span when uncounted) that
  // has not ended and starts within a year. No re-fetch: the listing it was
  // staged from is the evidence, and a refusal here is final for the row
  // (discovery re-stages it with fresh dates if the listing changes).
  if (isDatedListingCandidate(candidate)) {
    const isOneNightShow = typeof ctx.isOneNightShow === 'function' ? ctx.isOneNightShow : discovery().isOneNightShow;
    const v = decideVenueListingPromotion(candidate, {
      ...(ctx.todayIso ? { todayIso: ctx.todayIso } : {}),
      isKnownVenue: venue => isCuratedLondonVenue(venue, { listingPages: ctx.listingPages, datedConfigs: ctx.datedConfigs }),
      gates: { isOneNightShow },
    });
    if (v.confirmed) {
      const dated = datedReaderFor(candidate.venue, ctx.datedConfigs);
      return {
        confirmed: true,
        persistent: false,
        reason: v.reason,
        source: 'venue-listing',
        page: candidate.listingUrl || (dated ? dated.url : null) || null,
      };
    }
    return {
      confirmed: false,
      persistent: !DATED_LISTING_HOLD_RE.test(v.reason),
      reason: `venue's dated listing does not confirm a run: ${v.reason}`,
    };
  }

  // A venue with a dated reader lists every production with its dates, so
  // an undated row staged there (the old slug-title reader, or its fallback
  // on a day the dated feed failed) is never confirmed by the link page:
  // that page is what put Kiln's cinema screenings and The Other Palace's
  // "Scribbles Concert" into shows.json on 2026-09-30. Discovery re-stages
  // the production, dated, if the venue's own listing carries it.
  const datedFor = datedReaderFor(candidate.venue, ctx.datedConfigs);
  if (datedFor) {
    return { confirmed: false, persistent: true, reason: `${datedFor.name} has a dated reader; an undated row staged there is not confirmed by its link page — dropped (discovery re-stages it with dates if the venue's listing carries it)` };
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
 *
 * An evidence-backed candidate (S8-T3, reviewEvidence non-empty) is
 * stamped discoverySource AUDIT_EVIDENCE_SOURCE with its evidenceUrls, and
 * its dates are credited to that source rather than to a venue page; an
 * explicit candidate.type in VALID_SHOW_TYPES overrides the title
 * heuristic (a hand-prepared row knows "Ancient Grease" is a musical).
 */
function buildOffWestEndVenueShowEntry(candidate, venueVocabulary, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const evidence = reviewEvidence(candidate);
  const evidenceBacked = evidence.length > 0;
  // BRO-3863 — normalise BEFORE the slug/id are derived from the title, with
  // the same normaliser validate-data.js gates on, so a row written here can
  // never fail the gate that guards it.
  const normalizedTitle = normalizeShowTitle({ title: candidate.title, venue: candidate.venue }, { venueVocabulary }).title;
  // A dated reader's row (BRO-4398) supplies its run from the listing when
  // the candidate carries no explicit dates of its own.
  const listed = listingRunDates(candidate);
  const openingDate = validDateOrNull(candidate.openingDate);
  const previewsStartDate = validDateOrNull(candidate.previewsStartDate) || listed.previewsStartDate;
  const closingDate = validDateOrNull(candidate.closingDate) || listed.closingDate;
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
    openingDateSource: openingDate ? (evidenceBacked ? AUDIT_EVIDENCE_SOURCE : 'venue-page') : null,
    previewsStartDate,
    closingDate,
    status,
    category: 'off-west-end',
    market: marketForCategory('off-west-end'),
    type: status === 'announced'
      ? null
      : (VALID_SHOW_TYPES.has(candidate.type) ? candidate.type : showTypeFor(normalizedTitle, candidate.listingGenre)),
    discoverySource: evidenceBacked ? AUDIT_EVIDENCE_SOURCE : (candidate.source || candidate.discoverySource || 'venue-page'),
    discoveredAt: candidate.discoveredAt || now.toISOString(),
    // Provisional — no cross-source corroboration beyond the venue's own
    // page (or, on the evidence path, beyond the outlet page named in
    // evidenceUrls); validate-show-venue.js --all-provisional keeps checking
    // it, and images/cast/exact dates arrive via later enrichment.
    provisional: true,
    ...(evidenceBacked ? { evidenceUrls: [...new Set(evidence.map(e => e.url))] } : {}),
  };
}

/**
 * Read and validate a --stage-file: a JSON array of hand-prepared candidate
 * rows. Each row needs a non-empty `title` and `venue`; `category` defaults
 * to 'off-west-end'; `evidence`, when present, must be an array whose
 * entries are {kind ∈ EVIDENCE_KINDS, url: http(s)} (reviewEvidence would
 * silently drop a malformed entry at decision time, which for a hand-
 * prepared file is exactly the wrong failure mode — so it is refused here,
 * naming the row). `source`/`discoverySource` default to
 * AUDIT_EVIDENCE_SOURCE for an evidence-backed row. Throws on any problem;
 * nothing is merged from a file with one bad row.
 */
function loadStageFile(file) {
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`--stage-file ${file}: ${e.message}`);
  }
  if (!Array.isArray(rows)) throw new Error(`--stage-file ${file}: expected a JSON array of candidate rows`);
  const problems = [];
  const out = rows.map((row, i) => {
    const label = `row ${i}${row && row.title ? ` ("${row.title}")` : ''}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { problems.push(`${label}: not an object`); return null; }
    if (typeof row.title !== 'string' || !row.title.trim()) problems.push(`${label}: missing title`);
    if (typeof row.venue !== 'string' || !row.venue.trim()) problems.push(`${label}: missing venue`);
    if (row.category !== undefined && row.category !== 'off-west-end') problems.push(`${label}: category must be off-west-end (got ${JSON.stringify(row.category)})`);
    if (row.evidence !== undefined) {
      if (!Array.isArray(row.evidence)) problems.push(`${label}: evidence must be an array`);
      else {
        row.evidence.forEach((e, j) => {
          if (!e || typeof e !== 'object' || !EVIDENCE_KINDS.has(e.kind)) problems.push(`${label}: evidence[${j}].kind must be one of ${[...EVIDENCE_KINDS].join('|')}`);
          let ok = false;
          try { const u = new URL(e && e.url); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch { ok = false; }
          if (!ok) problems.push(`${label}: evidence[${j}].url must be an http(s) URL`);
        });
      }
    }
    for (const k of ['openingDate', 'previewsStartDate', 'closingDate']) {
      if (row[k] != null && !validDateOrNull(row[k])) problems.push(`${label}: ${k} must be YYYY-MM-DD or null (got ${JSON.stringify(row[k])})`);
    }
    if (row.type != null && !VALID_SHOW_TYPES.has(row.type)) problems.push(`${label}: type must be one of ${[...VALID_SHOW_TYPES].join('|')}`);
    const evidenceBacked = Array.isArray(row.evidence) && row.evidence.length > 0;
    return {
      ...row,
      title: typeof row.title === 'string' ? row.title.trim() : row.title,
      venue: typeof row.venue === 'string' ? row.venue.trim() : row.venue,
      category: 'off-west-end',
      source: row.source || row.discoverySource || (evidenceBacked ? AUDIT_EVIDENCE_SOURCE : null),
      discoverySource: row.discoverySource || row.source || (evidenceBacked ? AUDIT_EVIDENCE_SOURCE : null),
      provisional: true,
    };
  });
  if (problems.length > 0) throw new Error(`--stage-file ${file}: ${problems.length} problem(s), nothing merged:\n  ${problems.join('\n  ')}`);
  return out;
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
 * Live fetch of ONE evidence URL through fetchPage() (the scraper rule),
 * reduced to its visible text. Never throws: a failure is reported as
 * {text: null, error} so decideByReviewEvidence holds (not prunes) the
 * candidates that cite it.
 */
async function fetchEvidencePage(url, opts = {}) {
  const fetchPage = opts.fetchPage || require('./lib/scraper').fetchPage;
  const log = opts.log || console.log;
  try {
    const result = await fetchPage(url, { renderJs: false });
    const html = result && result.content ? String(result.content) : '';
    if (!html) return { url, text: null, error: 'empty response' };
    const text = stripHtml(html).replace(/\s+/g, ' ').trim();
    if (!text) return { url, text: null, error: 'no visible text' };
    log(`  evidence ${url}: ${text.length} chars of text`);
    return { url, text, error: null };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log(`  evidence ${url}: fetch failed (${msg.slice(0, 120)})`);
    return { url, text: null, error: msg };
  }
}

/**
 * One fetch per distinct evidence URL whose host is a registered outlet
 * (an unregistered host can never confirm, so it costs no fetch), bounded
 * by --evidence-limit and the time budget. Unfetched URLs hold their
 * candidates for the next run.
 * @returns {Promise<Map<string, {url, text, error}>>} keyed by url
 */
async function fetchEvidencePages(candidates, opts = {}) {
  const { limit = DEFAULT_EVIDENCE_FETCH_LIMIT, timeBudget = null, log = () => {} } = opts;
  const registry = opts.outletRegistry !== undefined ? opts.outletRegistry : loadOutletRegistry();
  const urls = [];
  const seen = new Set();
  for (const c of candidates) {
    for (const ev of reviewEvidence(c)) {
      if (seen.has(ev.url)) continue;
      seen.add(ev.url);
      if (resolveEvidenceOutlet(ev.url, registry).outletId) urls.push(ev.url);
    }
  }
  const pages = new Map();
  let fetches = 0;
  for (const url of urls) {
    if (fetches >= limit) {
      log(`  [limit] reached --evidence-limit=${limit} evidence fetches; ${urls.length - fetches} URL(s) held until the next run`);
      break;
    }
    if (timeBudget && timeBudget.exceeded()) {
      log(`  ⏱ Time budget (${timeBudget.minutes} min) reached — remaining evidence URLs held until the next run`);
      break;
    }
    fetches++;
    pages.set(url, await fetchEvidencePage(url, opts));
  }
  return pages;
}

/**
 * One fetch per distinct staged venue that has a VENUE_LISTING_PAGES entry,
 * bounded by --limit and the time budget. Candidates at venues with no
 * listing page cost no fetch (decideOffWestEndVenuePromotion refuses them
 * without one), and neither do evidence-backed candidates (S8-T3: decided
 * on their evidence, the venue page is never consulted for them).
 * @returns {Promise<Map<string, object>>} keyed by page name
 */
async function fetchVenueListings(candidates, opts = {}) {
  const { limit = DEFAULT_FETCH_LIMIT, timeBudget = null, log = () => {} } = opts;
  const pages = new Map();
  for (const c of candidates) {
    if (reviewEvidence(c).length > 0) continue;
    // BRO-4398: decided on the dated listing it was staged from.
    if (isDatedListingCandidate(c)) continue;
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
 * @param {Map<string, object>} [ctx.evidencePages] from fetchEvidencePages() (S8-T3)
 * @param {object} [ctx.outletRegistry] loaded outlet-registry.json (default: the real one)
 * @param {Array<object>} [ctx.retiredEntries] registry entries (default: cached on-disk list)
 * @param {Array<object>} [ctx.listingPages] default VENUE_LISTING_PAGES
 * @param {number} [ctx.maxPromote] cap on promotions this run; the rest are held
 * @param {{exceeded(): boolean, minutes: number}} [ctx.timeBudget]
 * @param {Function} [ctx.log]
 * @param {Function} [ctx.logEntry] injectable audit-log sink
 * @param {Function} [ctx.now] clock
 * @returns {Promise<{promoted: Array, held: Array, pruned: Array, backfills: Array}>}
 *   pruned = candidates that leave staging (promoted + persistent refusals)
 *   backfills = {candidate, id, patch, sourceUrl} for undated rows a
 *     confirmed dated duplicate dates (BRO-4433; the candidate is also pruned)
 */
async function evaluateCandidates(candidates, ctx) {
  const {
    existingCandidates,
    existingIds,
    venueVocabulary,
    venueListings = new Map(),
    evidencePages = new Map(),
    outletRegistry = undefined,
    retiredEntries = undefined,
    listingPages = undefined,
    datedConfigs = undefined,
    maxPromote = MAX_PROMOTE_PER_RUN,
    timeBudget = null,
    log = () => {},
    logEntry: logEntryFn = logEntry,
    now = () => new Date(),
  } = ctx;
  const promoted = [];
  const held = [];
  const pruned = [];
  const backfills = [];

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
      const existingMatch = findDuplicate(c, existingCandidates);
      if (existingMatch) {
        // BRO-4433 — a confirmed dated listing dates the undated row it
        // matched (null fields only; main() writes it).
        const patch = datedBackfillFor(c, existingMatch.match, venueVocabulary);
        if (patch) {
          const decision = decideOffWestEndVenuePromotion(c, { venueListings, listingPages, evidencePages, outletRegistry, datedConfigs, todayIso: now().toISOString().slice(0, 10) });
          if (decision.confirmed) {
            backfills.push({ candidate: c, id: existingMatch.match.id, patch, sourceUrl: typeof decision.page === 'string' ? decision.page : null });
            if (patch.previewsStartDate) existingMatch.match.previewsStartDate = patch.previewsStartDate;
            if (patch.closingDate) existingMatch.match.closingDate = patch.closingDate;
          }
        }
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
      //    the venue page itself — or, for an evidence-backed candidate, the
      //    registered-outlet page it cites (S8-T3).
      const decision = decideOffWestEndVenuePromotion(c, { venueListings, listingPages, evidencePages, outletRegistry, datedConfigs, todayIso: now().toISOString().slice(0, 10) });
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

      const sourceUrl = typeof decision.page === 'string' ? decision.page : (decision.page ? decision.page.url : null);
      promoted.push({ candidate: c, entry, confirmationReason: decision.reason, sourceUrl });
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

  return { promoted, held, pruned, backfills };
}

function parseIntFlag(argv, name, fallback) {
  const raw = (argv.find(a => a.startsWith(`${name}=`)) || '').split('=')[1];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseStringFlag(argv, name) {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  if (!hit) return null;
  const value = hit.slice(name.length + 1);
  return value.length > 0 ? value : null;
}

/**
 * @param {string[]} [argv] CLI args (default process.argv)
 * @param {object} [io] injectable I/O for tests and offline runs:
 *   fetchPage replaces lib/scraper.js's; log replaces console.log; logEntry
 *   replaces the jsonl audit-log append; showsPath / stagingPath redirect
 *   the two data files, lastPromotionFile the state file the workflow
 *   summarises; retiredEntries replaces the on-disk registry.
 * @returns {Promise<{promoted: Array, held: Array, pruned: Array, dryRun: boolean, suppressedWrites: Array, staged?: number, stageOnly?: boolean}|undefined>}
 */
async function main(argv = process.argv.slice(2), io = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const dryRun = argv.includes('--dry-run');
  const limit = parseIntFlag(argv, '--limit', DEFAULT_FETCH_LIMIT);
  const evidenceLimit = parseIntFlag(argv, '--evidence-limit', DEFAULT_EVIDENCE_FETCH_LIMIT);
  const maxPromote = parseIntFlag(argv, '--max-promote', MAX_PROMOTE_PER_RUN);
  const stageFile = parseStringFlag(argv, '--stage-file');
  const stageOnly = argv.includes('--stage-only');
  const log = io.log || ((...a) => console.log(...a));
  if (stageOnly && !stageFile) {
    throw new Error('--stage-only requires --stage-file=<json>');
  }
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

  // --stage-file (S8-T3): hand-prepared candidates enter staging through the
  // same locked upsert discovery uses (writeStagingCandidates → updateStaging,
  // keyed by candidateHash) — never a direct write. Under --dry-run the merge
  // is in memory (mergeCandidates over the CURRENT on-disk entries) so the
  // evaluation below sees exactly the union a real run would have written.
  // The file is validated in full first; one bad row merges nothing.
  let stagedOverride = null;
  if (stageFile) {
    const rows = loadStageFile(path.resolve(stageFile));
    if (dryRun) {
      stagedOverride = mergeCandidates(loadStaging(stagingPath), rows);
      log(`(dry-run) merged ${rows.length} candidate(s) from ${stageFile} in memory — ${stagedOverride.length} staged for evaluation; staging file untouched.`);
    } else {
      const next = writeStagingCandidates(rows, stagingPath);
      log(`Merged ${rows.length} candidate(s) from ${stageFile} into ${path.relative(process.cwd(), stagingPath)} (${next.length} staged).`);
    }
  }
  if (stageOnly) {
    log(`--stage-only: ${dryRun ? 'validated the stage file; ' : ''}no evaluation this run.`);
    return { promoted: [], held: [], pruned: [], dryRun, suppressedWrites: showsGuard.suppressedWrites, stageOnly: true, staged: stagedOverride ? stagedOverride.length : loadStaging(stagingPath).length };
  }

  // Reset up front so a crash mid-run can never leave a stale file claiming
  // a prior run's promotions happened again.
  if (!dryRun) writeLastPromotionFile([], [], lastPromotionFile);

  const candidates = collectCandidates({ stagingPath, ...(stagedOverride ? { staged: stagedOverride } : {}) });
  log(`Loaded ${candidates.length} staged Off-West End candidate(s) from ${path.relative(process.cwd(), stagingPath)}${stagedOverride ? ' (+ stage file)' : ''}.`);
  const result = { promoted: [], held: [], pruned: [], backfills: [], dryRun, suppressedWrites: showsGuard.suppressedWrites };
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
    .map(s => ({ id: s.id, title: s.title, venue: s.venue, category: s.category, status: s.status, previewsStartDate: s.previewsStartDate || null, openingDate: s.openingDate || null, closingDate: s.closingDate || null }));
  // Loud on a malformed registry (loadRetiredIds throws) — silently treating
  // it as empty is exactly how a retired id slips back in.
  const retiredEntries = Array.isArray(io.retiredEntries) ? io.retiredEntries : loadRetiredIds();
  if (retiredEntries.length > 0) log(`Retired-id registry: ${retiredEntries.length} entr${retiredEntries.length === 1 ? 'y' : 'ies'}.`);

  log('Re-fetching venue pages for confirmation...');
  const fetchOpts = { limit, timeBudget, log, listingPages: io.listingPages };
  if (io.fetchPage) fetchOpts.fetchPage = io.fetchPage;
  const venueListings = await fetchVenueListings(candidates, fetchOpts);

  // S8-T3 — the registered-outlet pages evidence-backed candidates cite.
  const outletRegistry = io.outletRegistry !== undefined ? io.outletRegistry : loadOutletRegistry();
  const evidenceOpts = { limit: evidenceLimit, timeBudget, log, outletRegistry };
  if (io.fetchPage) evidenceOpts.fetchPage = io.fetchPage;
  const evidenceCount = candidates.filter(c => reviewEvidence(c).length > 0).length;
  if (evidenceCount > 0) log(`Fetching evidence pages for ${evidenceCount} evidence-backed candidate(s)...`);
  const evidencePages = await fetchEvidencePages(candidates, evidenceOpts);

  const { promoted, held, pruned, backfills } = await evaluateCandidates(candidates, {
    existingCandidates,
    existingIds,
    venueVocabulary,
    venueListings,
    evidencePages,
    outletRegistry,
    retiredEntries,
    listingPages: io.listingPages,
    datedConfigs: io.datedConfigs,
    maxPromote,
    timeBudget,
    log,
    logEntry: logEntryFn,
    ...(io.now ? { now: io.now } : {}),
  });
  Object.assign(result, { promoted, held, pruned, backfills });
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
  if (backfills.length > 0) {
    log(`Dating ${backfills.length} undated row(s) from the venue's dated listing (null fields only):`);
    for (const b of backfills) log(`  = ${b.id}: ${Object.entries(b.patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
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

  // BRO-4433 — apply the backfills to the loaded rows, re-checking each
  // field is still null on the row itself (never overwrite).
  const applied = [];
  if (backfills.length > 0) {
    const byId = new Map(showsData.shows.map(s => [s.id, s]));
    for (const b of backfills) {
      const row = byId.get(b.id);
      if (!row || rowWindow(row) || row.status !== 'announced') continue;
      const set = {};
      const oldTitle = row.title;
      for (const k of ['previewsStartDate', 'closingDate']) {
        if (b.patch[k] && row[k] == null) { row[k] = b.patch[k]; set[k] = b.patch[k]; }
      }
      if (Object.keys(set).length === 0) continue;
      if (b.patch.title) { row.title = b.patch.title; set.title = b.patch.title; }
      if (b.patch.type && row.type == null) { row.type = b.patch.type; set.type = b.patch.type; }
      applied.push({ ...b, set, oldTitle });
    }
  }

  if (promoted.length === 0 && applied.length === 0) {
    writeLastPromotionFile([], rejectedRows, lastPromotionFile);
    log('Nothing to promote; shows.json unchanged.');
    // Persistent refusals still leave staging on a zero-promotion run, or
    // stale entries linger forever (the OB promoter's QA 2026-07-08 lesson).
    if (prunedHashes.size > 0) rewriteStaging();
    return result;
  }

  for (const p of promoted) showsData.shows.push(p.entry);
  try {
    const evidencePromotions = promoted.filter(p => reviewEvidence(p.candidate).length > 0).length;
    const r = showsGuard.saveShows(showsData, { reason: `promote-owe-venue-candidates: ${promoted.length - evidencePromotions} venue-page + ${evidencePromotions} review-evidence promotion(s), ${applied.length} undated row(s) dated from the venue's dated listing` });
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
  for (const b of applied) {
    logEntryFn({ kind: 'backfill-dates', title: b.candidate.title, venue: b.candidate.venue, id: b.id, set: b.set, ...(b.set.title ? { oldTitle: b.oldTitle } : {}), source: b.candidate.source, sourceUrl: b.sourceUrl });
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
  decideByReviewEvidence,
  buildOffWestEndVenueShowEntry,
  collectCandidates,
  loadStageFile,
  reviewEvidence,
  resolveEvidenceOutlet,
  foldText,
  pageTextContainsTitle,
  fetchEvidencePage,
  fetchEvidencePages,
  fetchVenueListing,
  fetchVenueListings,
  findVenueListingPage,
  isDatedListingCandidate,
  isCuratedLondonVenue,
  findSameHouseTokenMatch,
  findDuplicate,
  datedBackfillFor,
  listingRunDates,
  evaluateCandidates,
  main,
  MAX_PROMOTE_PER_RUN,
  DEFAULT_FETCH_LIMIT,
  DEFAULT_EVIDENCE_FETCH_LIMIT,
  EVIDENCE_KINDS,
  AUDIT_EVIDENCE_SOURCE,
  LAST_PROMOTION_FILE,
  PROMOTION_LOG,
};
