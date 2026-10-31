/**
 * gap-ingest-policy.js — ingest-safety policy for the review-gap audit.
 *
 * Production-identity check for the BROADWAY discovery path (2026-07-11).
 * The WE reference already date-gates roundups (isCurrentRunRoundup): a roundup
 * whose post date falls outside the current opening window is priorRun and its
 * URLs are permanently ingest-blocked. The Broadway path (SERP-found Playbill
 * Verdict / BWW Review Roundup articles) had NO such check — urlMatchesShow is
 * a wrong-SHOW filter, not a wrong-PRODUCTION filter, so a same-title prior
 * production's roundup passes it (2026-07-10 first-run incident: the 2018
 * Broadway TKAM BWW RR ingested 2018 US reviews onto the WE 2026 entry; same
 * class hit Midsummer/Taymor 2013, Last Ship 2014, JLP 2025). Broadway
 * revivals have the identical exposure with no WE gate to catch them.
 *
 * articleRunIdentity() dates an aggregator ARTICLE (publish-date metadata from
 * the fetched HTML — never from the URL, per CLAUDE.md core data rules) against
 * the show's opening window via the SAME canonical predicate the WE reference
 * uses. A missing date fails open (treated as current) to match the WE
 * convention — Playbill/BWW roundups carry JSON-LD/OpenGraph dates reliably,
 * and the incident class is old dated articles.
 *
 * ingestBlockReason() is the single ingest-eligibility predicate for the
 * audit's --ingest-missing and flaggedMiss-recovery paths (previously two
 * inline copies that only blocked priorRun on weRef rows — meaning the moment
 * WE_GAP_INGEST auto-enables, Broadway-path prior-production URLs on WE shows
 * became ingestable again). priorRun blocks UNCONDITIONALLY, on every path.
 *
 * isUrlYearOutOfWindow() (BRO-1412, 2026-09) covers the source articleRunIdentity
 * can't: Show Score per-show page discovery has no roundup article to date —
 * it links straight to each outlet's own review. Applying the URL-embedded-year
 * check there closes the last title-matched-but-not-production-matched
 * discovery path (Playbill Verdict SERP + BWW Review Roundup were closed by
 * articleRunIdentity above; Show Score was not).
 *
 * Pure functions per CLAUDE.md §15 — the audit wires them; tests require() them.
 */

'use strict';

const { extractPublishDate } = require('./article-extractor');
const { isCurrentRunRoundup } = require('./gap-reference-sources');
const { isUrlYearInPriorRun, urlYearOf } = require('./url-discovery');
const { toDateMs } = require('./date-utils');

/**
 * Date an aggregator article against the show's current opening window.
 * @param {string|null} html  fetched article HTML
 * @param {object} show shows.json record ({openingDate})
 * @param {string} [url]  the article's fetch URL, so extractPublishDate can scope
 *   JSON-LD to the entity matching this canonical URL (rejects related-article dates)
 * @returns {{publishDate: string|null, priorRun: boolean}}
 */
function articleRunIdentity(html, show, url) {
  const publishDate = extractPublishDate(html, url);
  // No readable publish date (bot wall, missing meta): the article URL's own year
  // (BWW roundups end in YYYYMMDD) still dates a prior production's roundup.
  const priorRun = publishDate
    ? !isCurrentRunRoundup(publishDate, show)
    : !!(url && isUrlYearOutOfWindow(url, show));
  return { publishDate, priorRun };
}

/**
 * Cheap per-URL production-identity signal, no fetch required: many outlets
 * embed the publish year in the review URL path itself
 * (nytimes.com/2018/04/23/theater/...). A URL year older than this
 * production's opening window is a prior production's review UNLESS a
 * declared priorRuns window explicitly claims that year.
 *
 * Show Score per-show pages (unlike Playbill Verdict / BWW Review Roundup)
 * carry no article-level publish date articleRunIdentity() can check — Show
 * Score keeps ONE page per title (current-or-most-recent production) and
 * links directly to each outlet's own review with no roundup wrapper to
 * date. This is the same signal the SERP census discovery path
 * (acceptSerpCensusResult) already applies to its own candidates; extracted
 * here so any URL-only discovery source can reuse it, importing the SAME
 * url-discovery urlYearOf isUrlYearInPriorRun already uses rather than a second,
 * drifted regex literal (a second copy is how a URL trips one guard while
 * staying invisible to the priorRuns readmission in the other).
 *
 * This is a PARTIAL signal, not a full identity check: only URLs that embed
 * a publish year in their path (nytimes.com/YYYY/... style) can be checked at
 * all — outlets with slug-only URLs (playbill.com, variety.com, most
 * WordPress-style sites; roughly 60% of this corpus's review URLs) have
 * nothing to compare and fail open (treated as current). Closing that
 * remainder needs the review page's own fetched publish date, the same way
 * articleRunIdentity() dates aggregator articles — out of scope here because
 * Show Score links go straight to the outlet with no per-URL fetch in this
 * discovery pass.
 * @param {string} url
 * @param {object} show shows.json record ({previewsStartDate, openingDate, priorRuns})
 * @returns {boolean} true when the embedded year predates this production's window
 */
function isUrlYearOutOfWindow(url, show) {
  const urlYear = urlYearOf(url);
  if (urlYear === null) return false;
  if (isUrlYearInPriorRun(url, show && show.priorRuns)) return false;
  // A title that IS a year (e.g. "1984") slugs into review URLs as that same
  // 4-digit number with no way to distinguish it from a genuine publish year
  // — a Broadway "1984" revival's own current-run reviews would otherwise
  // permanently self-block. Skip the check when the matched number is a
  // whole token in the show's own title (ship-check finding, codex review).
  if (show && typeof show.title === 'string' && new RegExp(`(?:^|[^0-9])${urlYear}(?:[^0-9]|$)`).test(show.title)) {
    return false;
  }
  const starts = [show && show.previewsStartDate, show && show.openingDate]
    .map(d => (d ? new Date(d).getUTCFullYear() : NaN))
    .filter(Number.isFinite);
  if (!starts.length) return false;
  return parseInt(urlYear, 10) < Math.min(...starts);
}

/**
 * BRO-3556: production-identity gate for gather-reviews.js's OWN Show Score
 * path (curated-URL / slug-guess page scrape, Playwright carousel, HTML
 * fallback, pagination API). BRO-1412 gated only the audit's Show Score
 * discovery; gather-reviews ingested Show Score critic links with no such
 * check. Same semantics as audit-show-review-gap.js's Show Score loop: a
 * critic link whose URL-embedded year predates this production's window is a
 * prior production's review ('show-score-url-year', the audit's priorRun
 * source tag). A URL with no embedded year, or a missing URL, fails open —
 * exactly as isUrlYearOutOfWindow does.
 * @param {string|null} url  the outlet review URL Show Score linked to
 * @param {object} show shows.json record
 * @param {{date?: string|null}} [opts] the Show Score tile's own review date
 * @returns {'show-score-url-year'|'show-score-tile-date'|null}
 */
function showScoreUrlBlockReason(url, show, { date = null } = {}) {
  if (url && typeof url === 'string' && isUrlYearOutOfWindow(url, show)) return 'show-score-url-year';
  return isShowScoreTileDateOutOfRun(date, show) ? 'show-score-tile-date' : null;
}

// BRO-6629: Show Score's critic tile carries the review's own date. Many prior-
// production URLs have no year in them (curtainup.com/veryhungrycaterpillarshow.html,
// offoffonline.com/?p=20946), so the URL-year gate let a 2016 run's notices through
// as "missing" for a 2023 production. A dated tile more than TILE_EARLY_DAYS before
// this production's first preview/opening, or TILE_LATE_DAYS after its closing,
// reviews another production. Undated tiles, undated shows and a date inside a
// declared prior run fail open, the same as isUrlYearOutOfWindow.
const TILE_EARLY_DAYS = 60;
const TILE_LATE_DAYS = 180;
const DAY_MS = 864e5;
function isShowScoreTileDateOutOfRun(date, show) {
  const t = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(t) || !show) return false;
  const starts = [show.previewsStartDate, show.openingDate].map((d) => (d ? Date.parse(d) : NaN)).filter(Number.isFinite);
  if (!starts.length) return false;
  for (const run of Array.isArray(show.priorRuns) ? show.priorRuns : []) {
    // A run marked inheritReviews:false is a separate production; its dates do not clear a tile.
    if (!run || run.inheritReviews === false) continue;
    const o = run.openingDate ? Date.parse(run.openingDate) : NaN;
    if (!Number.isFinite(o)) continue;
    const c = run.closingDate ? Date.parse(run.closingDate) : NaN;
    if (t >= o - TILE_EARLY_DAYS * DAY_MS && t <= (Number.isFinite(c) ? c : o) + TILE_LATE_DAYS * DAY_MS) return false;
  }
  if (t < Math.min(...starts) - TILE_EARLY_DAYS * DAY_MS) return true;
  const close = show.closingDate ? Date.parse(show.closingDate) : NaN;
  return show.status === 'closed' && Number.isFinite(close) && t > close + TILE_LATE_DAYS * DAY_MS;
}

/**
 * Split Show Score-sourced review candidates into ingestable and blocked.
 * @param {Array<{url?: string|null}>} reviews
 * @param {object} show shows.json record
 * @param {{urlOf?: function}} [opts] urlOf picks the link to gate; pass the raw
 *   Show Score link when the review's url may already have been nulled.
 * @returns {{kept: object[], blocked: Array<{review: object, reason: string}>}}
 */
function partitionShowScoreReviews(reviews, show, { urlOf = (r) => r && r.url, dateOf = (r) => r && (r.publishDate || r.date) } = {}) {
  const kept = [];
  const blocked = [];
  for (const review of reviews || []) {
    const reason = showScoreUrlBlockReason(urlOf(review), show, { date: dateOf(review) });
    if (reason) blocked.push({ review, reason });
    else kept.push(review);
  }
  return { kept, blocked };
}

/**
 * Why an aggregator-listed URL must NOT be auto-ingested (null = ingestable).
 * @param {object} m    missing/flaggedMiss entry ({priorRun, weRef, weRefSources, serpCensus})
 * @param {object} ctx  {showIsWe: boolean, weGateOn: boolean, lowTrustSources?: Set<string>, serpCensusGateOn?: boolean}
 * @returns {'prior-run'|'we-gate-off'|'serp-census-gate-off'|'low-trust-source'|'unregistered-host'|null}
 */
function ingestBlockReason(m, { showIsWe, weGateOn, lowTrustSources, serpCensusGateOn }) {
  // Production identity: a URL cited only by a prior production's article/roundup
  // is NEVER auto-ingested, on any market, regardless of gate state.
  if (m.priorRun) return 'prior-run';
  // WE completeness gate (default OFF, fails closed): on WE shows ALL missing
  // URLs wait for WE_GAP_INGEST=1; weRef-derived URLs wait for it everywhere.
  if ((showIsWe || m.weRef) && !weGateOn) return 'we-gate-off';
  // SERP census gate (#371, ship-check 2026-07-24): a plain "<title> review"
  // Google query carries no site: restriction — weaker specificity than the
  // aggregator-article queries (Playbill/BWW) that vouch for every OTHER
  // Broadway-path ingest. Without this, a serpCensus-only miss on a Broadway
  // show would auto-ingest via --ingest-missing with zero extra scrutiny, at
  // exactly the moment the generic-title disambiguation guard is weakest
  // (single-token titles like "Oh, Mary!"/"Life of Pi"). Start conservative —
  // same "prove corroboration before auto-enabling" posture the WE gate used
  // (WE_GAP_INGEST) — default OFF via SERP_CENSUS_INGEST. Only reached for
  // non-WE rows; a WE show's serpCensus row is already blocked above.
  if (m.serpCensus && !serpCensusGateOn) return 'serp-census-gate-off';
  // Per-aggregator trust (lib/we-gate-proving.js aggregatorAccuracy): a URL
  // vouched for ONLY by sources whose citations have measurably failed
  // corroboration stays report-only. One trusted citing source is enough to
  // ingest; no source attribution (Broadway-path URLs) is never low-trust.
  if (m.weRef && lowTrustSources && lowTrustSources.size > 0 &&
      Array.isArray(m.weRefSources) && m.weRefSources.length > 0 &&
      m.weRefSources.every((s) => lowTrustSources.has(s))) {
    return 'low-trust-source';
  }
  // BRO-6685: the gap audit never auto-registers an outlet. A host with no
  // outlet-registry domain (knownOutletId null) was captured under a
  // domain-derived provisional slug since 2026-06-05; on 2026-10-31 that let a
  // content-scraper copy (globalnews2.xyz) of a real A Few Good Men review go
  // live scored 58. Such rows stay report-only (unknown-aggregator-outlets.json
  // is the onboarding queue). Last, so every earlier reason keeps precedence.
  // A flaggedMiss whose stored file already carries an outletId (recoverableOutletId) is
  // recovery of a held file, not a new registration, so it is not blocked here.
  if (!m.knownOutletId && !m.recoverableOutletId) return 'unregistered-host';
  return null;
}

/**
 * BRO-4190: a review the pipeline already fetched and dated, and that the write
 * guard parked in _pending/ as date-implausible, is proof of production identity
 * the census otherwise ignores (Met Macbeth: a 2008 classicalsource review held
 * the 2026 run's gap open for weeks). True when that stored publishDate is more
 * than `graceDays` before this run's first date (previews, else opening) and not
 * inside a declared prior run (a transfer keeps its earlier run's reviews).
 * @param {string} publishDate ISO date from the stored review file
 * @param {object} show shows.json record ({previewsStartDate, openingDate, priorRuns})
 * @param {number} [graceDays=90]
 * @returns {boolean}
 */
function isPublishDateBeforeRun(publishDate, show, graceDays = 90) {
  const pub = toDateMs(publishDate);
  if (!Number.isFinite(pub)) return false;
  const start = toDateMs((show && (show.previewsStartDate || show.openingDate)) || '');
  if (!Number.isFinite(start)) return false;
  if (pub >= start - graceDays * 86400000) return false;
  const { isWithinPriorRun } = require('./wrong-production-autoclear');
  return !isWithinPriorRun(publishDate, show.priorRuns);
}

// A press-night cluster dated further back than this cannot be this run on wrong dates.
const PRESS_NIGHT_CLUSTER_MAX_DAYS = 540;

/**
 * The gap URLs a show's _pending/ files prove are a prior production
 * (isPublishDateBeforeRun), except a press-night cluster: 3+ hosts dated within
 * 14 days of each other is an opening this show record does not know about
 * (Grease immersive: seven 2025-08-05/06 reviews against a 2026-07-22 start),
 * which may be this very production on wrong dates, so it stays a gap (unless it is
 * more than PRESS_NIGHT_CLUSTER_MAX_DAYS before the run: then it is the earlier production).
 * @param {Array<{url:string, publishDate:string}>} pending stored review files
 * @param {object} show shows.json record
 * @returns {Map<string,string>} url -> publishDate for URLs to tag prior-run
 */
function pendingPriorRunUrls(pending, show) {
  if (process.env.GAP_PENDING_PRIOR_RUN_DISABLED === '1') return new Map(); // kill switch
  // A dated URL path (/2026/10/, BWW YYYYMMDD) that disagrees with the stored date
  // means the stored date may be a misread: no verdict from it.
  const pathYear = (u) => { const m = /\/((?:19|20)\d\d)\/(?:0[1-9]|1[0-2])\//.exec(u); return m ? Number(m[1]) : urlYearOf(u); };
  const consistent = (p) => { const y = pathYear(p.url); return !y || y === new Date(toDateMs(p.publishDate)).getUTCFullYear(); };
  const early = (pending || []).filter((p) => p && p.url && consistent(p) && isPublishDateBeforeRun(p.publishDate, show));
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const out = new Map();
  for (const p of early) {
    const t = toDateMs(p.publishDate);
    const hosts = new Set(early.filter((q) => Math.abs(toDateMs(q.publishDate) - t) <= 14 * 86400000).map((q) => hostOf(q.url)));
    // A cluster more than PRESS_NIGHT_CLUSTER_MAX_DAYS before the run cannot be this
    // production on wrong dates (The Ask 2026 vs a Sept 2024 Wild Project run: six
    // hosts, 25 months early, held roundup-gap open): it is the earlier run.
    const start = toDateMs((show && (show.previewsStartDate || show.openingDate)) || '');
    const tooFarBack = Number.isFinite(start) && start - t > PRESS_NIGHT_CLUSTER_MAX_DAYS * 86400000;
    if (hosts.size < 3 || tooFarBack) out.set(p.url, p.publishDate);
  }
  return out;
}

/**
 * BRO-5421: the ingest child exits 1 when the write guard quarantines a review to
 * _pending/ (date_implausible). When the quarantined file's date predates this run
 * (same verdict pendingPriorRunUrls reaches on the NEXT audit run), the refusal is a
 * correct, permanent prior-production exclusion, not a failed ingest. Sea Wall 2026:
 * a 2023 Edinburgh review counted failed=1 and alarmed roundup-gap until the next run.
 * @param {string} output child stdout+stderr
 * @param {object} show shows.json record
 * @returns {string|null} the quarantined review's publishDate when it is a prior-run review, else null
 */
function quarantinedPriorRunDate(output, show) {
  const text = String(output || '');
  if (!/\(date_implausible\)/.test(text)) return null;
  const m = /quarantined to:\s*(\S+\.json)/.exec(text);
  if (!m) return null;
  let d;
  try { d = JSON.parse(require('fs').readFileSync(m[1], 'utf8')); } catch { return null; }
  if (!d || !d.url || !d.publishDate) return null;
  return pendingPriorRunUrls([{ url: d.url, publishDate: d.publishDate }], show).get(d.url) || null;
}

/**
 * A flagged-out gap row whose stored review file(s) are flagged wrongProduction /
 * wrongShow AND dated before this run is a prior production's review: the
 * validator's content verdict and the date agree, so the exclusion is permanent
 * and correct. Fish 2026 (WP Theater): four April-2024 reviews of the Theatre Row
 * "Fish" held the roundup-gap alert open forever. Unlike pendingPriorRunUrls there
 * is no press-night-cluster exemption, because the content check (venue/cast)
 * independently rejected the file rather than relying on its date alone.
 * @param {Array<{publishDate?:string, wrongProduction?:boolean, wrongShow?:boolean}>} dirFiles files stored for the URL's host
 * @param {object} show shows.json record
 * @returns {string|null} the first stored publishDate when every file qualifies, else null
 */
function flaggedFilePriorRunDate(dirFiles, show) {
  if (process.env.GAP_FLAGGED_PRIOR_RUN_DISABLED === '1') return null; // kill switch
  const files = (dirFiles || []).filter((d) => d && (d.wrongProduction || d.wrongShow));
  if (files.length === 0 || files.length !== (dirFiles || []).length) return null; // a clean/other-state file means no verdict
  let label = null;
  for (const d of files) {
    const before = isPublishDateBeforeRun(d.publishDate, show);
    if (!before && !isVenueVerifiedOtherProduction(d, show)) return null;
    if (!label) label = before ? d.publishDate : `venue-verified:${d.contentVerification.reviewedVenue}`;
  }
  return label;
}

/**
 * An UNDATED flagged file (form-submitted roundup page, no publishDate) whose
 * high-confidence content verdict names the venue it actually reviewed. The
 * venue mismatch is the same independent content check the dated path relies
 * on (BRO-5380: UNCONDITIONAL's NYC run vs the 2025 Skylight Theatre LA run,
 * theatreinla roundup held roundup-gap open with no date to compare).
 */
function isVenueVerifiedOtherProduction(d, show) {
  const cv = d && d.contentVerification;
  // The verifier also flags own-venue tour stops (BRO-4884); those are real reviews.
  const { reviewedAtOwnVenue } = require('./tour-stop-carveout');
  return !!(d.wrongProduction && cv && !reviewedAtOwnVenue(cv.reviewedVenue, show) && cv.wrongProduction === true && cv.confidence === 'high' && cv.reviewedVenue);
}

// Roundups whose own verdict lives ONLY inside the roundup (no standalone review
// page). Not London Box Office: it publishes standalone review pages, so its
// URL-less self-citation usually has a collectable page (review, BRO-4790).
const SELF_VERDICT_ROUNDUPS = new Set(['westendtheatre']);

/**
 * BRO-4790: a URL-less row where WestEndTheatre.com cites ITS OWN verdict inside
 * its own review round-up has no review page to collect: the write guard rejects
 * the roundup as roundup-page. Counting it as missing kept 6 of the 9 open
 * citedNoUrl rows on 2026-10-13 open forever.
 * @param {{outletId?:string, outletName?:string, source?:string}} row
 * @returns {boolean}
 */
function isRoundupSelfCitation(row) {
  if (!row || !row.source) return false;
  const { normalizeOutlet } = require('./review-normalization');
  const src = normalizeOutlet(row.source);
  return SELF_VERDICT_ROUNDUPS.has(src) && normalizeOutlet(row.outletId || row.outletName || '') === src;
}

/**
 * BRO-6687: order a show's ingest-eligible gap rows before the per-show cap.
 * The cap took rows in discovery order, so on Martin Guerre 2026 five SERP-census
 * pages (forum threads, listing pages) used all 5 slots every hourly run for 11
 * days and the aggregator-cited London Now review behind them was never tried.
 * Round-robin, so every eligible row gets a turn within ceil(n / cap) runs:
 *   1. rows the cap skipped last run, in the order they were skipped (FIFO);
 *   2. rows not seen last run, aggregator-cited before census;
 *   3. rows tried last run (still missing, so that try did not land them; an "ok"
 *      write the page filter later drops counts too, 243 such rows on 2026-10-31),
 *      cited before census.
 * Only demoting last run's tries would rotate the first 10 rows forever and starve
 * row 11+ (22 shows had more than 10 eligible rows on 2026-10-31).
 * @param {object[]} rows - eligible r.missing rows
 * @param {object[]} [priorIngestResults] - the previous audit row's ingestResults
 * @param {object[]} [priorSkippedByCap] - the previous audit row's ingestSkippedByCap
 * @returns {object[]} the same rows, reordered
 */
function orderIngestCandidates(rows, priorIngestResults = [], priorSkippedByCap = []) {
  const key = (u) => String(u || '').trim().replace(/^https?:\/\/(www\.)?/i, '').replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  const triedLastRun = new Set((priorIngestResults || []).filter(x => x && x.url).map(x => key(x.url)));
  const cappedAt = new Map();
  (priorSkippedByCap || []).forEach((x, i) => { if (x && x.url && !cappedAt.has(key(x.url))) cappedAt.set(key(x.url), i); });
  const rank = (m) => {
    const k = key(m.url);
    if (cappedAt.has(k)) return [0, cappedAt.get(k)];
    return [triedLastRun.has(k) ? 2 : 1, m.serpCensus ? 1 : 0];
  };
  return (rows || []).map((m, i) => ({ m, i, k: rank(m) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i).map(x => x.m);
}

module.exports = { articleRunIdentity, ingestBlockReason, isUrlYearOutOfWindow, showScoreUrlBlockReason, isShowScoreTileDateOutOfRun, partitionShowScoreReviews, isPublishDateBeforeRun, pendingPriorRunUrls, quarantinedPriorRunDate, flaggedFilePriorRunDate, isRoundupSelfCitation, orderIngestCandidates };
