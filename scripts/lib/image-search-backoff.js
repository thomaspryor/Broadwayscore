/**
 * Per-show backoff for fetch-show-images-auto.js's Google Images tier (BRO-4243).
 *
 * Google Images goes through ScrapingBee's SERP product at 25 credits per
 * search, two searches per show (square + poster). fetch-all-image-formats.yml
 * runs --missing ~2x/day, and the shows still missing images are mostly ones
 * with no findable art (small Off-West End events): all 16 shows Google-searched
 * on 2026-09-28 had also been searched the day before. That tier was ~95% of the
 * script's ScrapingBee spend (~15.5K credits/week, the 2nd-largest ledgered SB
 * consumer). Free tiers (TodayTix API, direct TodayTix/Playbill pages,
 * ShowScore) still run every time; the paid searches back off: Google Images,
 * and (follow-up) the TodayTix SERP, Playbill google.com and IBDB SERP
 * discovery searches.
 *
 * State: data/audit/image-search-attempts.json
 *   { [key]: { failures, lastAttempt } }, key = showId (Google Images) or
 *   "<tier>:<showId>" (discovery tiers; see attemptKey). Keys are NOT all show ids.
 * A hit on a tier removes that tier's key.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ATTEMPTS_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'image-search-attempts.json');
// Wait after the Nth consecutive failure (days). Caps at the last value.
const BACKOFF_DAYS = [1, 2, 4, 8, 14];
const DAY_MS = 24 * 60 * 60 * 1000;

function backoffMs(failures) {
  if (!(failures > 0)) return 0;
  return BACKOFF_DAYS[Math.min(failures, BACKOFF_DAYS.length) - 1] * DAY_MS;
}

const OPENING_WINDOW_DAYS = 14;

function isNearOpening(show, nowMs) {
  // Previews start counts too: art usually appears then, and many upcoming
  // shows have a previews date before an opening date is announced.
  return ['openingDate', 'previewsStartDate'].some((k) => {
    const t = show && show[k] ? new Date(show[k]).getTime() : NaN;
    return !Number.isNaN(t) && Math.abs(nowMs - t) <= OPENING_WINDOW_DAYS * DAY_MS;
  });
}

/**
 * Pure: should the Google Images tier be skipped for this show right now?
 * @param {{failures:number, lastAttempt:string}|undefined} entry
 * @param {number} [nowMs]
 * @param {{openingDate?:string, previewsStartDate?:string}} [show] - within ±14 days of either date the gate never skips
 * @returns {{skip:boolean, retryAt:string|null}}
 */
function shouldSkipGoogleImages(entry, nowMs = Date.now(), show = null) {
  if (!entry || !(entry.failures > 0)) return { skip: false, retryAt: null };
  // Never back off around opening: art usually first appears then, and a show
  // found weeks early would otherwise sit at the 14-day cap exactly when it
  // becomes findable.
  if (isNearOpening(show, nowMs)) return { skip: false, retryAt: null };
  const last = new Date(entry.lastAttempt).getTime();
  if (Number.isNaN(last)) return { skip: false, retryAt: null };
  const retryAtMs = last + backoffMs(entry.failures);
  return nowMs < retryAtMs
    ? { skip: true, retryAt: new Date(retryAtMs).toISOString() }
    : { skip: false, retryAt: null };
}

/**
 * Pure: next attempts map after one Google Images attempt for showId.
 * Success clears the show; failure bumps its count and stamps the time.
 */
function recordGoogleImagesAttempt(attempts, showId, success, nowMs = Date.now()) {
  const next = { ...(attempts || {}) };
  if (success) {
    delete next[showId];
  } else {
    const prev = next[showId] || { failures: 0 };
    next[showId] = { failures: (prev.failures || 0) + 1, lastAttempt: new Date(nowMs).toISOString() };
  }
  return next;
}

// Discovery-SERP tiers (BRO-4243 follow-up). After the Google Images gate
// above landed, the ledger (2026-10-13..15) showed the SAME ~90 imageless
// shows still re-searched on every --missing sweep (4-5 sweeps/day) by two
// discovery searches that had no memory: the TodayTix Google SERP lookup
// (5 Scrapingdog credits, 25 ScrapingBee credits whenever SD fails) and the
// Playbill google.com search (1+ credit, SB on fallback). They share the
// attempts file under a "<tier>:<showId>" key so the Google Images entries
// (keyed by bare showId) are untouched.
const TODAYTIX_SERP_TIER = 'todaytix-serp';
const PLAYBILL_SERP_TIER = 'playbill-serp';
const IBDB_SERP_TIER = 'ibdb-serp';

/**
 * Pure: is this fetched google.com/search HTML a block/consent interstitial
 * rather than a results page? Such a response says nothing about whether the
 * show has a page, so it must not count as a miss.
 */
function isGoogleBlockPage(html) {
  if (!html || typeof html !== 'string') return true;
  return /unusual traffic|detected unusual|\/sorry\/index|g-recaptcha|recaptcha\/api|enablejs|httpservice\/retry|Before you continue to Google/i.test(html);
}

function attemptKey(tier, showId) {
  return tier ? `${tier}:${showId}` : showId;
}

/**
 * Pure: should a paid search tier run for this show on this run?
 * Targeted runs (force) always search; otherwise the shared backoff applies.
 * @param {object} attempts - the attempts map
 * @param {string|null} tier - null = the Google Images tier (bare showId key)
 * @param {{id:string, openingDate?:string, previewsStartDate?:string}} show
 * @param {{force?:boolean, nowMs?:number}} [opts]
 * @returns {{skip:boolean, retryAt:string|null, key:string, failures:number}}
 */
function searchTierGate(attempts, tier, show, opts = {}) {
  const key = attemptKey(tier, show.id);
  const entry = (attempts || {})[key];
  const failures = (entry && entry.failures) || 0;
  if (opts.force) return { skip: false, retryAt: null, key, failures };
  const { skip, retryAt } = shouldSkipGoogleImages(entry, opts.nowMs == null ? Date.now() : opts.nowMs, show);
  return { skip, retryAt, key, failures };
}

/**
 * Pure: what the TodayTix SERP tier records for one discoverTodayTixId result.
 * @param {boolean} fromSerp - the id came from the paid SERP (not the direct search)
 * @param {boolean} ownerRejected - another show owns that TodayTix id
 * @returns {boolean|null} true = hit, false = miss, null = nothing to record
 * Only called after the owner check, so a rejected hit is a plain miss and
 * never a success-then-miss (which would reset failures to 1).
 */
function todaytixSerpHitOutcome(fromSerp, ownerRejected) {
  if (!fromSerp) return null;
  return !ownerRejected;
}

function loadImageSearchAttempts(p = ATTEMPTS_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveImageSearchAttempts(attempts, p = ATTEMPTS_PATH) {
  const sorted = Object.fromEntries(Object.keys(attempts).sort().map((k) => [k, attempts[k]]));
  fs.writeFileSync(p, JSON.stringify(sorted, null, 2) + '\n');
}

module.exports = {
  ATTEMPTS_PATH,
  BACKOFF_DAYS,
  OPENING_WINDOW_DAYS,
  TODAYTIX_SERP_TIER,
  PLAYBILL_SERP_TIER,
  IBDB_SERP_TIER,
  attemptKey,
  isGoogleBlockPage,
  todaytixSerpHitOutcome,
  searchTierGate,
  shouldSkipGoogleImages,
  recordGoogleImagesAttempt,
  loadImageSearchAttempts,
  saveImageSearchAttempts,
};
