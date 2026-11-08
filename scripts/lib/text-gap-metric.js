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
      rows.push({
        showId,
        file: name,
        outletId: review.outletId || '?',
        ...g,
        polluted: !!reason && !INCOMPLETE_REASON_ENUM.includes(reason),
      });
    }
  }
  return { rows, excludedSidecars, filesRead, unreadable };
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
    if (r.gapClass === 'COMPLETE') { complete++; continue; }
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
