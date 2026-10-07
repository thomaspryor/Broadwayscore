/**
 * Per-show URL blocklist for the opening-night poller and gather-reviews.
 *
 * Rocky Horror 2026-04-23 bug: an operator deleted cote-notices--david-finkle.json
 * because it was a duplicate-by-URL of cote-notices--david-cote.json. Hours later
 * the poller rediscovered the same URL (with a ?triedRedirect tracking param) and
 * re-created the deleted file. This module lets the operator drop a
 * `_blocklist.json` file in the show's review-texts dir to make deletions stick.
 *
 * File format (data/review-texts/{showId}/_blocklist.json):
 *   {
 *     "urls": [
 *       { "url": "https://...", "reason": "duplicate of cote-notices--david-cote", "blockedAt": "2026-04-23T22:00:00Z" }
 *     ]
 *   }
 *
 * URL matching is normalization-aware: tracking params (utm_*, fbclid, ref,
 * mc_eid, triedRedirect) and trailing slashes are ignored.
 */

const fs = require('fs');
const path = require('path');

const BLOCKLIST_FILENAME = '_blocklist.json';

/**
 * Load and parse the blocklist for a show. Returns a Set of normalized URLs
 * and the raw metadata for logging. Missing/malformed file → empty set.
 *
 * @param {string} showDir  Absolute path to data/review-texts/{showId}
 * @returns {{ urls: Set<string>, entries: Array<{url: string, reason: string, blockedAt?: string}> }}
 */
function loadBlocklist(showDir) {
  const empty = { urls: new Set(), entries: [] };
  if (!showDir) return empty;
  const filePath = path.join(showDir, BLOCKLIST_FILENAME);
  if (!fs.existsSync(filePath)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw.urls) ? raw.urls : [];
    const urls = new Set();
    const entries = [];
    for (const item of arr) {
      const url = typeof item === 'string' ? item : item && item.url;
      if (!url) continue;
      urls.add(_normalize(url));
      entries.push({
        url,
        reason: (item && item.reason) || 'no reason given',
        blockedAt: item && item.blockedAt,
      });
    }
    return { urls, entries };
  } catch {
    return empty;
  }
}

/**
 * @param {ReturnType<typeof loadBlocklist>} blocklist
 * @param {string} url
 * @returns {null | { url: string, reason: string, blockedAt?: string }}
 *   null if not blocked, or the matching entry metadata when blocked.
 */
function findBlockedEntry(blocklist, url) {
  if (!blocklist || !url) return null;
  const n = _normalize(url);
  if (!blocklist.urls.has(n)) return null;
  return blocklist.entries.find((e) => _normalize(e.url) === n) || null;
}

/** Thin boolean-returning wrapper for call-sites that just need to skip. */
function isBlocked(blocklist, url) {
  return !!findBlockedEntry(blocklist, url);
}

function _normalize(url) {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^triedRedirect$|^ref$|^mc_eid$/.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url).toLowerCase().replace(/\/$/, '');
  }
}

module.exports = {
  loadBlocklist,
  findBlockedEntry,
  isBlocked,
  normalizeUrl: _normalize,
  BLOCKLIST_FILENAME,
};
