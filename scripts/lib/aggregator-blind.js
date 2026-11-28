'use strict';

/**
 * BRO-6910: is a gap audit blind for this show?
 *
 * Broadway openings, and off-Broadway openings the major press reviews, get a
 * Playbill Verdict and/or a BWW Review Roundup within a day or two. When the
 * audit found neither, it had no aggregator list to compare against, so its
 * "0 gaps" means "did not look", not "nothing missing". Clifford Odets'
 * Waiting for Lefty graded PASS on 2026-11-03 this way while four
 * Verdict-listed reviews were missing.
 *
 * Judged at AUDIT time (the row's computedAt), never grading time: a row
 * audited on opening night, before any roundup exists, is not blind, and a
 * blind row does not turn PASS by ageing. Window: 36 hours to 30 days after
 * the openingDate (a UTC-midnight date, so 24h would fire on opening night ET;
 * 36h is the next morning ET, when the Verdict is normally up: Lefty's was by
 * the 42.5h audit. 30 days is how long the audit searches the Verdict page).
 *
 * "Roundup expected": every Broadway show; an off-Broadway show only once 2+
 * tier-1/2 outlets are known for it (live reviews plus cross-show URL guard
 * drops). Measured on main's gap audit 2026-11-03: of off-Broadway rows
 * audited in-window, 19 with an article are "expected", 4 are not; 23 without
 * one are not expected and stay PASS, 8 are BLIND (fish, the-ask, triumph,
 * night-of-january-16th among them, shows whose reviews no automatic source
 * found).
 */

const { isBroadwayCategory, isOffBroadwayCategory } = require('./venue-classification');

const DAY_MS = 86400000;
const BLIND_AFTER_HOURS = 36;
const BLIND_UNTIL_DAYS = 30;
const MIN_MAJOR_OUTLETS = 2;
const MAJOR_TIER = 2;

function roundupExpected(show, majorOutletCount = 0) {
  if (!show) return false;
  if (isBroadwayCategory(show)) return true;
  return isOffBroadwayCategory(show) && majorOutletCount >= MIN_MAJOR_OUTLETS;
}

function isAggregatorBlind(show, aggregatorArticles, auditAtMs, { majorOutletCount = 0 } = {}) {
  if (!roundupExpected(show, majorOutletCount)) return false;
  const opened = Date.parse(show.openingDate || '');
  if (!Number.isFinite(opened) || !Number.isFinite(auditAtMs)) return false;
  const age = auditAtMs - opened;
  if (age < BLIND_AFTER_HOURS * 3600000 || age > BLIND_UNTIL_DAYS * DAY_MS) return false;
  return !(Array.isArray(aggregatorArticles) && aggregatorArticles.length > 0);
}

/** Distinct tier-1/2 outlet ids among `outletIds`, by the outlet registry's tier. */
function countMajorOutlets(outletIds, registryOutlets) {
  const seen = new Set();
  for (const id of outletIds || []) {
    const o = id && registryOutlets && registryOutlets[id];
    if (o && Number(o.tier) >= 1 && Number(o.tier) <= MAJOR_TIER) seen.add(id);
  }
  return seen.size;
}

let registryCache = null;
function loadRegistryOutlets() {
  if (!registryCache) {
    try {
      const reg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'data', 'outlet-registry.json'), 'utf8'));
      registryCache = reg.outlets || reg;
    } catch { registryCache = {}; }
  }
  return registryCache;
}

/**
 * Tier-1/2 outlets known for a show: its live reviews plus the reviews the
 * cross-show URL guard dropped for it (ledger rows), which are exactly the
 * outlets a blind audit would otherwise never see.
 */
function majorOutletCountFor(showId, { reviews = [], ledgerRows = [], registryOutlets = loadRegistryOutlets() } = {}) {
  const ids = [];
  for (const r of reviews) if (r && r.showId === showId && r.outletId) ids.push(r.outletId);
  for (const d of ledgerRows) if (d && d.showId === showId && d.outletId) ids.push(d.outletId);
  return countMajorOutlets(ids, registryOutlets);
}

module.exports = { isAggregatorBlind, roundupExpected, countMajorOutlets, majorOutletCountFor, BLIND_AFTER_HOURS, BLIND_UNTIL_DAYS, MIN_MAJOR_OUTLETS };
