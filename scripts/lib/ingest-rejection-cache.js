'use strict';
/**
 * BRO-2926: remember permanent ingest refusals so pollers stop re-fetching
 * them every cycle.
 *
 * createOrMergeReviewFile returns `{ action: 'skipped', reason, durable }`.
 * `durable` (set in review-file-writer.js from ingest-skip-classify.js) is true
 * for EXPECTED-REJECTION reasons: refusals that are correct and permanent
 * (cross-market, tour-review, empty-unknown, credited-person-as-critic, ...).
 * poll-loureviews.js and re-extract-aggregator-reviews.js used to file every
 * skip under "existing", and the LouReviews poller then re-fetched the same
 * permanently-refused post on every run, because no file ever lands to make
 * its exists-check pass.
 *
 * Records live in data/review-texts/{showId}/_ingest-rejections.json (the
 * review-texts push persists it; rebuild skips `_`-prefixed files, like
 * _blocklist.json). Kept apart from _blocklist.json on purpose: that file is an
 * operator's decision and makes the writer refuse the url; this one only lets
 * a poller skip work it already knows is refused.
 *
 * Rollback note (from BRO-2915): reverting a skip predicate does not release
 * urls already recorded here. Delete the matching entries too.
 */
const fs = require('fs');
const path = require('path');
const { normalizeUrl } = require('./poller-blocklist');

const REJECTIONS_FILENAME = '_ingest-rejections.json';

/** True when a writer result is a permanent refusal worth remembering. */
function isDurableSkip(result) {
  return !!(result && result.action === 'skipped' && result.durable === true);
}

function _load(showDir) {
  const fp = path.join(showDir, REJECTIONS_FILENAME);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(raw.urls) ? raw.urls : [];
  } catch {
    return [];
  }
}

/** Has this url been durably refused for this show (any source)? */
function isDurablyRejected(showDir, url) {
  if (!showDir || !url) return false;
  const n = normalizeUrl(url);
  return _load(showDir).some((e) => normalizeUrl(e.url) === n);
}

/**
 * Record a durable refusal. No-op when the url is already recorded, or when
 * `dryRun`. Returns true when a new entry was written.
 */
function recordDurableRejection(showDir, { url, outletId, reason, source }, { dryRun = false, now } = {}) {
  if (!showDir || !url || dryRun) return false;
  if (!fs.existsSync(showDir)) return false;
  const entries = _load(showDir);
  const n = normalizeUrl(url);
  if (entries.some((e) => normalizeUrl(e.url) === n)) return false;
  entries.push({ url, outletId: outletId || null, reason: reason || null, source: source || null, rejectedAt: now || new Date().toISOString() });
  fs.writeFileSync(path.join(showDir, REJECTIONS_FILENAME), JSON.stringify({ urls: entries }, null, 2) + '\n');
  return true;
}

/**
 * One label per writer result, so callers stop lumping refusals in with
 * "already have it":
 *   'written'  new or updated
 *   'existing' benign skip: the desired state already holds (no-changes, ...)
 *   'durable'  permanent refusal: remember it, never retry
 *   'refused'  conflict or unclassified refusal: log it, retry next cycle
 */
function bucketWriteResult(result) {
  if (!result) return 'refused';
  if (result.action === 'new' || result.action === 'updated') return 'written';
  if (result.action !== 'skipped') return 'refused';
  if (isDurableSkip(result)) return 'durable';
  const kind = require('./ingest-skip-classify').classifyReason(result.reason).kind;
  return kind === 'benign' ? 'existing' : 'refused';
}

module.exports = { REJECTIONS_FILENAME, isDurableSkip, isDurablyRejected, recordDurableRejection, bucketWriteResult };
