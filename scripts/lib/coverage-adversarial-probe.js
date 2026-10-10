'use strict';

// Reused verbatim (not reimplemented) per the plan's "no new parallel
// machinery" rule and the day-one triage's own instruction: a canonical
// URL comparator already exists for exactly this problem (dedup comparison
// stripping scheme/www/trailing-slash/fragment/tracking-params — see its
// own header). Requiring it here keeps this module's own fs/path requires
// unexecuted at call time (module load only), so the "pure, fixture-testable"
// contract above still holds.
const { normalizeUrl: canonicalizeUrlForCompare } = require('./review-normalization');
// The canonical aggregator-domain set (show-score.com, stagedoor.com, etc.) —
// their OWN show-landing pages surface constantly in the naive census arm
// (they list every outlet's stars, so they rank for "<title> review") but are
// never themselves a review to gather; a real aggregator-sourced star-stub
// carries this URL on disk already and is matched by lookupRecord() before
// this ever runs. Reused verbatim, not re-derived, per the day-one triage's
// instruction to check existing aggregator/venue classifications first.
const { AGGREGATOR_DOMAINS } = require('./aggregator-domains');
// Ticketing/venue-production-page/event-listing patterns — canonical copy in
// non-review-url-patterns.js, shared with audit-show-review-gap.js's own
// discovery-time isReviewUrl() filter (task #907 ship-check finding: this
// module originally hand-duplicated a subset of these; two independently
// maintained copies of the same policy will drift).
const { namedNonReviewReason } = require('./non-review-url-patterns');
// Ingest-time's own canonical "never a review" block-list (social/ticket/
// aggregator-roundup/reference domains + feature/interview paths) — the SAME
// list explainExclusion() already stamps 'blockedReviewUrl' against once a
// candidate is on disk. Before this, a not-yet-captured URL on one of these
// domains (lovelondonloveculture.com, westendtheatre.com, etc.) fell through
// classifyNonReviewUrl() to 'gap' — the exact drift this module's own header
// warns two independently-maintained "is this a review" lists will produce
// (task #1036: the-car-man-west-end-2026's Love London Love Culture round-up
// read as an undiscovered gap for 2 days although review-guards.js already
// knows the domain is never a review).
const { isBlockedReviewUrl } = require('./domain-filters');

/**
 * coverage-adversarial-probe.js — pure decision layer for the Coverage
 * Verdict S5 weekly adversarial probe (task #903, the FINAL sprint).
 *
 * The plan's acceptance bar (S5) is deliberately NOT "the owner found nothing
 * wrong this week" — that passes vacuously the moment the owner stops
 * checking, which is the exact failure mode #872 exists to end (four
 * consecutive spot-checks in a row found reviews the census had reported
 * absent). Instead: every week, take 5 shows the owner did NOT choose, run
 * the same naive Google query a human would type (S1's harness,
 * scripts/audit-serp-census-recall.js / scripts/lib/census-recall.js — reused
 * verbatim, not re-implemented), and assert every review URL that query
 * surfaces is either LIVE on the site or NAMED — explainExclusion() gives the
 * rule that kept it out. A URL that is neither is a real, current gap the
 * pipeline missed, which is exactly the class of incident the plan exists to
 * stop from recurring silently.
 *
 * "Two consecutive clean weeks = done" (plan S5) is judged here, not by the
 * cron: evaluateAcceptance() reads the trend ledger the CLI wrapper
 * (scripts/coverage-adversarial-probe.js) appends to weekly and decides
 * whether the run of evidence clears the bar. It is deliberately blind to
 * outage weeks (verdict:'inconclusive') — a dead SERP chain must not
 * manufacture two false "clean" weeks any more than it should manufacture a
 * false regression (the same #898 lesson census-recall.js already encodes).
 *
 * Pure — no fs, no network, no clock reads except via injected `now`. All I/O
 * (SERP calls, on-disk review lookups, trend file read/write) lives in the
 * CLI wrapper so this module is unit-testable against fixtures alone.
 */

/** Minimum days apart for two trend entries to count as separate weekly runs
 * rather than a manual re-trigger + its own re-run on the same day. */
const MIN_RUN_GAP_DAYS = 5;
/** Consecutive clean runs required before the probe calls the sprint proven. */
const REQUIRED_CLEAN_RUNS = 2;

/**
 * Is this candidate URL a known not-a-review page? Two classes:
 *
 * 1. Ticketing/venue-production/event-listing hosts (namedNonReviewReason,
 *    shared with audit-show-review-gap.js's discovery-time isReviewUrl() —
 *    see non-review-url-patterns.js's own header). Evidence (task #907
 *    day-one triage, 6 of 9 first-run "gaps"): newyorkcitytheatre.com,
 *    nationaltheatre.org.uk/productions/, londontheatre.co.uk/show/NNNN,
 *    etc. None of these were ever a review to find, so a show missing a
 *    review-texts file for them is not a gap — it is exactly the class
 *    explainExclusion() names for on-disk records, just for a URL that
 *    never had a file to begin with.
 *
 * 2. Aggregator own-site show-landing pages (show-score.com, stagedoor.com,
 *    etc. — the canonical AGGREGATOR_DOMAINS set from aggregator-domains.js,
 *    reused verbatim, not re-derived). These list every outlet's stars in
 *    one place, so they rank for "<title> review", but are never themselves
 *    a review to gather. Deliberately NOT folded into namedNonReviewReason /
 *    isReviewUrl: a real aggregator-sourced star-stub legitimately carries
 *    this exact URL on disk (isAggregatorReviewSource in aggregator-
 *    domains.js), and lookupRecord() already matches it before this ever
 *    runs — excluding the whole domain at isReviewUrl's discovery-time gate
 *    would make onDiskByUrlFor() (scripts/coverage-adversarial-probe.js)
 *    silently stop indexing those legitimately-captured files, understating
 *    real "live" coverage. Show-score.com's own show pages are handled by
 *    their own dedicated integration (update-show-status.js /
 *    show-score-status.js), not the per-review discovery path this probe
 *    audits, so excluding them here (post-lookup, probe-only) is safe.
 *
 * @param {string} url
 * @returns {string|null} a reason label, or null if not a recognized pattern
 */
function classifyNonReviewUrl(url) {
  const named = namedNonReviewReason(url);
  if (named) return named;
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  // Checked before the general block-list below: star-rating aggregator own-
  // pages get their own distinct 'aggregator-own-page' label (see the header
  // comment on AGGREGATOR_DOMAINS above) even though domain-filters.js's
  // isBlockedReviewUrl() would also catch several of these same hosts.
  if (AGGREGATOR_DOMAINS.has(host)) return 'aggregator-own-page';
  if (isBlockedReviewUrl(url)) return 'blockedReviewUrl';
  return null;
}

/**
 * Find the on-disk record for a candidate URL, tolerant of scheme (http vs
 * https), www-prefix, and trailing-slash differences between the SERP-
 * discovered URL and the stored one (task #907: theartsdesk.com's Sinatra
 * review was counted a gap because the SERP result came back http:// while
 * the stored review is https://). Exact match first (the common case, O(1));
 * falls back to a canonicalized scan only on a miss — per-show maps are a
 * few dozen entries at most, so this never runs against the whole corpus.
 *
 * @param {Map<string,object>} onDiskByUrl
 * @param {string} url
 * @returns {object|null}
 */
function lookupRecord(onDiskByUrl, url) {
  if (onDiskByUrl.has(url)) return onDiskByUrl.get(url);
  const target = canonicalizeUrlForCompare(url);
  for (const [key, rec] of onDiskByUrl) {
    if (canonicalizeUrlForCompare(key) === target) return rec;
  }
  return null;
}

/**
 * Classify one SERP-discovered candidate URL against what the pipeline
 * already holds for the show.
 *
 * @param {string} url normalized candidate URL
 * @param {object} show shows.json record
 * @param {Map<string,{data:object, filePath:string|null, pending?:boolean, pendingReason?:string}>} onDiskByUrl
 *   normalized URL -> record for every review-texts file for this show,
 *   INCLUDING quarantined data/review-texts/_pending/<show>/ files (marked
 *   `pending: true`) — a URL correctly quarantined by the write-guard (e.g.
 *   date-implausible, prior-production) is a named exclusion, not a gap the
 *   probe doesn't know about (task #907: the-state-of-the-arts Car Man case).
 * @param {{isIncludableForRebuild: Function, explainExclusion: Function}} guards
 * @returns {{url:string, state:'live'|'excluded'|'gap', reason:string|null}}
 */
function classifyCandidate(url, show, onDiskByUrl, guards) {
  const rec = lookupRecord(onDiskByUrl, url);
  if (!rec) {
    const nonReviewReason = classifyNonReviewUrl(url);
    if (nonReviewReason) return { url, state: 'excluded', reason: nonReviewReason };
    return { url, state: 'gap', reason: null };
  }
  if (rec.pending) {
    // 'no-byline' (gather-reviews.js) is an ACTIVE WORKING QUEUE item, not a
    // settled exclusion: the pipeline already captured this review's text,
    // it's just waiting on critic-name resolution (memory: the "_pending
    // no-byline strand" has its own drain process). Labeling it identically
    // to a permanent exclusion (date_implausible: wrong production/date,
    // never becomes live) would read as "handled forever" when it's really
    // "already known, still open" (Codex ship-check finding, task #907).
    // Both branches return 'excluded' — NOT 'gap' — because either way the
    // probe's only question here is "did the pipeline already discover this
    // URL", and the answer is yes for both.
    const reason = rec.pendingReason === 'no-byline'
      ? 'quarantined: no-byline (already captured, queued for byline resolution — not a new gap)'
      : `quarantined: ${rec.pendingReason || 'pending-review'}`;
    return { url, state: 'excluded', reason };
  }
  const { data, filePath } = rec;
  let includable = false;
  try { includable = guards.isIncludableForRebuild(data, show, filePath) === true; }
  catch { includable = false; }
  if (includable) return { url, state: 'live', reason: null };
  let reason = null;
  try { reason = guards.explainExclusion(data, show, filePath); }
  catch { reason = 'unknown-exclusion-error'; }
  return { url, state: 'excluded', reason: reason || 'unknown' };
}

/**
 * Per-show probe verdict: PASS unless at least one candidate is a genuine,
 * undiscovered gap. A show contributing zero candidates (naive query found
 * nothing, or found only URLs already known) trivially passes — there is
 * nothing to be adversarial about.
 *
 * @param {Array<{url:string,state:string,reason:string|null}>} candidates
 * @returns {{pass:boolean, gaps:Array, live:number, excluded:number}}
 */
function summarizeShow(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const gaps = list.filter(c => c.state === 'gap');
  return {
    pass: gaps.length === 0,
    gaps,
    live: list.filter(c => c.state === 'live').length,
    excluded: list.filter(c => c.state === 'excluded').length,
  };
}

/**
 * Did the run's naive SERP queries actually reach a live provider? Mirrors
 * census-recall.js's detectProviderOutage exactly (task #903 ship-check
 * finding, Codex review): a missing key, an exhausted ScrapingBee cap, or a
 * dead Bright Data zone makes every query return zero raw results —
 * numerically identical to "every show has zero candidates", which
 * summarizeShow() reads as a trivial pass. Without this guard a dead SERP
 * chain reports 'clean' every week, which is worse than not probing at all.
 *
 * @param {Array<object>} rows {queries:[{ok, raw}]}
 * @returns {{outage:boolean, queries:number, productive:number}}
 */
function detectProviderOutage(rows, opts = {}) {
  const minProductiveFraction = opts.minProductiveFraction === undefined ? 0.34 : opts.minProductiveFraction;
  const queries = (Array.isArray(rows) ? rows : []).flatMap(r => Array.isArray(r.queries) ? r.queries : []);
  const productive = queries.filter(q => q && q.ok && (q.raw || 0) > 0).length;
  const fraction = queries.length ? productive / queries.length : 1;
  return { outage: queries.length > 0 && fraction < minProductiveFraction, queries: queries.length, productive };
}

/**
 * Did the run actually have the on-disk review corpus to classify against?
 * Mirrors census-recall.js's onDiskUnavailable guard (Codex review finding):
 * a missing/empty review-texts checkout makes onDiskByUrl empty for every
 * show, so EVERY discovered candidate reads as a gap — reporting a
 * corpus-wide collapse instead of the probe's own missing input. In a
 * 19,000+-review corpus, zero on-disk records across every measured show
 * means the checkout failed, not that the pipeline lost its corpus.
 *
 * @param {Array<object>} rows {onDiskCount:number}
 * @returns {boolean}
 */
function onDiskUnavailable(rows) {
  const measured = (Array.isArray(rows) ? rows : []).filter(r => (r.sampleState || 'measured') === 'measured');
  return measured.length > 0 && !measured.some(r => (r.onDiskCount || 0) > 0);
}

/**
 * Run-level verdict across every sampled show.
 *
 * 'inconclusive' — no show was actually measurable this run (every sample
 * was settling/undated), OR the run's own infrastructure could not answer
 * the question this week (a provider outage, or a missing on-disk corpus).
 * This must NEVER read as 'clean': a dead provider or an absent checkout
 * silently passing the probe every week would be worse than no probe at
 * all — indistinguishable from real health right up until the week it
 * matters.
 *
 * @param {Array<object>} rows {showId, sampleState, candidates:[...], queries, onDiskCount}
 * @returns {{verdict:'clean'|'gaps-found'|'inconclusive', measured:number, gapCount:number, gapShows:string[], reason?:string}}
 */
function summarizeRun(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const measured = list.filter(r => (r.sampleState || 'measured') === 'measured');
  if (measured.length === 0) {
    return { verdict: 'inconclusive', measured: 0, gapCount: 0, gapShows: [], reason: 'no sampled show was in a measurable state this run (settling/undated)' };
  }
  const outage = detectProviderOutage(list);
  if (outage.outage) {
    return {
      verdict: 'inconclusive', measured: measured.length, gapCount: 0, gapShows: [],
      reason: `provider outage — only ${outage.productive}/${outage.queries} naive-query attempt(s) returned any raw result; the SERP chain is down, not the pipeline`,
    };
  }
  if (onDiskUnavailable(list)) {
    return {
      verdict: 'inconclusive', measured: measured.length, gapCount: 0, gapShows: [],
      reason: 'on-disk review corpus unavailable (review-texts checkout missing/empty) — every candidate would falsely read as a gap',
    };
  }
  const gapShows = [];
  let gapCount = 0;
  for (const r of measured) {
    const s = summarizeShow(r.candidates);
    if (!s.pass) { gapShows.push(r.showId); gapCount += s.gaps.length; }
  }
  return {
    verdict: gapCount === 0 ? 'clean' : 'gaps-found',
    measured: measured.length,
    gapCount,
    gapShows,
  };
}

/**
 * Judge the trend ledger against the plan's "two consecutive clean weeks"
 * acceptance bar.
 *
 * @param {Array<{date:string, generatedAt:string, verdict:string}>} entries
 *   chronological (oldest first), as appended by the CLI wrapper
 * @param {object} [opts] {requiredClean, minGapDays}
 * @returns {{accepted:boolean, reason:string, consideredRuns:Array}}
 */
function evaluateAcceptance(entries, opts = {}) {
  const requiredClean = opts.requiredClean || REQUIRED_CLEAN_RUNS;
  const minGapDays = opts.minGapDays === undefined ? MIN_RUN_GAP_DAYS : opts.minGapDays;
  const list = (Array.isArray(entries) ? entries : []).filter(e => e && typeof e === 'object');
  // Only runs that actually measured something are evidence. An outage week
  // (or a week where every sampled show was settling/undated) contributes
  // nothing either way — it must not count toward, or reset, a clean streak,
  // any more than it should be allowed to manufacture one.
  const measurable = list.filter(e => e.verdict === 'clean' || e.verdict === 'gaps-found');
  if (measurable.length < requiredClean) {
    return {
      accepted: false,
      reason: `only ${measurable.length} measurable run(s) on record (need ${requiredClean}) — no evidence window yet`,
      consideredRuns: measurable,
    };
  }
  const recent = measurable.slice(-requiredClean);
  const notClean = recent.find(e => e.verdict !== 'clean');
  if (notClean) {
    return {
      accepted: false,
      reason: `${notClean.date || notClean.generatedAt || 'a recent run'} found ${notClean.gapCount || 'unnamed'} gap(s) (${(notClean.gapShows || []).join(', ') || 'unlisted show(s)'}) — streak reset`,
      consideredRuns: recent,
    };
  }
  // The two runs must be genuinely separate weeks, not a same-day re-trigger
  // and its own retry — else a flaky manual re-run could clear the bar in an
  // afternoon instead of the two real weeks the plan asks for.
  for (let i = 1; i < recent.length; i++) {
    const prevMs = Date.parse(recent[i - 1].generatedAt || recent[i - 1].date || '');
    const curMs = Date.parse(recent[i].generatedAt || recent[i].date || '');
    if (!Number.isFinite(prevMs) || !Number.isFinite(curMs)) continue;
    const gapDays = (curMs - prevMs) / 86400000;
    if (gapDays < minGapDays) {
      return {
        accepted: false,
        reason: `the last ${requiredClean} clean-looking runs are only ${gapDays.toFixed(1)}d apart (need >=${minGapDays}d) — not two distinct weekly cadences yet`,
        consideredRuns: recent,
      };
    }
  }
  return {
    accepted: true,
    reason: `${requiredClean} consecutive clean weekly run(s): ${recent.map(e => e.date || e.generatedAt).join(', ')}`,
    consideredRuns: recent,
  };
}

module.exports = {
  MIN_RUN_GAP_DAYS,
  REQUIRED_CLEAN_RUNS,
  classifyCandidate,
  classifyNonReviewUrl,
  lookupRecord,
  summarizeShow,
  summarizeRun,
  evaluateAcceptance,
  detectProviderOutage,
  onDiskUnavailable,
};
