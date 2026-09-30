/**
 * review-slot-guards — pure predicates for the BRO-4430 coverage failures,
 * where a real review of the right production was dropped because a date, URL
 * or byline on its file was wrong, or a stale file blocked the outlet's slot.
 *
 * Each predicate is shared by every write path that hit the failure, so the
 * ingest collision check, the file writer, the URL swap and the URL repair
 * writers cannot drift apart again:
 *
 *   isStaleNonReviewSlot   a flagged file whose own url is a non-review page
 *                          (cast announcement, show/listing page, round-up)
 *                          must not block the real review for that outlet
 *                          (The Body of Mary TheaterMania, The Pass NYTG).
 *   isAggregatorPageUrl    an aggregator / round-up page is never an outlet's
 *                          own review url, so no backfill may write it into
 *                          `url` (How the Other Half Loves FT got the
 *                          westendtheatre.com round-up and was then dropped by
 *                          the rebuild's isBlockedReviewUrl gate).
 *   urlOwnedByOtherCritic  a url repair must not repoint a named critic's file
 *                          onto a url a sibling file already holds for a
 *                          DIFFERENT named critic at the same outlet (NYSR:
 *                          Finkle's file took Scheck's url, Sommers' took
 *                          Torre's, and each real review was then lost).
 *   isDatelessRevivalHold  the rebuild's dateless-revival hold only lifts when
 *   shouldRetryDatelessHoldFetch  a date arrives; the collector must fetch the
 *                          stored url for one instead of SERP-rediscovering a
 *                          url nobody doubted (An American Daughter NY Sun sat
 *                          held forever after its SERP rediscovery abandoned).
 */

const DAY_MS = 86400000;
const DATELESS_HOLD_RETRY_COOLDOWN_MS = 14 * DAY_MS;

function _classify(url) {
  const { classifyReviewUrl } = require('./non-review-url-patterns');
  return classifyReviewUrl(url);
}

function _sameUrl(a, b) {
  const { sameUrlKey } = require('./review-url-collision');
  const ka = sameUrlKey(a);
  return !!ka && ka === sameUrlKey(b);
}

/**
 * True when `url` is an aggregator or round-up page: a host the rebuild
 * refuses outright (domain-filters isBlockedReviewUrl) or a round-up/hub page
 * (review-guards isRoundupUrl). Neither can be any outlet's own review url.
 * @param {string} url
 * @returns {boolean}
 */
function isAggregatorPageUrl(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  const { isBlockedReviewUrl } = require('./domain-filters');
  if (isBlockedReviewUrl(url)) return true;
  const { isRoundupUrl } = require('./review-guards');
  const r = isRoundupUrl(url);
  return !!(r && r.isRoundup);
}

/**
 * True when `existing` is a flagged record whose own url is not a review page,
 * and `incomingUrl` is a different url that IS a review candidate. Such a
 * file's flag describes the non-review page, not a prior production of the
 * review, so it must neither block the incoming review nor keep its slot.
 * @param {object} existing  review-text record already on disk
 * @param {string} incomingUrl
 * @returns {boolean}
 */
function isStaleNonReviewSlot(existing, incomingUrl) {
  if (!existing || typeof existing !== 'object') return false;
  if (!existing.url || !incomingUrl) return false;
  if (existing._locked === true || existing.urlManualOverride === true) return false;
  // Duplicates are not stale slots: their pointer names the real record.
  if (existing.duplicateOf) return false;
  const flagged = existing.wrongProduction === true
    || existing.wrongShow === true
    || existing.isNonReview === true;
  if (!flagged) return false;
  if (_sameUrl(existing.url, incomingUrl)) return false;
  // classifyReviewUrl only (it already covers round-ups): isBlockedReviewUrl
  // also blocks some REAL review shapes (playbill.com/news/article, /features/),
  // and a flagged prior-production review there must keep blocking.
  // BRO-4431: a classifier's "not a review" verdict on the file is the same
  // evidence when the url shape can't give it (westendbestfriend.co.uk files
  // news and reviews alike under /news/: a National Theatre Live broadcast
  // post held the Golden Boy review's slot, issue 913).
  if (_classify(existing.url).ok && existing.isNonReview !== true) return false;
  const incomingVerdict = _classify(incomingUrl);
  return incomingVerdict.ok === true && !isAggregatorPageUrl(incomingUrl);
}

function _namedCritic(name) {
  if (!name || typeof name !== 'string') return null;
  const t = name.trim();
  if (!t || /^unknown$/i.test(t)) return null;
  const { normalizeCritic } = require('./review-normalization');
  return normalizeCritic(t);
}

/**
 * The sibling file that already holds `url` for a different NAMED critic, or
 * null. An Unknown on either side proves nothing about identity, so it never
 * counts as a conflict (the byline may simply be unresolved).
 * @param {object} args
 * @param {string} args.showDir       data/review-texts/<showId>
 * @param {string} args.url           candidate url for this file
 * @param {string} args.selfFilename  this file's basename
 * @param {string} args.selfCriticName this file's criticName
 * @param {object} [args.fs]          injected fs for tests
 * @returns {{filename: string, criticName: string}|null}
 */
function urlOwnedByOtherCritic({ showDir, url, selfFilename, selfCriticName, fs: fsImpl } = {}) {
  const self = _namedCritic(selfCriticName);
  if (!self || !showDir || !url) return null;
  const fs = fsImpl || require('fs');
  const path = require('path');
  let files;
  try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
  catch { return null; }
  for (const file of files) {
    if (file === selfFilename) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')); }
    catch { continue; }
    if (!data || !data.url || !_sameUrl(data.url, url)) continue;
    // A sibling already known to be wrong cannot own the url.
    if (data.duplicateOf || data.wrongAttribution === true) continue;
    const other = _namedCritic(data.criticName);
    if (other && other !== self) return { filename: file, criticName: data.criticName };
  }
  return null;
}

/**
 * True when the record is held by the rebuild's dateless-revival guard
 * (rebuild-all-reviews.js, reason 'dateless-revival').
 * @param {object} d
 * @returns {boolean}
 */
function isDatelessRevivalHold(d) {
  if (!d || d.wrongProduction !== true) return false;
  if (d.wrongProductionReason === 'dateless-revival') return true;
  return typeof d.wrongProductionNote === 'string'
    && d.wrongProductionNote.startsWith('Dateless revival guard');
}

/**
 * True when the collector should fetch a dateless-revival hold's STORED url
 * to recover its publish date. The hold's only open question is the date, so
 * the url is not in doubt and SERP rediscovery is the wrong tool; one fetch
 * per 14 days (the same wrongShowRetryAt clock the other flag retries use).
 * @param {object} d
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function shouldRetryDatelessHoldFetch(d, nowMs = Date.now()) {
  if (!isDatelessRevivalHold(d)) return false;
  if (d.publishDate) return false;
  if (!d.url || !/^https?:\/\//i.test(d.url)) return false;
  if (d._locked === true) return false;
  const last = d.wrongShowRetryAt ? Date.parse(d.wrongShowRetryAt) : NaN;
  return !Number.isFinite(last) || nowMs - last > DATELESS_HOLD_RETRY_COOLDOWN_MS;
}

module.exports = {
  isAggregatorPageUrl,
  isStaleNonReviewSlot,
  urlOwnedByOtherCritic,
  isDatelessRevivalHold,
  shouldRetryDatelessHoldFetch,
  DATELESS_HOLD_RETRY_COOLDOWN_MS,
};
