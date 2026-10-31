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
 *   3. Extracts byline via existing extractAuthorFromHtml
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
const { extractAuthorFromHtml, extractHighConfidenceAuthor } = require('./lib/content-quality');
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
const { pendingFileTimestamp, orderPendingWork } = require('./lib/pending-drain-order');

// Newest strands first (BRO-4408), so a budget-limited run reaches a fresh
// opening-night review before re-fetching old no-byline strands.
function planPendingWork(ids) {
  const shows = ids.map(showId => {
    const dir = path.join(PENDING_ROOT, showId);
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { /* no _pending dir */ }
    const files = names.map(file => {
      let ts = 0;
      try { ts = pendingFileTimestamp(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))); } catch { /* unreadable: sort last */ }
      return { file, ts };
    });
    return { showId, files };
  });
  return orderPendingWork(shows);
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

function showIds() {
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

const NON_MET_OPERA_URL_MARKERS = require('./lib/content-filters').NON_MET_OPERA_URL_MARKERS;

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

/**
 * @param {string} showId
 * @param {object} [deps] injectable for tests (BRO-2735): root, show, fetch
 *   (fetchPage-compatible), alert (routeAlert-compatible), emit (emitStage-
 *   compatible), dryRun, budget, explicitScope, now (() => Date), log,
 *   files (BRO-4408: newest-first file order from planPendingWork).
 */
async function processShow(showId, deps = {}) {
  const root = deps.root || REVIEW_TEXTS_ROOT;
  const fetchPageImpl = deps.fetch || fetchPage;
  const alert = deps.alert || defaultRouteAlert;
  const emit = deps.emit || emitStage;
  const dry = deps.dryRun !== undefined ? deps.dryRun : dryRun;
  const budget = deps.budget || timeBudget;
  const explicitScope = deps.explicitScope !== undefined ? deps.explicitScope : !!(showArg || showsArg);
  const now = deps.now || (() => new Date());
  const pendingDir = path.join(root, '_pending', showId);
  if (!fs.existsSync(pendingDir)) {
    console.log(`[${showId}] no _pending dir`);
    return { promoted: 0, kept: 0, rejected: 0, unrecoverable: 0, refetched: 0 };
  }
  const show = deps.show !== undefined ? deps.show : loadShow(showId);
  const openingYear = show?.openingDate ? new Date(show.openingDate).getFullYear() : null;
  const files = deps.files || fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  console.log(`[${showId}] ${files.length} pending files to inspect (opening ${show?.openingDate || '?'})`);

  let promoted = 0, kept = 0, rejected = 0, droppedRedundant = 0, refetched = 0;
  // Zero-text + no-byline stubs replay could not recover (BRO-2735). Reported
  // after the loop — never a silent "keep".
  const unrecoverable = [];
  const noteUnrecoverable = (file, filepath, data, reason) => {
    console.log(`  [${file}] UNRECOVERABLE: no text, no byline (${reason}) — kept in _pending, reported below`);
    unrecoverable.push({ file, filepath, data, reason, outletId: data.outletId || null, url: data.url || null });
  };
  const finish = (extra = {}) => ({ promoted, kept, rejected, droppedRedundant, refetched, ...reportUnrecoverable(!extra.budgetExceeded), ...extra });
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
    if (!alertable) return { unrecoverable: unrecoverable.length, alerted: false };
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
    let data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    // Already evaluated and skipped on a prior run — don't re-fetch the URL.
    if (data.promoteSkippedReason) {
      kept++;
      continue;
    }
    // Tagged by sweep-rss-pending-junk.js (task #1073): the pre-fix RSS
    // openingWindow branch attributed unrelated theater-section articles
    // (obituaries, awards coverage) to whatever show opened that week. These
    // fail the identity check permanently — never fetch, never count as
    // drain candidates.
    if (data.rssIdentityRejected) {
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
    if (isRedundantPendingStub(data, landed)) {
      console.log(`  [${file}] url already filed as ${landed} — dropping textless pending stub`);
      if (!dry) fs.unlinkSync(filepath);
      droppedRedundant++;
      continue;
    }

    // Pre-promotion filters: don't bother fetching wrong-production URLs.
    if (NON_MET_OPERA_URL_MARKERS && NON_MET_OPERA_URL_MARKERS.some(m => url.toLowerCase().includes(m))) {
      console.log(`  [${file}] REJECT: non-Met opera house URL — ${dry ? 'DRY, not deleting' : 'deleting'}`);
      if (!dry) fs.unlinkSync(filepath);
      rejected++;
      continue;
    }
    if (openingYear) {
      const m = url.match(/\/((?:19|20)\d{2})\b/);
      if (m && Math.abs(parseInt(m[1], 10) - openingYear) > 1) {
        console.log(`  [${file}] REJECT: URL year ${m[1]} > ±1y from ${openingYear} — ${dry ? 'DRY, not deleting' : 'deleting'}`);
        if (!dry) fs.unlinkSync(filepath);
        rejected++;
        continue;
      }
    }

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
        console.log(`  [${file}] SKIP (kept in _pending): ${rejectReason}`);
        data.promoteSkippedReason = rejectReason;
        data.promoteSkippedAt = new Date().toISOString();
        if (!dry) fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        kept++;
        continue;
      }
      // extractHighConfidenceAuthor returns string|null; extractAuthorFromHtml returns
      // { name, source } | null. Normalize to plain string.
      const hcRaw = extractHighConfidenceAuthor(html);
      const fallbackRaw = hcRaw ? null : extractAuthorFromHtml(html, '', { outletId: data.outletId });
      const raw = hcRaw || fallbackRaw;
      byline = raw ? (typeof raw === 'string' ? raw : raw.name || null) : null;
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 80);
      console.log(`  [${file}] fetch failed: ${msg} — keep`);
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

    if (!byline || byline === 'Unknown') {
      if (isUnrecoverablePendingStub(data, null)) {
        noteUnrecoverable(file, filepath, data, 'no byline in page and no recoverable body');
      } else {
        console.log(`  [${file}] no byline detected — keep in pending`);
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

module.exports = {
  pendingPromoteRejectReason,
  NON_THEATRE_SECTIONS,
  findExistingFileForUrl,
  isRedundantPendingStub,
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
    await retryEmptyBodyReviews({ root: REVIEW_TEXTS_ROOT, shows, showIds: retryIds, dryRun,
      cooldownHours: showArg || showsArg ? 1 : 6,
      budget: createRunBudget(Math.min(2, timeBudget.minutes || 2)) });
    const scopeNote = allOpen && closedWithinDays > 0 ? ` (open/previews + closed within ${closedWithinDays}d)` : '';
    console.log(`Processing ${ids.length} show(s)${scopeNote}${dryRun ? ' [DRY RUN]' : ''}\n`);

    let totalPromoted = 0, totalKept = 0, totalRejected = 0, totalDropped = 0, totalUnrecoverable = 0, totalRefetched = 0;
    const alertPromises = [];
    for (const { showId: id, files } of planPendingWork(ids)) {
      const { promoted, kept, rejected, droppedRedundant, budgetExceeded, unrecoverable, refetched, alertPromise } = await processShow(id, { files });
      totalPromoted += promoted;
      totalKept += kept;
      totalRejected += rejected || 0;
      totalDropped += droppedRedundant || 0;
      totalUnrecoverable += unrecoverable || 0;
      totalRefetched += refetched || 0;
      if (alertPromise) alertPromises.push(alertPromise);
      if (budgetExceeded) break;
    }
    await Promise.all(alertPromises);

    console.log(`\n━━━ Replay complete ━━━`);
    console.log(`Promoted: ${totalPromoted}`);
    console.log(`Rejected (wrong-prod or wrong-year, deleted): ${totalRejected}`);
    console.log(`Dropped (url already filed, stub had nothing extra): ${totalDropped}`);
    console.log(`Kept in _pending: ${totalKept}`);
    console.log(`  of which re-fetched body rebuilt: ${totalRefetched}`);
    console.log(`  of which UNRECOVERABLE (no text, no byline — see alerts above): ${totalUnrecoverable}`);
  })().catch(e => {
    console.error(e);
    process.exitCode = 1;
  }).finally(cleanup);
}
