#!/usr/bin/env node
/**
 * replay-pending-bylines.js
 *
 * Files in data/review-texts/_pending/{showId}/{outlet}--{hash}.json end up there
 * when discovery returns a URL but no defaultCritic is in outlet-registry and the
 * byline wasn't detectable at write time. _pending is a HARD SINK —
 * collect-review-texts.js does NOT scan it (verified 2026-04-29).
 *
 * This replay script:
 *   1. Walks _pending/{showId}/ for each opera show (or all shows with --all)
 *   2. Fetches the URL via fetchPage
 *   3. Extracts byline via the shared readPageByline (BRO-7798)
 *   4. If byline found: rename file to {outlet}--{critic-slug}.json, move to
 *      data/review-texts/{showId}/, remove from _pending
 *   5. If not found: leave in _pending, log
 *   6. (BRO-2735) A stub with a URL but no body is rebuilt from the fetch
 *      (empty-body-retry recoveryPatch → buildRefetchedPendingRecord), not
 *      repaired in place. A stub that still has NO body and NO byline after
 *      all that is "pending-unrecoverable": it emits a stage-latency event
 *      (once per stub, stamped pendingUnrecoverableAt) and routes an owner
 *      alert (disposition 'human') for shows in their first post-opening week
 *      or named explicitly with --show/--shows — instead of a quiet "keep".
 *
 * Usage:
 *   node scripts/replay-pending-bylines.js --show=eugene-onegin-off-broadway-2026
 *   node scripts/replay-pending-bylines.js --shows=show1,show2
 *   node scripts/replay-pending-bylines.js --all-opera
 *   node scripts/replay-pending-bylines.js --all-open --time-budget-min=16
 *   node scripts/replay-pending-bylines.js --all-open --closed-within-days=90   (open + recently closed)
 *   node scripts/replay-pending-bylines.js --all-pending --time-budget-min=16  (every show with a _pending dir)
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
// BRO-7798: the shared byline reader (outlet rules first), never extractAuthorFromHtml directly.
const { readPageBylineWithMetaFallback } = require('./lib/page-byline-for-show');
const { normalizeCritic } = require('./lib/review-normalization');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { verifyAggregatorUrl } = require('./lib/show-match-verifier');
const { extractPublishDate } = require('./lib/article-extractor');
const { isArticleOutsideProductionWindow } = require('./lib/date-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { findExistingFileForUrl: findExistingFileForUrlShared } = require('./lib/review-url-clusters');
const { isRecentlyLive } = require('./lib/show-liveness');
const { markEmptyBodyForRetry, recoveryPatch } = require('./lib/empty-body-retry');
const { emitStage } = require('./lib/stage-latency');
const {
  isUnrecoverablePendingStub, isZeroTextPendingStub, isInPostOpeningWindow, buildRefetchedPendingRecord,
} = require('./lib/pending-review-health');
const { retryEmptyBodyReviews } = require('./retry-empty-body-reviews');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `replay-pending-bylines.js — Files in data/review-texts/_pending/{showId}/{outlet}--{hash}.json end up there.

Usage:
  node scripts/replay-pending-bylines.js [options]
  node scripts/replay-pending-bylines.js --help, -h    print this usage and exit

Scope (one of):
  --show=ID | --shows=ID1,ID2 | --all-opera
  --all-open                 every open/previews show with a _pending dir
  --all-pending              every show with a _pending dir (closed included)

Options:
  --closed-within-days=N     with --all-open: also drain shows that CLOSED within
                             the last N days (a show closing the week its reviews
                             land otherwise never drains — audit S7-T7)
  --time-budget-min=N        stop cleanly after N minutes (remaining shows deferred)
  --dry-run                  report what would be promoted, write nothing
  --triage-only              (BRO-8023) settle every stub a URL/date rule can judge,
                             fetch nothing; report the fetch candidates left
  --era=2025-26|2015-24|pre-2015  restrict the scope to shows of that era
  --shard=i/n                split the scope across n parallel processes (local batch)
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
// Non-theatre news sections. Same-title film articles (the Beetlejuice *film*) carry
// the show title in their <title>, so show-match passes them — but they are wrong
// PRODUCTION, not theatre reviews. NARROW to clearly-non-theatre sections only:
// outlets routinely file REAL theatre reviews under tv/music/lifestyle/books sections
// (Daily Mail /tv/, USA Today /entertainment/music/, WashPost /lifestyle/), so those
// would be false positives. Only sections a stage review never legitimately appears in.
// (ship-check 2026-06-05: the broad list + delete would have destroyed real reviews.)
const NON_THEATRE_SECTIONS = new Set([
  'film', 'films', 'movies', 'sport', 'sports', 'money', 'fashion', 'food-drink',
]);

/**
 * Reason a stranded _pending review must NOT be promoted to the main show dir,
 * or null if it's safe to promote. Pure (no I/O) so it's unit-testable.
 *   1. Aggregator / listing / ticket / feature-interview URL (isBlockedReviewUrl).
 *   2. Non-theatre news section (film/tv/lifestyle) — wrong production, same title.
 *   3. verifyAggregatorUrl show-match fails — different show.
 *   4. Article publish date is outside THIS production's window (before previews −
 *      grace, or after close + grace) and not within any declared priorRun — the
 *      SAME title covering an EARLIER/LATER production. Same-title revivals share
 *      the title token, so checks 1–3 pass them; only the date separates them.
 *      (Treneman/Oresteia leak 2026-07-19: a 2017 Edinburgh "Oresteia: This Restless
 *      House" Times review promoted into the-oresteia-west-end-2026 and scored 40.)
 * @param {string} url  @param {string} html  @param {{id,title,venue,openingDate,previewsStartDate,closingDate,category,market,priorRuns}} show
 * @param {string} [publishDate] pre-extracted article date; when omitted it is
 *   extracted from `html` (kept optional so 3-arg unit-test calls still work).
 * @returns {string|null}
 */
function pendingPromoteRejectReason(url, html, show, publishDate) {
  if (isBlockedReviewUrl(url)) return 'aggregator/listing/feature URL, not an outlet review';
  let seg = [];
  try { seg = new URL(url).pathname.toLowerCase().split('/').filter(Boolean); } catch { /* malformed */ }
  const badSection = seg.find(s => NON_THEATRE_SECTIONS.has(s));
  if (badSection) return `non-theatre section (${badSection}) — wrong production`;
  const v = verifyAggregatorUrl({ url, html, show, openingDate: show && show.openingDate });
  if (!v.isValid) return `not this show (${v.rejectReason})`;
  // Temporal wrong-production gate. verifyAggregatorUrl matches on the title
  // token, so a same-title earlier/later production sails through it — the
  // article's publish date is the only signal that separates them. Reuse the
  // canonical date-window decision (UK-outlet grace + priorRuns exemption) that
  // fetch-guardian-reviews.js already uses for the identical revival scenario.
  const pd = publishDate !== undefined ? publishDate : extractPublishDate(html, url);
  if (pd && isArticleOutsideProductionWindow(show, pd)) {
    return `article published ${String(pd).slice(0, 10)} is outside this production's window — earlier/later production of the same title`;
  }
  return null;
}

const args = process.argv.slice(2);
const showArg = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const allOpera = args.includes('--all-opera');
// --all-open: drain _pending for every open/previews show (not just opera). This is the
// general-purpose drain — multi-critic outlet hits (Times/Standard/Guardian) strand in _pending
// with pendingReason:no-byline and were previously only recovered for opera shows, so 500+ real
// reviews across 70+ WE/Broadway shows sat stranded. See data/audit/we-discovery-diagnosis.md.
// --all-pending: drain EVERY show that has a _pending dir (full backlog, including closed).
const allOpen = args.includes('--all-open');
const allPending = args.includes('--all-pending');
const dryRun = args.includes('--dry-run');
const triageOnly = args.includes('--triage-only');
const eraArg = args.find(a => a.startsWith('--era='))?.split('=')[1] || null;
const pendingTriage = require('./lib/pending-triage');
const timeBudget = createRunBudget(parseTimeBudgetMin(args));

/**
 * `--closed-within-days=N` → N (0 when absent, malformed, or non-positive).
 * Only meaningful with --all-open; --all-pending already covers every show.
 */
function parseClosedWithinDays(argv) {
  const raw = (argv || []).find(a => typeof a === 'string' && a.startsWith('--closed-within-days='));
  if (!raw) return 0;
  const n = parseInt(raw.split('=')[1], 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
const closedWithinDays = parseClosedWithinDays(args);

// The historical --all-open allowlist: open + previews only. 'upcoming' is
// deliberately absent — nothing can be stranded in _pending for a show that
// has not started performances. `--closed-within-days=N` widens it to rows
// that closed at most N days ago, through the shared liveness predicate
// (scripts/lib/show-liveness.js, audit S7-T7). With N=0 (the default) the
// options below reproduce the old `['open','previews'].includes(status)`
// filter by construction (tests/unit/show-liveness.test.mjs).
const PENDING_DRAIN_LIVE_STATUSES = Object.freeze(['open', 'previews']);

function pendingDrainLivenessOptions(closedWithin = 0, today = new Date()) {
  return {
    liveStatuses: PENDING_DRAIN_LIVE_STATUSES,
    allowClosed: closedWithin > 0,
    withinDays: closedWithin,
    today,
  };
}

/** Pure: should --all-open drain this show's _pending dir? */
function isPendingDrainEligible(show, closedWithin = 0, today = new Date()) {
  return isRecentlyLive(show, pendingDrainLivenessOptions(closedWithin, today));
}

// Shared resolver: a plain (non-git) data/review-texts goes stale (BRO-4500: replay
// reported "no _pending" mid-opening while the live clone had files).
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const REVIEW_TEXTS_ROOT = resolveReviewTextsDir();
const PENDING_ROOT = path.join(REVIEW_TEXTS_ROOT, '_pending');
const { pendingFileTimestamp, orderPendingWork, rotateTiered, pathKey } = require('./lib/pending-drain-order');
const drainState = require('./lib/pending-drain-state');
const { classifyTargetCollision, promotionBlockRule } = require('./lib/pending-drain-collision');

// Newest strands first (BRO-4408), so a budget-limited run reaches a fresh
// opening-night review before re-fetching old no-byline strands.
// BRO-7930: --all-open / --all-pending sweeps ROTATE from a persisted cursor instead; newest-first stays
// for the opening-night poller and --show/--shows runs (their scope is small and freshness is the point).
function planPendingWork(ids, opts = {}) {
  const shows = ids.map(showId => {
    const dir = path.join(PENDING_ROOT, showId);
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { /* no _pending dir */ }
    const files = names.map(file => {
      let ts = 0;
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(path.join(dir, file)).mtimeMs; } catch { /* gone */ }
      try { ts = pendingFileTimestamp(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), mtimeMs); } catch { ts = pendingFileTimestamp(null, mtimeMs); }
      return { file, ts };
    });
    return { showId, files };
  });
  return opts.raw ? shows : orderPendingWork(shows, opts);
}

function listOperaShowIds() {
  const showsPath = path.join(__dirname, '../data/shows.json');
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return (data.shows || data).filter(s => s.type === 'opera').map(s => s.id);
}

// Show IDs that currently have a non-empty _pending dir.
function listShowIdsWithPending() {
  if (!fs.existsSync(PENDING_ROOT)) return [];
  return fs.readdirSync(PENDING_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(id => {
      try { return fs.readdirSync(path.join(PENDING_ROOT, id)).some(f => f.endsWith('.json')); }
      catch { return false; }
    });
}

function listOpenShowIdsWithPending() {
  const showsPath = path.join(__dirname, '../data/shows.json');
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const showById = new Map((data.shows || data).map(s => [s.id, s]));
  // A _pending dir with no shows.json row is not eligible (isRecentlyLive
  // returns false for a missing show) — same as the old status lookup.
  return listShowIdsWithPending().filter(id => isPendingDrainEligible(showById.get(id), closedWithinDays));
}

// --shard=i/n (BRO-8023): split one scope across n parallel local batch processes by a stable id hash.
const shardArg = (args.find(a => a.startsWith('--shard='))?.split('=')[1] || '').match(/^(\d+)\/(\d+)$/);
function inShard(id, i, n) {
  let h = 0;
  for (const c of String(id)) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return Math.abs(h) % n === i;
}
function showIds() {
  let ids = scopeShowIds();
  if (eraArg) ids = ids.filter(id => pendingTriage.showEra(id) === eraArg);
  if (shardArg) ids = ids.filter(id => inShard(id, Number(shardArg[1]), Number(shardArg[2])));
  return ids;
}

function scopeShowIds() {
  if (showArg) return [showArg];
  if (showsArg) return showsArg.split(',').map(s => s.trim()).filter(Boolean);
  if (allOpera) return listOperaShowIds();
  if (allOpen) return listOpenShowIdsWithPending();
  if (allPending) return listShowIdsWithPending();
  console.error('Usage: --show=ID | --shows=ID1,ID2 | --all-opera | --all-open [--closed-within-days=N] | --all-pending');
  process.exit(1);
}

function loadShow(showId) {
  const showsPath = path.join(__dirname, '../data/shows.json');
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return (data.shows || data).find(s => s.id === showId);
}

// BRO-7945 Part B: one paid fetch per URL per run, shared by every show's copy of the article
// (1,006 basenames sit under 2+ shows; the same ew article was fetched 4x at 4 credits each).
const { makeFetchCache, siblingForArticle } = require('./lib/pending-sibling-productions');
const runFetchCache = makeFetchCache((u) => fetchPage(u));
let _allShowsMemo = null;
function loadAllShows() {
  if (!_allShowsMemo) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
    _allShowsMemo = data.shows || data;
  }
  return _allShowsMemo;
}

const { NON_MET_OPERA_URL_MARKERS, hasNonMetOperaUrlMarker, operaHouseForVenue } = require('./lib/content-filters');

// The byline extractor is non-deterministic on outlets whose article pages carry
// a rotating "more from our critics" recirc widget (Times UK, WhatsOnStage) —
// the same URL can extract a DIFFERENT critic name on each fetch. Multiple
// _pending stub files for the SAME url (one per discovery event: RSS, SERP,
// aggregator crosslink) then each promote under a distinct {outlet}--{critic}.json
// filename, since the pre-existing check below only guarded against re-promoting
// the exact same filename — never against a second PRIMARY for a URL already
// promoted under a different name. That was the byline-explosion root cause
// (BRO-1391): 5-29 files per URL, all invalid/circular-duplicateOf, real review
// never scores. Guard by URL, not filename, so a second promotion attempt files
// itself as a duplicate of the first instead of a sibling primary.
//
// findExistingFileForUrl + its terminal-canonical resolution live in
// scripts/lib/review-url-clusters.js so collect-review-texts.js's write path
// (BRO-3550) shares the exact same logic instead of a second, divergent copy.
function findExistingFileForUrl(showId, outletId, url, root = REVIEW_TEXTS_ROOT) {
  return findExistingFileForUrlShared(root, showId, outletId, url);
}

const PENDING_UNRECOVERABLE_STAGE = 'pending-unrecoverable';

// BRO-8023: scored urls by show, for the no-fetch triage (a stub whose url another show already scores).
let _heldIndexMemo = null;
function loadHeldIndex() {
  if (!_heldIndexMemo) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reviews.json'), 'utf8'));
      _heldIndexMemo = pendingTriage.buildHeldUrlIndex(r.reviews || r);
    } catch (e) { console.log(`  held-url index unavailable (${e.message}) — cross-show and host checks skipped`); _heldIndexMemo = null; return null; }
  }
  return _heldIndexMemo;
}

// Lazy: the router pulls in Resend/Linear plumbing; tests inject a fake.
async function defaultRouteAlert(opts) {
  return require('./lib/owner-alert-router').routeAlert(opts);
}

function defaultResolveCondition(key, opts) {
  return require('./lib/owner-alert-router').resolveCondition(key, opts);
}

/**
 * Pure: should this show's unrecoverable stubs page/digest the owner? Only in
 * the first post-opening week (when a missing T1/T2 review costs the most and
 * the stub is new) or when an operator/poller named the show explicitly. The
 * weekly --all-pending backlog sweep over hundreds of closed shows must not
 * open one alert condition per show.
 */
function shouldAlertUnrecoverable(show, { explicitScope = false, nowMs = Date.now() } = {}) {
  // Before opening, outlet review pages do not exist yet: an empty stub is
  // expected (the opening-night poller names pre-opening shows via --shows).
  const opening = show && show.openingDate ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(show.openingDate) ? `${show.openingDate}T00:00:00Z` : show.openingDate) : NaN;
  if (Number.isFinite(opening) && nowMs < opening) return false;
  return !!explicitScope || isInPostOpeningWindow(show, nowMs);
}

/** Pure: the routeAlert payload for one show's unrecoverable stubs. */
function unrecoverableAlertPayload(showId, entries) {
  const lines = entries.slice(0, 15).map(e => `- ${e.file} (${e.outletId || '?'}): ${e.reason} ${e.url || ''}`.trim());
  if (entries.length > 15) lines.push(`- …and ${entries.length - 15} more`);
  return {
    conditionKey: `${PENDING_UNRECOVERABLE_STAGE}:${showId}`,
    title: `${entries.length} review(s) for ${showId} stuck in _pending with no text and no byline`,
    description: `replay-pending-bylines.js could not recover these _pending stubs (no body, no byline, re-fetch gave nothing usable). Rebuild never reads _pending, so they are missing from the site.\n${lines.join('\n')}`,
    hint: `Open each URL, add the critic + text by hand (or fix the fetch), then rerun: node scripts/replay-pending-bylines.js --show=${showId}`,
    disposition: 'human',
    severity: 'warning',
    cooldownHours: 24,
  };
}

/**
 * A _pending stub is redundant once a primary file already carries its url
 * and the stub itself holds nothing a primary could lack: no byline, no text
 * (BRO-4271). Pure; `landedFile` is findExistingFileForUrl's result.
 */
function isRedundantPendingStub(data, landedFile) {
  if (!landedFile || !data) return false;
  const hasByline = data.criticName && String(data.criticName).toLowerCase() !== 'unknown';
  const hasText = typeof data.fullText === 'string' && data.fullText.trim().length > 0;
  // Anything a primary might lack keeps the stub: a score or an excerpt.
  const hasScore = data.originalScore != null && data.originalScore !== '';
  const hasExcerpt = Object.keys(data).some((k) => /Excerpt$/.test(k)
    && typeof data[k] === 'string' && data[k].trim().length > 0);
  return !hasByline && !hasText && !hasScore && !hasExcerpt;
}

/** BRO-8023: a filed primary whose body the rebuild would score (a real tier, no exclusion/body flag). Pure. */
function primaryBodyIsSound(primary) {
  if (!primary || typeof primary.fullText !== 'string' || !primary.fullText.trim()) return false;
  if (primary.wrongShow || primary.wrongProduction || primary.isRoundupArticle || primary.duplicateOf || primary.fullTextWrongAuthor) return false;
  return ['complete', 'truncated'].includes(primary.contentTier);
}
const SCORE_FIELDS = ['originalScore', 'aggregatorStars', 'assignedScore', 'llmScore', 'humanReviewScore'];
const present = (v) => v != null && v !== '';
/**
 * BRO-8023: why a text-bearing stub whose article a sound primary already files can be SETTLED (tagged, kept on
 * disk, never re-fetched), or null. 40 such 2025-26 stubs sat in _pending forever (the-heart thewrap--536994cc vs
 * thewrap--robert-hofler). Never deletes: two extractions of one article can differ, so the stub stays for a merge.
 * Same article = the canonical key (id query params kept); a score field the primary lacks keeps the stub open. Pure.
 */
function sameArticleSettleReason(data, primary, primaryFile) {
  if (!data || !primaryBodyIsSound(primary)) return null;
  // A named critic other than the primary's may be a second critic on one url (the duplicateOf path files that).
  const who = (x) => String(x || '').toLowerCase().replace(/[^a-z]+/g, '');
  if (who(data.criticName) && who(data.criticName) !== 'unknown' && who(data.criticName) !== who(primary.criticName)) return null;
  const { normalizeArticleUrl } = require('./lib/combined-review-utils');
  const a = normalizeArticleUrl(data.url), b = normalizeArticleUrl(primary.url);
  if (!a || a !== b) return null;
  if (SCORE_FIELDS.some((k) => present(data[k]) && !present(primary[k]))) return null;
  // An excerpt (a scoring fallback) the primary lacks keeps it open too.
  if (Object.keys(data).some((k) => /Excerpt$/.test(k) && typeof data[k] === 'string' && data[k].trim() && !present(primary[k]))) return null;
  const len = (t) => (typeof t === 'string' ? t.trim().length : 0);
  return `same article already filed as ${primaryFile} (stub body ${len(data.fullText)} chars vs primary ${len(primary.fullText)}; not merged) (BRO-8023)`;
}

// BRO-7078: failed fetches before a no-identity rss stub is tagged.
const RSS_IDENTITY_FETCH_STRIKES = 3;

/**
 * True when the url's last word-slug has 3+ words and no review/theatre cue,
 * e.g. paul-mccartney-upcoming-beatles-biopics. Numeric ids and short slugs
 * carry no evidence either way (BRO-7078).
 */
/**
 * BRO-8023: record that the drain fetched this stub and could not promote it (first time only, so a weekly
 * re-try does not churn the file). The floors report counts such a stub as an attempted gap, not a never-worked one.
 */
function stampFetchAttempt(filepath, data, dry, nowIso, why) {
  if (dry || !data || data.pendingFetchAttemptedAt) return;
  data.pendingFetchAttemptedAt = nowIso;
  data.pendingFetchAttemptResult = why;
  try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  could not stamp fetch attempt: ${e.message}`); }
}

function isDescriptiveNonReviewSlug(url) {
  let parts;
  try { parts = new URL(String(url || '')).pathname.split('/').filter(Boolean); } catch { return false; }
  const slug = parts.reverse().find(p => /[a-z]/i.test(p) && p.includes('-')) || '';
  if (slug.split('-').filter(w => /[a-z]/i.test(w)).length < 3) return false;
  return !/review|theat|stage|musical|opera|play|critic|ballet|danc|broadway|west-?end/i.test(slug);
}

/**
 * @param {string} showId
 * @param {object} [deps] injectable for tests (BRO-2735): root, show, fetch
 *   (fetchPage-compatible), alert (routeAlert-compatible), emit (emitStage-
 *   compatible), dryRun, budget, explicitScope, now (() => Date), log,
 *   files (BRO-4408: newest-first file order from planPendingWork).
 */
async function processShow(showId, deps = {}) {
  const root = deps.root || REVIEW_TEXTS_ROOT;
  const fetchPageImpl = deps.fetch || runFetchCache;
  const alert = deps.alert || defaultRouteAlert;
  const emit = deps.emit || emitStage;
  const dry = deps.dryRun !== undefined ? deps.dryRun : dryRun;
  const budget = deps.budget || timeBudget;
  const explicitScope = deps.explicitScope !== undefined ? deps.explicitScope : !!(showArg || showsArg);
  const now = deps.now || (() => new Date());
  const triageOnlyRun = deps.triageOnly !== undefined ? deps.triageOnly : triageOnly;
  // Tests that inject a root also inject (or skip) the index; never read the live reviews.json for them.
  const heldIndex = deps.heldIndex !== undefined ? deps.heldIndex : (deps.root ? null : loadHeldIndex());
  const pendingDir = path.join(root, '_pending', showId);
  if (!fs.existsSync(pendingDir)) {
    console.log(`[${showId}] no _pending dir`);
    return { promoted: 0, kept: 0, rejected: 0, unrecoverable: 0, refetched: 0, tagged: 0, inspected: 0, candidates: 0, lastFile: null };
  }
  const show = deps.show !== undefined ? deps.show : loadShow(showId);
  const openingYear = show?.openingDate ? new Date(show.openingDate).getFullYear() : null;
  const files = deps.files || fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  console.log(`[${showId}] ${files.length} pending files to inspect (opening ${show?.openingDate || '?'})`);

  let promoted = 0, kept = 0, rejected = 0, droppedRedundant = 0, refetched = 0;
  // BRO-7930: stubs newly settled (tagged junk, skipped-with-reason) this run, the files looked at, and the
  // last file reached (the rotation cursor). A run that inspects files and settles none is a "zero run".
  let tagged = 0, inspected = 0, lastFile = null;
  let candidates = 0; // BRO-8023: stubs only a fetch can judge (left untouched by --triage-only)
  const redundantCopies = {}; // BRO-7945: settled out-of-window copies by kind (sibling | outside-all)
  // Zero-text + no-byline stubs replay could not recover (BRO-2735). Reported
  // after the loop — never a silent "keep".
  const unrecoverable = [];
  const noteUnrecoverable = (file, filepath, data, reason) => {
    // BRO-7078 (The Ask, BRO-6061): an rss stub filed before the identity rule
    // tightened (BRO-5627) kept alerting after the rule held for new input.
    // Once it is unrecoverable anyway, replay the CURRENT rule on its stored
    // headline; a stub with no headline has no evidence and stays reported.
    // A thrown fetch (timeout, block) may be transient and the tag is
    // permanent, so a failed fetch tags only on its third separate run.
    // Evidence is a stored headline, or (no headline, as on the real BRO-6061
    // stub) a descriptive url slug with no review cue that never names the show.
    const identityFails = data.source === 'rss-discovery' && show?.title
      && (data.title || data.articleTitle || isDescriptiveNonReviewSlug(data.url))
      && !require('./lib/rss-discovery').rssStubIdentityOk(data, show.title);
    let identityFinal = identityFails;
    if (identityFails && /^fetch (failed|returned no content)/.test(reason)) { // transient: 3 strikes (BRO-7078 review P2)
      const n = (Number(data.rssIdentityFetchFailures) || 0) + 1;
      identityFinal = n >= RSS_IDENTITY_FETCH_STRIKES;
      if (!identityFinal && !dry) {
        data.rssIdentityFetchFailures = n;
        try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not count strike: ${e.message}`); }
      }
    }
    if (identityFinal) {
      console.log(`  [${file}] rss identity reject at replay (headline/slug no longer match "${show.title}") — tagged, not a stuck review`);
      if (!dry) {
        data.rssIdentityRejected = true;
        data.rssIdentityRejectedReason = 'unrecoverable and no title/slug match to show at replay (BRO-7078)';
        data.rssIdentityRejectedAt = now().toISOString();
        try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
      }
      return;
    }
    console.log(`  [${file}] UNRECOVERABLE: no text, no byline (${reason}) — kept in _pending, reported below`);
    unrecoverable.push({ file, filepath, data, reason, outletId: data.outletId || null, url: data.url || null });
  };
  // A triage-only pass never fetches, so it cannot know a show has no unrecoverable stubs: never resolve on it.
  const finish = (extra = {}) => ({ promoted, kept, rejected, droppedRedundant, refetched, tagged, inspected, lastFile, redundantCopies, candidates, ...reportUnrecoverable(!extra.budgetExceeded && !triageOnlyRun), ...extra });
  const reportUnrecoverable = (scanComplete = false) => {
    if (unrecoverable.length === 0) {
      // BRO-6338: a full scan with nothing unrecoverable closes the show's alert
      // condition, so the folded digest card's check-alert-condition-absent can pass.
      if (scanComplete && !dry) {
        try { (deps.resolve || defaultResolveCondition)(`${PENDING_UNRECOVERABLE_STAGE}:${showId}`, { reason: 'no unrecoverable _pending stubs on a complete scan' }); } catch (e) { console.log(`  resolve failed: ${e.message}`); }
      }
      return { unrecoverable: 0 };
    }
    const alertable = shouldAlertUnrecoverable(show, { explicitScope, nowMs: now().getTime() });
    console.log(`  ⚠ [${showId}] ${unrecoverable.length} pending-unrecoverable stub(s)${alertable ? '' : ' (outside post-opening week — logged, not alerted)'}`);
    if (!alertable) {
      // BRO-7078: outside the alert window nothing re-checks this show's condition,
      // so one opened in the post-opening week stayed open forever (18 of 41 open
      // pending-unrecoverable conditions were past their window). A complete scan
      // that would not alert closes it; the stubs stay listed in the log.
      if (scanComplete && !dry) {
        try { (deps.resolve || defaultResolveCondition)(`${PENDING_UNRECOVERABLE_STAGE}:${showId}`, { reason: 'outside the post-opening alert window on a complete scan' }); } catch (e) { console.log(`  resolve failed: ${e.message}`); }
      }
      return { unrecoverable: unrecoverable.length, alerted: false };
    }
    for (const u of unrecoverable) {
      if (u.data.pendingUnrecoverableAt) continue; // one stage event per stub, not per run
      if (dry) { console.log(`  DRY → would emit ${PENDING_UNRECOVERABLE_STAGE} for ${u.file}`); continue; }
      emit({
        showId, stage: PENDING_UNRECOVERABLE_STAGE,
        reviewKey: `${u.outletId || 'unknown'}:unknown:${u.url || u.file}`,
        metadata: { file: u.file, reason: u.reason, outletId: u.outletId, url: u.url, source: 'replay-pending-bylines' },
      });
      u.data.pendingUnrecoverableAt = now().toISOString();
      try { fs.writeFileSync(u.filepath, JSON.stringify(u.data, null, 2)); } catch (e) { console.log(`  [${u.file}] could not stamp: ${e.message}`); }
    }
    const payload = unrecoverableAlertPayload(showId, unrecoverable);
    if (dry) {
      console.log(`  DRY → would routeAlert(${payload.conditionKey}, disposition ${payload.disposition})`);
      return { unrecoverable: unrecoverable.length, alerted: false };
    }
    // Fire-and-record; an alert failure must not abort the drain of other shows.
    const sent = Promise.resolve().then(() => alert(payload)).catch(e => console.log(`  alert failed: ${e.message}`));
    return { unrecoverable: unrecoverable.length, alerted: true, alertPromise: sent };
  };
  for (const file of files) {
    if (budget.exceeded()) {
      console.log(`  ⏱ Time budget (${budget.minutes} min) reached — remaining files (and shows) deferred to next run.`);
      return finish({ budgetExceeded: true });
    }
    const filepath = path.join(pendingDir, file);
    lastFile = file;
    let data;
    try { data = JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch (e) {
      // BRO-7930: one unreadable stub must not wedge the sweep before its cursor is saved.
      console.log(`  [${file}] unreadable (${e.message}) — skipped`);
      kept++;
      continue;
    }
    // Already evaluated and skipped on a prior run — don't re-fetch the URL. Not counted as inspected:
    // settled junk stays in _pending forever and would make a healthy quiet drain look stalled.
    if (data.promoteSkippedReason) {
      kept++;
      continue;
    }
    inspected++;
    // Tagged by sweep-rss-pending-junk.js (task #1073): the pre-fix RSS
    // openingWindow branch attributed unrelated theater-section articles
    // (obituaries, awards coverage) to whatever show opened that week. These
    // fail the identity check permanently — never fetch, never count as
    // drain candidates.
    if (data.rssIdentityRejected) {
      kept++;
      continue;
    }
    // BRO-7078: a stub filed at an off-topic section URL (film/TV review
    // section, sport, obituary) before discovery refused them is never a
    // review: skip it without a fetch and never report it unrecoverable.
    const offTopic = require('./lib/non-review-url-patterns').offTopicSectionReason(data.url);
    if (offTopic) {
      console.log(`  [${file}] ${offTopic} URL — not a review, skipped without fetch`);
      if (!dry) {
        data.promoteSkippedReason = `${offTopic} URL, not a review (BRO-7078)`;
        data.promoteSkippedAt = now().toISOString();
        try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
      }
      tagged++;
      kept++;
      continue;
    }
    // BRO-6321: an rss-discovery stub whose headline AND url slug do not name the
    // show (celebrity-baby news filed under the musical "Baby") is junk, not a
    // stuck review. Tag it like the sweep does so it never reaches the alert.
    // Other titles are re-judged only once the stub proves unrecoverable
    // (noteUnrecoverable, BRO-7078), so a tag never stops a fetch that could work.
    if (data.source === 'rss-discovery' && show?.title && require('./lib/generic-title-guard').genericSingleWordTitle(show.title)) {
      const identityOk = require('./lib/rss-discovery').rssStubIdentityOk(data, show.title);
      if (!identityOk) {
        console.log(`  [${file}] rss identity reject (no title/slug match to "${show.title}") — tagged, not a stuck review`);
        if (!dry) {
          data.rssIdentityRejected = true;
          data.rssIdentityRejectedReason = 'no title/slug match to show at replay (BRO-6321)';
          data.rssIdentityRejectedAt = now().toISOString();
          try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
        }
        tagged++;
        kept++;
        continue;
      }
    }
    // BRO-7930: a stub whose url names no identity for a numeric / 1-2 letter / generic bare title ("13", "G", "Da",
    // "The Story") is a discovery fluke (Daily Mail restaurant pages under 44-off-broadway-2025), never a stuck review.
    if (show?.title && require('./lib/generic-title-guard').genericSingleWordTitle(show.title, { shortNumeric: true })
        && !require('./lib/generic-title-guard').passesGenericTitleIdentity(data.url || '', show.title, { shortNumeric: true })
        && !(data.source === 'submit-review-form' || data.source === 'manual-user-request')) {
      console.log(`  [${file}] url carries no identity for the bare title "${show.title}" — tagged, not a stuck review (BRO-7930)`);
      if (!dry) {
        data.promoteSkippedReason = `url has no identity for the bare title "${show.title}" (BRO-7930)`;
        data.promoteSkippedAt = now().toISOString();
        try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
      }
      tagged++;
      kept++;
      continue;
    }
    const url = data.url;
    if (!url) {
      console.log(`  [${file}] no URL — skip`);
      if (isUnrecoverablePendingStub(data, null)) noteUnrecoverable(file, filepath, data, 'no URL to re-fetch');
      kept++;
      continue;
    }

    // Already landed (BRO-4271): a byline-less textless stub whose url a
    // primary file for this show already carries is a leftover, not a pending
    // review. School Girls 2026 kept two such nysr--<hash> stubs after the BWW
    // roundup created nysr--steven-suskin / nysr--frank-scheck from the same
    // urls; they had to be deleted by hand. A stub with text is kept.
    const landed = findExistingFileForUrl(showId, data.outletId, url, root);
    let landedData = null;
    if (landed) { try { landedData = JSON.parse(fs.readFileSync(path.join(root, showId, landed), 'utf8')); } catch { landedData = null; } }
    if (isRedundantPendingStub(data, landed)) {
      console.log(`  [${file}] url already filed as ${landed} — dropping textless pending stub`);
      if (!dry) fs.unlinkSync(filepath);
      droppedRedundant++;
      continue;
    }

    const settle = landed ? sameArticleSettleReason(data, landedData, landed) : null;
    if (settle) {
      console.log(`  [${file}] ${settle} — tagged, not fetched`);
      if (!dry) {
        data.promoteSkippedReason = settle;
        data.promoteSkippedAt = now().toISOString();
        try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
      }
      tagged++;
      kept++;
      continue;
    }

    // BRO-8023: the no-fetch triage. A url another show already scores, a non-review section/listing, or a
    // stub date outside the production window is settled here (tagged, KEPT), never fetched.
    const tri = pendingTriage.triagePendingStub(data, { showId, show, heldIndex, showTitleOf: (id) => ((deps.allShows || (deps.root ? [] : loadAllShows())).find(sh => sh.id === id) || {}).title });
    if (tri.verdict === 'junk') {
      console.log(`  [${file}] triage: ${tri.reason} — tagged, not fetched (BRO-8023)`);
      if (!dry) {
        data.promoteSkippedReason = `${tri.reason} (BRO-8023 triage)`;
        data.promoteSkippedAt = now().toISOString();
        try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
      }
      tagged++;
      kept++;
      continue;
    }

    // Pre-promotion filters: don't bother fetching wrong-production URLs.
    if (NON_MET_OPERA_URL_MARKERS && hasNonMetOperaUrlMarker(url, operaHouseForVenue((loadShow(showId) || {}).venue)).rejected) {
      console.log(`  [${file}] REJECT: non-Met opera house URL — ${dry ? 'DRY, not deleting' : 'deleting'}`);
      if (!dry) fs.unlinkSync(filepath);
      rejected++;
      continue;
    }
    if (openingYear) {
      const badYear = require('./lib/url-year-guard').urlYearConflict(url, openingYear, show?.title);
      if (badYear) {
        console.log(`  [${file}] REJECT: URL year ${badYear} > ±1y from ${openingYear} — ${dry ? 'DRY, not deleting' : 'deleting'}`);
        if (!dry) fs.unlinkSync(filepath);
        rejected++;
        continue;
      }
    }

    if (triageOnlyRun) { candidates++; kept++; continue; } // BRO-8023: a fetch candidate, left for the fetching drain

    let byline = null;
    let html = null;
    let publishDate = null;
    let fetchResult = null;
    try {
      const result = await fetchPageImpl(url);
      fetchResult = result;
      html = result?.content;
      if (!html) {
        console.log(`  [${file}] fetch returned no content — keep`);
        stampFetchAttempt(filepath, data, dry, now().toISOString(), 'no-content');
        if (isUnrecoverablePendingStub(data, null)) noteUnrecoverable(file, filepath, data, 'fetch returned no content');
        kept++;
        continue;
      }
      publishDate = extractPublishDate(html, url);
      // Validate BEFORE promoting. _pending for open shows holds junk beyond real
      // stranded reviews (Beetlejuice exposed this 2026-06-04): aggregator URLs
      // misattributed to an outlet (a westendtheatre roundup filed under 'telegraph'
      // fabricates a fake Telegraph review with the roundup author's byline), same-title
      // wrong-production articles (the Beetlejuice *film* / a Tim Burton interview filed
      // under 'times-uk'), and wrong-show hits. Promoting these contaminates the show.
      const rejectReason = pendingPromoteRejectReason(url, html, show, publishDate);
      if (rejectReason) {
        // KEEP, never delete. The URL-level checks have false positives (outlets file
        // real theatre reviews under odd sections; verifyAggregatorUrl can miss on opaque
        // slugs). Deleting was irreversible data loss (ship-check 2026-06-05). Annotate so
        // future cron runs skip it without re-fetching, and leave it in _pending for a
        // human / better tooling — promotion just doesn't happen.
        // BRO-7945: an out-of-window copy whose date sits inside a same-title sibling's window belongs to that
        // sibling's copy (processed on its own turn from the cached fetch); settle this one so it is never
        // re-judged. Outside every same-title window = settled junk. Both stay on disk (never delete).
        let settle = null;
        if (/is outside this production's window|date-out-of-window/.test(rejectReason)) {
          const sib = siblingForArticle(show, deps.allShows || loadAllShows(), publishDate,
            { hasCopy: (sid) => { // the sibling's copy exists and has not itself been settled
              try { return !JSON.parse(fs.readFileSync(path.join(root, '_pending', sid, file), 'utf8')).promoteSkippedReason; } catch { return false; }
            } });
          settle = sib
            ? { kind: 'sibling', reason: `${rejectReason}; belongs to same-title production ${sib.id}, whose _pending copy carries it (BRO-7945)`, sibling: sib.id }
            : { kind: 'outside-all', reason: rejectReason };
          redundantCopies[settle.kind] = (redundantCopies[settle.kind] || 0) + 1;
        }
        console.log(`  [${file}] SKIP (kept in _pending): ${settle ? settle.reason : rejectReason}`);
        data.promoteSkippedReason = settle ? settle.reason : rejectReason;
        if (settle) { data.promoteSettled = settle.kind; if (settle.sibling) data.promoteSettledSibling = settle.sibling; }
        data.promoteSkippedAt = new Date().toISOString();
        if (!dry) fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        tagged++;
        kept++;
        continue;
      }
      // BRO-7798: shared reader first, meta fallback unless an outlet rule said "nobody" (the meta
      // tags hold the posting editor there).
      byline = readPageBylineWithMetaFallback({ html, url: data.url, outletId: data.outletId });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 80);
      console.log(`  [${file}] fetch failed: ${msg} — keep`);
        stampFetchAttempt(filepath, data, dry, now().toISOString(), 'fetch-failed');
      if (isUnrecoverablePendingStub(data, null)) noteUnrecoverable(file, filepath, data, `fetch failed: ${msg}`);
      kept++;
      continue;
    }

    // Re-fetch path (BRO-2735): a stub with a URL but no body is REBUILT from
    // this fetch — a fresh record carrying only the stub's identity/provenance
    // fields plus the recovered body — never patched field-by-field. The
    // recoveryPatch gates (show-match, production window, tier) are the same
    // ones the landed-stub empty-body retry uses.
    if (isZeroTextPendingStub(data)) {
      const hasNamedByline = byline && byline !== 'Unknown';
      const patch = recoveryPatch(hasNamedByline ? { ...data, criticName: byline } : data, fetchResult, show);
      if (patch) {
        data = buildRefetchedPendingRecord(data, patch, now().toISOString());
        refetched++;
        console.log(`  [${file}] re-fetched body rebuilt (${patch.wordCount || '?'} words, ${patch.contentTier})`);
      }
    }

    // BRO-8023: the byline is the show's own playwright/composer: a venue or listing page, never a review.
    if (byline && pendingTriage.bylineIsShowCreator(byline, show)) {
      console.log(`  [${file}] byline "${byline}" is on the show's creative team — not a review, tagged`);
      if (!dry) {
        data.promoteSkippedReason = `page byline "${byline}" is the show's own creative team, not a critic (BRO-8023)`;
        data.promoteSkippedAt = now().toISOString();
        try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
      }
      tagged++;
      kept++;
      continue;
    }

    if (!byline || byline === 'Unknown') {
      if (isUnrecoverablePendingStub(data, null)) {
        noteUnrecoverable(file, filepath, data, 'no byline in page and no recoverable body');
      } else {
        console.log(`  [${file}] no byline detected — keep in pending`);
        if (!data.pendingRefetchedAt) stampFetchAttempt(filepath, data, dry, now().toISOString(), 'no-byline');
        // A rebuilt body is still progress: persist it so the next run (or a
        // human) starts from the text, not an empty stub.
        if (data.pendingRefetchedAt && !dry) fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      }
      kept++;
      continue;
    }

    // Promote: rename to {outlet}--{critic-slug}.json + move to review-texts/{showId}/
    const criticSlug = normalizeCritic(byline);
    const newFilename = `${data.outletId}--${criticSlug}.json`;
    const newPath = path.join(root, showId, newFilename);

    // Don't overwrite an existing real file
    if (fs.existsSync(newPath)) {
      // BRO-7930: settle it instead of keeping it forever (43 of ~82 unresolved open-show stubs).
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(newPath, 'utf8')); } catch { /* unreadable primary: fall through to keep */ }
      const verdict = existing ? classifyTargetCollision(data, existing) : null;
      // Only drop a stub that carries nothing the primary lacks (no score / excerpt / longer body).
      if (verdict === 'same-article' && isRedundantPendingStub(data, newFilename)) {
        console.log(`  [${file}] ${dry ? 'DRY → would drop' : 'dropping'}: ${newFilename} already carries this article`);
        if (!dry) fs.unlinkSync(filepath);
        droppedRedundant++;
        continue;
      }
      if (verdict === 'different-article') {
        console.log(`  [${file}] ${newFilename} is the same critic's OTHER article — tagged, cannot take that filename`);
        if (!dry) {
          data.promoteSkippedReason = `byline resolves to ${newFilename}, which already holds a different article (BRO-7930)`;
          data.promoteSkippedAt = now().toISOString();
          try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
        }
        tagged++;
        kept++;
        continue;
      }
      const settleAfter = verdict === 'same-article' ? sameArticleSettleReason(data, existing, newFilename) : null;
      if (settleAfter) {
        console.log(`  [${file}] ${settleAfter} — tagged`);
        if (!dry) {
          data.promoteSkippedReason = settleAfter;
          data.promoteSkippedAt = now().toISOString();
          try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
        }
        tagged++;
        kept++;
        continue;
      }
      console.log(`  [${file}] would-be target ${newFilename} already exists — keep pending`);
      if (data.pendingRefetchedAt && !dry) fs.writeFileSync(filepath, JSON.stringify(data, null, 2)); // keep the rebuilt body
      kept++;
      continue;
    }

    // Same URL already promoted under a DIFFERENT critic name (rotating-byline
    // outlets like Times UK / WhatsOnStage) — file this as a duplicate instead
    // of a second primary. Prevents byline-explosion clusters at the source.
    const existingSameUrl = findExistingFileForUrl(showId, data.outletId, url, root);
    if (existingSameUrl && existingSameUrl !== newFilename) {
      data.criticName = byline;
      data.bylineSource = 'replay-pending-bylines';
      data.bylineExtractedAt = new Date().toISOString();
      data.duplicateOf = existingSameUrl;
      data.duplicateTextOf = existingSameUrl;
      data.duplicateReason = 'same-url-different-byline-extraction';
      if (publishDate && !data.publishDate) data.publishDate = publishDate;
      if (dry) {
        console.log(`  [${file}] DRY → would file as duplicateOf ${existingSameUrl} (byline: ${byline}, same URL already promoted)`);
        promoted++;
        continue;
      }
      if (!fs.existsSync(path.dirname(newPath))) fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
      fs.unlinkSync(filepath);
      console.log(`  [${file}] PROMOTED as duplicateOf ${existingSameUrl} → ${newFilename} (byline: ${byline}, same URL already promoted)`);
      promoted++;
      continue;
    }

    // BRO-7930: do not promote a file the rebuild would exclude on arrival (blocked/listing/non-review url, wrong production).
    const blockRule = promotionBlockRule({ ...data, criticName: byline, publishDate: data.publishDate || publishDate }, show, newPath);
    if (blockRule) {
      console.log(`  [${file}] ${dry ? 'DRY → would not promote' : 'not promoted'}: rebuild would exclude it (${blockRule}) — tagged`);
      if (!dry) {
        data.promoteSkippedReason = `rebuild would exclude the promoted file (${blockRule}) (BRO-7930)`;
        data.promoteSkippedAt = now().toISOString();
        try { require('./lib/review-write-guard').safeWriteReview(filepath, data); } catch (e) { console.log(`  [${file}] could not tag: ${e.message}`); }
      }
      tagged++;
      kept++;
      continue;
    }
    data.criticName = byline;
    data.bylineSource = 'replay-pending-bylines';
    data.bylineExtractedAt = new Date().toISOString();
    markEmptyBodyForRetry(data);
    // Persist the extracted date. The pre-fix promoted files carried
    // publishDate:null, so the downstream date guards (flag-wrong-production-by-date)
    // could not re-catch a wrong-production leak post-promotion either. Writing it
    // here closes both the promotion gate AND that second-layer gap.
    if (publishDate && !data.publishDate) data.publishDate = publishDate;

    if (dry) {
      console.log(`  [${file}] DRY → would promote to ${newFilename} (byline: ${byline})`);
      promoted++;
      continue;
    }

    if (!fs.existsSync(path.dirname(newPath))) fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
    fs.unlinkSync(filepath);
    console.log(`  [${file}] PROMOTED → ${newFilename} (byline: ${byline})`);
    promoted++;
  }

  return finish();
}

/** Count every .json file under _pending/<show>/ (the number the "growing" alert watches). */
function countPendingFiles(root = PENDING_ROOT) {
  let n = 0;
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try { n += fs.readdirSync(path.join(root, d.name)).filter(f => f.endsWith('.json')).length; } catch { /* unreadable */ }
    }
  } catch { /* no _pending */ }
  return n;
}

/** BRO-7930: alert when sweeps resolve nothing for N runs, or when _pending keeps growing; resolve when healthy. */
async function raiseDrainHealthAlerts(history, deps = {}) {
  const alert = deps.alert || defaultRouteAlert;
  const resolve = deps.resolve || defaultResolveCondition;
  const h = drainState.evaluateDrainHealth(history);
  const last = history[history.length - 1] || {};
  const conds = [
    ['pending-drain-zero-promote', h.zeroPromote, {
      title: `_pending drain resolved nothing for ${h.zeroRuns} sweeps in a row`,
      description: `replay-pending-bylines.js inspected files but promoted, dropped, rejected or tagged none for ${h.zeroRuns} consecutive --all-open/--all-pending runs (_pending holds ${last.pending}). The drain is stuck or starved.`,
      hint: 'Read the last enrich-reviews "Drain pending" step log; run node scripts/replay-pending-bylines.js --all-open --dry-run.',
    }],
    ['pending-drain-growth', h.growth, {
      title: `_pending grew by ${h.delta} files over ${drainState.GROWTH_RUNS} sweeps`,
      description: `The _pending backlog rose on every one of the last ${drainState.GROWTH_RUNS} sweeps (now ${last.pending}): intake is outrunning the drain, or a discovery path is writing junk.`,
      hint: 'Check which show dirs grew: du over data/review-texts/_pending; look for a bare-title show (generic-title-guard).',
    }],
  ];
  for (const [conditionKey, firing, body] of conds) {
    try {
      if (firing) await alert({ conditionKey, ...body, disposition: 'digest', severity: 'warning', cooldownHours: 24 });
      else await resolve(conditionKey, { reason: 'drain healthy on the latest sweep' });
    } catch (e) { console.log(`  drain alert ${conditionKey} failed: ${e.message}`); }
  }
  return h;
}

module.exports = {
  inShard,
  pendingPromoteRejectReason,
  NON_THEATRE_SECTIONS,
  findExistingFileForUrl,
  isRedundantPendingStub,
  primaryBodyIsSound,
  sameArticleSettleReason,
  // Liveness of the --all-open scope (audit S7-T7) — exported for
  // tests/unit/show-liveness.test.mjs.
  PENDING_DRAIN_LIVE_STATUSES,
  pendingDrainLivenessOptions,
  isPendingDrainEligible,
  parseClosedWithinDays,
  // BRO-2735
  processShow,
  shouldAlertUnrecoverable,
  unrecoverableAlertPayload,
  PENDING_UNRECOVERABLE_STAGE,
  // BRO-7930
  planPendingWork,
  countPendingFiles,
  raiseDrainHealthAlerts,
};

if (require.main === module) {
  (async () => {
    const ids = showIds();
    // BRO-3999: landed textless stubs are outside _pending, including shows
    // with NO pending directory. The existing opening-night and 6-hourly /
    // weekly enrichment callers persist these repairs in the private repo.
    const showData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
    const shows = showData.shows || showData;
    const retryIds = allPending ? undefined : allOpen
      ? shows.filter(show => isPendingDrainEligible(show, closedWithinDays)).map(show => show.id)
      : ids;
    // --skip-empty-body-retry (BRO-7004): the poller's per-show press-night drain shares timeBudget
    // with this phase, so a retry pass could spend the whole budget before the first _pending stub.
    // A shard runs beside its siblings: the shared retry phase would fetch the same stubs n times (BRO-8023).
    if (!args.includes('--skip-empty-body-retry') && !triageOnly && !shardArg) await retryEmptyBodyReviews({ root: REVIEW_TEXTS_ROOT, shows, showIds: retryIds, dryRun,
      cooldownHours: showArg || showsArg ? 1 : 6,
      budget: createRunBudget(Math.min(2, timeBudget.minutes || 2)) });
    const scopeNote = allOpen && closedWithinDays > 0 ? ` (open/previews + closed within ${closedWithinDays}d)` : '';
    console.log(`Processing ${ids.length} show(s)${scopeNote}${dryRun ? ' [DRY RUN]' : ''}\n`);

    let totalPromoted = 0, totalKept = 0, totalRejected = 0, totalDropped = 0, totalUnrecoverable = 0, totalRefetched = 0, totalTagged = 0, totalInspected = 0, totalCandidates = 0;
    const alertPromises = [];
    const settledTotals = {}; // BRO-7945: out-of-window copies settled this run (sibling | outside-all)
    // BRO-7930: sweeps rotate from a persisted cursor; the poller / --show runs stay newest-first.
    // BRO-8023: a triage-only or era-scoped batch is not a sweep: it must not move the rotation cursors or
    // write a drain-health history row (a no-fetch run would read as a zero-promote sweep).
    const sweep = (allOpen || allPending) && !triageOnly && !eraArg && !shardArg;
    const state = sweep ? drainState.loadState(REVIEW_TEXTS_ROOT) : null;
    const cursorPrefix = allPending ? '' : 'open_';
    // Recent = opened in the last 2 years (the owner's no-gaps scope), through the shared show data.
    const showById = new Map(shows.map(sh => [sh.id, sh]));
    const RECENT_MS = 730 * 864e5;
    const tierOf = id => { const o = Date.parse((showById.get(id) || {}).openingDate || ''); return Number.isFinite(o) && Date.now() - o <= RECENT_MS ? 'recent' : 'other'; };
    let plan, tierEnds = {};
    if (sweep) {
      const recentFirst = state.turn % 2 === 0;
      // --all-open and --all-pending walk different subsets: each keeps its own cursors so one cannot reset the other's pass.
      const t = rotateTiered(planPendingWork(ids, { raw: true }), { cursors: { recent: state.cursors[cursorPrefix + 'recent'] || null, other: state.cursors[cursorPrefix + 'other'] || null }, tierOf, recentFirst });
      plan = t.work; tierEnds = t.tierEnds;
      console.log(`Rotation: ${plan.reduce((n, p) => n + p.files.length, 0)} file(s) queued (${recentFirst ? 'recent-show files first' : 'older-show files first'}), cursors recent=${state.cursors[cursorPrefix + 'recent'] || '(top)'} other=${state.cursors[cursorPrefix + 'other'] || '(top)'}`);
    } else plan = planPendingWork(ids);
    const reached = { recent: null, other: null };
    let completedPass = true;
    for (const { showId: id, files } of plan) {
      const { promoted, kept, rejected, droppedRedundant, budgetExceeded, unrecoverable, refetched, tagged, inspected, lastFile, redundantCopies, alertPromise, candidates } = await processShow(id, { files });
      totalCandidates += candidates || 0;
      for (const [k, n] of Object.entries(redundantCopies || {})) settledTotals[k] = (settledTotals[k] || 0) + n;
      totalPromoted += promoted;
      totalKept += kept;
      totalRejected += rejected || 0;
      totalDropped += droppedRedundant || 0;
      totalUnrecoverable += unrecoverable || 0;
      totalRefetched += refetched || 0;
      totalTagged += tagged || 0;
      totalInspected += inspected || 0;
      if (lastFile) reached[tierOf(id)] = pathKey(id, lastFile);
      if (alertPromise) alertPromises.push(alertPromise);
      if (budgetExceeded) { completedPass = false; break; }
    }
    await Promise.all(alertPromises);

    console.log(`\n━━━ Replay complete ━━━`);
    console.log(`Promoted: ${totalPromoted}`);
    console.log(`Rejected (wrong-prod or wrong-year, deleted): ${totalRejected}`);
    console.log(`Dropped (url already filed, stub had nothing extra): ${totalDropped}`);
    console.log(`Tagged as settled junk (skipped from now on): ${totalTagged}`);
    console.log(`Kept in _pending: ${totalKept}`);
    console.log(`  of which re-fetched body rebuilt: ${totalRefetched}`);
    console.log(`  out-of-window copies settled (BRO-7945): ${JSON.stringify(settledTotals)}; fetch requests ${runFetchCache.stats().calls}, unique URLs fetched ${runFetchCache.stats().unique} (cache hits ${runFetchCache.stats().cacheHits})`);
    console.log(`  of which UNRECOVERABLE (no text, no byline — see alerts above): ${totalUnrecoverable}`);
    if (triageOnly) console.log(`  of which fetch candidates (triage-only, not fetched): ${totalCandidates}`);

    if (sweep) {
      // A tier that reached its last file finished its pass: its cursor resets so the next run starts at the top.
      // Otherwise it resumes after the last file reached. A tier not reached this run keeps its cursor.
      const nextCursors = { ...state.cursors };
      for (const tier of ['recent', 'other']) {
        if (reached[tier]) nextCursors[cursorPrefix + tier] = tierEnds[tier] && reached[tier] >= tierEnds[tier] ? null : reached[tier];
      }
      const pending = countPendingFiles();
      console.log(`Rotation: ${completedPass ? 'every queued file reached' : 'budget hit'}; next cursors recent=${nextCursors[cursorPrefix + 'recent'] || '(top)'} other=${nextCursors[cursorPrefix + 'other'] || '(top)'}; _pending now holds ${pending} file(s)`);
      if (!dryRun) {
        state.cursors = nextCursors;
        state.turn = (state.turn || 0) + 1;
        state.history.push({ at: new Date().toISOString(), scope: allPending ? 'all-pending' : 'all-open', promoted: totalPromoted, dropped: totalDropped, rejected: totalRejected, tagged: totalTagged, inspected: totalInspected, pending });
        drainState.saveState(REVIEW_TEXTS_ROOT, state);
        await raiseDrainHealthAlerts(state.history);
        // BRO-7930 limbo gate: every unflagged, unscored file older than the grace window gets a route.
        try {
          const { routeLimbo } = require('./lib/route-limbo');
          const r = routeLimbo({ apply: true, log: console.log });
          const stuck = r.counts.stuckRefetch || 0;
          try {
            if (stuck > 0) await defaultRouteAlert({ conditionKey: 'limbo-refetch-stuck', title: `${stuck} review file(s) routed to refetch 14+ days ago still have no scorable text`, description: 'route-limbo-reviews.js routed these files to refetch and the collector did not recover a scorable body. Run: node scripts/route-limbo-reviews.js --all-shows --list | grep refetch', hint: 'Open each URL; fix the extractor or mark the file rejected.', disposition: 'digest', severity: 'warning', cooldownHours: 72 });
            else defaultResolveCondition('limbo-refetch-stuck', { reason: 'no stuck refetch-routed limbo files' });
          } catch (e) { console.log(`  limbo alert failed: ${e.message}`); }
          console.log(`Limbo gate: ${r.counts.routed} routed (${JSON.stringify(r.counts.byRoute)}), ${r.counts.grace} still inside the ${r.graceDays}-day grace window`);
        } catch (e) { console.log(`Limbo gate failed: ${e.message}`); }
      }
    }
  })().catch(e => {
    console.error(e);
    process.exitCode = 1;
  }).finally(cleanup);
}
