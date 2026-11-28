/**
 * text-gap-metric.js — walk the review-texts corpus and count the text gaps by
 * class, outlet and recency (zero-gap plan 3.2 / 1B). READ-ONLY.
 *
 * File selection matches the pipeline: listShowDirs(skipHolding) drops `_*`
 * holding dirs (including `__test-*`), isReviewTextFile drops the `_*.json`
 * sidecars (`_blocklist.json`). The sidecar count is reported as
 * `excludedSidecars` so a metric that quietly includes them (the brief's
 * 55,862 did) is visible.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./list-show-dirs');
const { isReviewTextFile } = require('./review-text-sidecars');
const { classifyTextGap, GAP_CLASSES } = require('./text-gap-classify');

// incompleteReason values the pipeline writes (classifyIncompleteReason, plus the
// collector-written ones it preserves). Anything else is free text from a
// recovery script and is counted in pollutedReasonCount.
const INCOMPLETE_REASON_ENUM = Object.freeze([
  'wrong_content', 'url_dead', 'scraper_garbage', 'paywall', 'url_content_mismatch', 'no_url',
  'route_capped', 'scraper_timeout', 'code_error', 'bot_blocked', 'roundup_only', 'partial_text',
  'not_attempted', 'unknown', 'multi_show_section_not_found', 'non_review', 'unrecoverable',
  'permanently_unavailable',
]);

/**
 * Index failed-fetches rows by `<showId>/<file>`. Newer rows carry `reviewId`;
 * older ones only `filePath` ("data/review-texts/<show>/<file>").
 * @param {Array<object>} rows
 * @returns {Map<string, object>}
 */
function indexFailedFetches(rows) {
  const map = new Map();
  for (const e of Array.isArray(rows) ? rows : []) {
    let key = e && e.reviewId;
    if (!key && e && typeof e.filePath === 'string') {
      const m = /([^/]+\/[^/]+\.json)$/.exec(e.filePath);
      key = m && m[1];
    }
    if (key && !map.has(key)) map.set(key, e);
  }
  return map;
}

function loadFailedFetches(dir) {
  try {
    return indexFailedFetches(JSON.parse(fs.readFileSync(path.join(dir, 'failed-fetches.json'), 'utf8')));
  } catch {
    return new Map();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dir review-texts corpus root
 * @param {Map<string,object>} opts.shows showId -> shows.json record
 * @param {object} [opts.outlets] outlet-registry (id -> entry)
 * @param {number} opts.nowMs
 * @param {Set<string>} [opts.outletFilter]
 * @param {string|null} [opts.showFilter]
 * @param {(review:object)=>string} [opts.tierOf] effective tier (default: stored)
 * @returns {{rows:Array, excludedSidecars:number, filesRead:number, unreadable:number}}
 */
function scanCorpus({ dir, shows, outlets = {}, nowMs, outletFilter = null, showFilter = null, tierOf = null }) {
  const ff = loadFailedFetches(dir);
  const rows = [];
  let excludedSidecars = 0;
  let filesRead = 0;
  let unreadable = 0;
  for (const showId of listShowDirs(dir, { silent: true, skipHolding: true })) {
    if (showFilter && showId !== showFilter) continue;
    let names;
    try { names = fs.readdirSync(path.join(dir, showId)); } catch { continue; }
    const showRows = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (!isReviewTextFile(name)) { excludedSidecars++; continue; }
      let review;
      try { review = JSON.parse(fs.readFileSync(path.join(dir, showId, name), 'utf8')); } catch { unreadable++; continue; }
      if (outletFilter && !outletFilter.has(review.outletId)) continue;
      filesRead++;
      const effective = tierOf ? { ...review, contentTier: tierOf(review) } : review;
      const g = classifyTextGap(effective, ff.get(`${showId}/${name}`) || null, {
        show: shows.get(showId) || null,
        outletInfo: outlets[review.outletId] || null,
        nowMs,
      });
      const reason = review.incompleteReason;
      const row = {
        showId,
        file: name,
        outletId: review.outletId || '?',
        ...g,
        polluted: !!reason && !INCOMPLETE_REASON_ENUM.includes(reason),
      };
      rows.push(row);
      showRows.push({ row, review });
    }
    excludeUnknownStubsBesideNamed(showRows);
    excludeRejectedNonReviewBesideComplete(showRows);
  }
  return { rows, excludedSidecars, filesRead, unreadable };
}

/**
 * The rebuild drops an "unknown"/"unnamed" critic file when an included named
 * critic file exists at the same canonical outlet (rebuild-all-reviews.js
 * skippedUnknownCriticDedup), so such a stub never reaches the site and is
 * not a gap. BRO-7171 Stage 4: ~150 of 331 recent NO_URL rows were
 * nyc-theatre `--unknown` stubs (no url, no text) beside the named file, e.g.
 * school-girls-or-the-african-mean-girls-play-2026/nytimes--unknown.json next
 * to nytimes--helen-shaw.json. Uses the rebuild's own outlet key. Mutates rows.
 */
function excludeUnknownStubsBesideNamed(showRows) {
  const { normalizeOutlet } = require('./review-normalization');
  const { isUnknownCritic } = require('./within-show-dedup');
  const key = (r) => normalizeOutlet(r.outletId || r.outlet || '');
  const namedIncluded = new Set();
  for (const { row, review } of showRows) {
    if (row.gapClass !== 'EXCLUDED' && !isUnknownCritic(review)) namedIncluded.add(key(review));
  }
  for (const { row, review } of showRows) {
    if (row.gapClass === 'EXCLUDED' || !isUnknownCritic(review)) continue;
    if (!namedIncluded.has(key(review))) continue;
    row.gapClass = 'EXCLUDED';
    row.subclass = 'unknown_stub_named_sibling';
    row.open = false;
  }
}

/**
 * BRO-8092: a file the canonical isRejectedNonReview calls not a review
 * (ensemble not_a_review, invalid tier, high-confidence CV wrongArticle / news
 * articleType; its json-ld-star and manual-clear carve-outs kept) is not a gap when
 * the same outlet's review of this show is already complete in a sibling file:
 * nothing is missing. Before this the nightly engine re-attempted them and the
 * floors report counted them, e.g. a-few-good-men-2026/variety--anna-tingley.json
 * (a /shop/ ticket listing) beside the complete variety--daniel-daddario.json,
 * and cats-the-jellicle-ball-2026/variety--brent-lang.json (a closing-news
 * story) beside variety--frank-rizzo.json: 2 of Variety's 5 floor gaps.
 * Three signals, never fewer. The verdict alone is not enough: the 65-row
 * corpus sample (BRO-8092) found real second reviews rejected after the
 * ensemble read a ~160-char teaser (the-waverly-gallery-2018/
 * nypost--johnny-oleksinski.json, red-2010/theatermania--david-finkle.json),
 * and garbage_text is about the fetched body, not the page. So the stored url
 * must also be one the canonical url classifier refuses (ticketing listing,
 * site utility, off-topic host), and a complete same-outlet sibling must hold
 * the review. Otherwise the row stays open. Mutates rows.
 */
function excludeRejectedNonReviewBesideComplete(showRows) {
  const { normalizeOutlet } = require('./review-normalization');
  const { isRejectedNonReview } = require('./review-guards');
  // garbage_text rejects the fetched body, not the page (scraper_garbage on incompleteReason is a fetch note and is fine).
  const garbageRejection = (r) => /garbage/.test(String(r.rejectionReason || ''));
  const { classifyReviewUrl } = require('./non-review-url-patterns');
  const key = (r) => normalizeOutlet(r.outletId || r.outlet || '');
  const urlRefused = (r) => /^https?:\/\//i.test(String(r.url || '')) && classifyReviewUrl(r.url).ok === false;
  const completeBy = new Map();
  for (const { row, review } of showRows) {
    if (row.gapClass !== 'COMPLETE' || isRejectedNonReview(review)) continue;
    if (!completeBy.has(key(review))) completeBy.set(key(review), []);
    completeBy.get(key(review)).push(row.file);
  }
  for (const { row, review } of showRows) {
    // An explicit not_a_review verdict, never an invalid tier alone (a garbage fetch
    // sets that, and a bad url + bad body are one failure, not two signals: review).
    if (!row.open || review.rejectionReason !== 'not_a_review' || !isRejectedNonReview(review) || garbageRejection(review) || !urlRefused(review)) continue;
    const sibs = (completeBy.get(key(review)) || []).filter((f) => f !== row.file);
    if (!sibs.length) continue;
    row.gapClass = 'EXCLUDED';
    row.subclass = 'rejected_non_review_beside_complete';
    row.open = false;
  }
}

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

/**
 * Aggregate classified rows. Pure.
 * @param {Array} rows from scanCorpus
 * @param {{recentOnly?:boolean}} [opts]
 */
function buildMetric(rows, { recentOnly = false } = {}) {
  const scope = recentOnly ? rows.filter((r) => r.recency === 'recent') : rows;
  const byClass = {};
  const byClassRecent = {};
  const byOutlet = {};
  const byOutletClass = {};
  const subclasses = {};
  let open = 0;
  let openRecent = 0;
  let excluded = 0;
  let complete = 0;
  let terminal = 0;
  let nonReviewIncomplete = 0;
  let nonReviewIncompleteRecent = 0;
  let pollutedReasonCount = 0;
  let recentDateUnknown = 0;
  let completeWithFailedFetchRow = 0;
  for (const r of scope) {
    if (r.polluted) pollutedReasonCount++;
    if (r.gapClass === 'EXCLUDED') {
      excluded++;
      if (r.subclass === 'nonReview' && r.tier !== 'complete') {
        nonReviewIncomplete++;
        if (r.recency === 'recent') nonReviewIncompleteRecent++;
      }
      continue;
    }
    if (r.gapClass === 'COMPLETE') { complete++; if (r.subclass === 'with_failed_fetch_row') completeWithFailedFetchRow++; continue; }
    if (r.gapClass === 'TERMINAL') { terminal++; continue; }
    open++;
    bump(byClass, r.gapClass);
    if (r.subclass) bump(subclasses, `${r.gapClass}:${r.subclass}`);
    const o = (byOutlet[r.outletId] = byOutlet[r.outletId] || { open: 0, openRecent: 0 });
    o.open++;
    (byOutletClass[r.outletId] = byOutletClass[r.outletId] || {});
    bump(byOutletClass[r.outletId], r.gapClass);
    if (r.recency === 'recent') {
      openRecent++;
      o.openRecent++;
      bump(byClassRecent, r.gapClass);
      if (!r.dateKnown) recentDateUnknown++;
    }
  }
  return {
    files: scope.length,
    excluded,
    complete,
    completeWithFailedFetchRow,
    terminal,
    open,
    openRecent,
    nonReviewIncomplete,
    nonReviewIncompleteRecent,
    recentDateUnknown,
    pollutedReasonCount,
    byClass,
    byClassRecent,
    subclasses,
    byOutlet,
    byOutletClass,
  };
}

module.exports = {
  scanCorpus,
  buildMetric,
  indexFailedFetches,
  loadFailedFetches,
  INCOMPLETE_REASON_ENUM,
  GAP_CLASSES,
};
