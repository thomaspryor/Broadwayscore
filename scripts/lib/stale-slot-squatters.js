'use strict';

/**
 * stale-slot-squatters.js (BRO-5501): two ways a wrong-production file silently
 * costs a show a good review. Pure detectors; scripts/audit-stale-slot-squatters.js
 * feeds them the on-disk review-texts tree.
 *
 * 1. dropped-by-wrong-twin: file A carries duplicateOf/duplicateTextOf -> B, B is
 *    flagged wrongProduction/wrongShow, A is not flagged itself and its text is
 *    NOT B's text. The rebuild inherits B's flag onto A (duplicateOfInheritedFlag),
 *    so A, a real review, never reaches reviews.json (cherry-orchard-west-end-2026:
 *    standard--unknown.json -> standard--nick-curtis.json, 2024 Andrews text).
 *
 * 2. stale-slot-squatter: a wrongProduction file whose publishDate is long before
 *    the show opened but whose URL no other show folder owns. The URL is almost
 *    certainly this production's own review page with another production's text
 *    stored under it (timeout-london--andrzej-lukowski, times-uk--clive-davis).
 *    The file keeps the outlet+critic slot, so the real review's ingest collides
 *    with it. Fix: delete it and refetch the url.
 *    These are CANDIDATES: a genuine old-production review (e.g. a 2016 revival
 *    review under a unique url) matches too, so a human reads the file first.
 */

const { toDateMs } = require('./date-utils');
const guards = require('./review-guards');
const { textsConfirmedDifferent } = guards;

const DAY_MS = 86400000;
const MIN_REVIEW_CHARS = 400;
const SQUATTER_AGE_DAYS = 365;

function wrongContentFlag(d) {
  if (!d || typeof d !== 'object') return null;
  // Mirror the rebuild's clears (review-guards explainExclusion) so a human-verified file is never reported.
  if (d.wrongProduction === true) {
    const cleared = d.wrongProductionManualClear === true || d.wrongProductionOverride === true ||
      d.humanReviewedWrongProduction === false ||
      (typeof guards.isFreshWpAutoCleared === 'function' && guards.isFreshWpAutoCleared(d));
    if (!cleared) return 'wrongProduction';
  }
  if (d.wrongShow === true && !guards.wrongShowCleared(d)) return 'wrongShow';
  return null;
}

/** files: [{file, data}] of ONE show folder. */
function findDroppedByWrongTwin(files) {
  const byName = new Map(files.map((f) => [f.file, f.data]));
  const out = [];
  for (const { file, data } of files) {
    if (!data || wrongContentFlag(data)) continue;
    for (const field of ['duplicateOf', 'duplicateTextOf']) {
      const ptr = data[field];
      if (typeof ptr !== 'string' || !ptr.endsWith('.json')) continue;
      const twin = byName.get(ptr);
      const flag = wrongContentFlag(twin);
      if (!flag) continue;
      if (data.duplicateOfFlagInheritanceCleared === true) continue;
      // Circular pair with different text: the rebuild keeps both (no inheritance).
      if (twin.duplicateOf === file || twin.duplicateTextOf === file) continue;
      if (String(data.fullText || '').length < MIN_REVIEW_CHARS) continue;
      // Same test the rebuild uses to decide whether to inherit the twin's flag,
      // so this audit and the rebuild cannot disagree (BRO-5501).
      if (!textsConfirmedDifferent(data.fullText, twin.fullText)) continue;
      out.push({ kind: 'dropped-by-wrong-twin', file, field, twin: ptr, twinFlag: flag });
    }
  }
  return out;
}

/**
 * files: [{file, data}] of ONE show folder; show: {openingDate};
 * urlOwners: Map<normalizedUrl, Set<showId>> over the whole tree; showId: this folder.
 */
function normalizeUrl(u) {
  return String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/#.*$/, '').replace(/\?(?!.*\b(?:p|id|oid|article|post)=).*$/, '').replace(/\/+$/, '');
}

function findStaleSlotSquatters(files, show, urlOwners, showId, normalize = normalizeUrl) {
  const opening = show && show.openingDate ? toDateMs(show.openingDate) : NaN;
  if (Number.isNaN(opening)) return [];
  const out = [];
  for (const { file, data } of files) {
    if (!data || wrongContentFlag(data) !== 'wrongProduction' || !data.url || !data.publishDate) continue;
    const pub = toDateMs(data.publishDate);
    if (Number.isNaN(pub) || opening - pub < SQUATTER_AGE_DAYS * DAY_MS) continue;
    const owners = urlOwners.get(normalize(data.url));
    const foreign = owners ? [...owners].filter((s) => s !== showId) : [];
    if (foreign.length > 0) continue; // another show's folder owns this url: a genuine old-production review
    out.push({ kind: 'stale-slot-squatter', file, url: data.url, publishDate: data.publishDate });
  }
  return out;
}

module.exports = { findDroppedByWrongTwin, findStaleSlotSquatters, wrongContentFlag, normalizeUrl };
