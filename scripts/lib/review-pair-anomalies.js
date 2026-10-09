/**
 * review-pair-anomalies.js — two read-only detectors for review-text files that
 * look right on their own but wrong next to a sibling (BRO-4888 prevention).
 *
 *  1. findSameTextDifferentByline: two files of the SAME outlet in one show dir
 *     whose texts start identically and have about the same length, filed
 *     under DIFFERENT plausible critic names and DIFFERENT urls. One of them
 *     carries the wrong byline (a Theatre Record copy credited to the wrong
 *     reviewer, an aggregator copy under the page's headline writer). The
 *     SAME-url version of this is dedupe-same-url-bylines.js's job, so it is
 *     deliberately not reported here. A file with NO url counts as a different
 *     url on purpose: a Theatre Record copy is stored without one; files that already carry a duplicate
 *     pointer, are flagged wrong-production/non-review, or belong to a wire
 *     service are skipped.
 *  2. findOwnDomainRoundupFlags: isRoundupArticle=true on a file whose CURRENT
 *     url is a per-article page on the outlet's OWN domain and not a roundup
 *     url (the telegraph--dominic-cavendish shape: the flag was set while the
 *     file held an LBO roundup url, the url was later corrected, the flag
 *     stayed). Many hits are genuine multi-show roundups on an outlet's own
 *     domain, so every hit needs a person to read it before any flag is touched.
 *     Report-only: review-guards.js isLikelyStaleRoundupFlag keeps an
 *     allowlist on purpose (multi-show roundups also live on an outlet's own
 *     domain), so this must not feed an auto-clear.
 *
 * Pure: no fs, no network. The driver (scripts/audit-review-pair-anomalies.js)
 * supplies the records. Tested by tests/unit/revival-promo-prior-run-id.test.mjs.
 */

'use strict';

const { isPlausiblePersonName } = require('./byline-recovery');
const { computeContentFingerprint } = require('./content-quality');
const { isRoundupUrl } = require('./review-guards');
const { hostMatchesOutletDomain } = require('./outlet-domain-validation');
const { WIRE_SERVICE_OUTLETS, normalizeUrl } = require('./review-normalization');

const MIN_TEXT_CHARS = 500;
const MIN_ROUNDUP_TEXT_CHARS = 800;
const MIN_LENGTH_RATIO = 0.95;
const PREFIX_CHARS = 200;

function textLen(d) {
  return String((d && d.fullText) || '').trim().length;
}

function isExcluded(d) {
  if (!d) return true;
  if (d.duplicateOf || d.duplicateTextOf || d.isSyndicatedDuplicate) return true;
  if (d.wrongProduction === true || d.wrongShow === true || d.isNonReview === true) return true;
  return false;
}

function sameUrl(a, b) {
  if (!a || !b) return false;
  try { return normalizeUrl(a) === normalizeUrl(b); } catch { return a === b; }
}

/**
 * @param {Array<{file: string, data: object}>} records  every file of ONE show dir
 * @returns {Array<{files: string[], names: string[], outletId: string, urls: Array<string|null>}>}
 */
function findSameTextDifferentByline(records) {
  const groups = new Map();
  for (const { file, data } of records || []) {
    if (isExcluded(data)) continue;
    if (textLen(data) < MIN_TEXT_CHARS) continue;
    const outletId = String(data.outletId || '').toLowerCase();
    if (!outletId || WIRE_SERVICE_OUTLETS.has(outletId)) continue;
    const name = String(data.criticName || '').trim();
    if (!isPlausiblePersonName(name)) continue;
    const fp = computeContentFingerprint(data.fullText, PREFIX_CHARS);
    if (!fp) continue;
    const key = `${outletId}|${fp}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file, data, name });
  }
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const names = new Set(members.map((m) => m.name.toLowerCase()));
    if (names.size < 2) continue;
    // Pairwise: keep a group only if two members differ in name AND url AND length ratio holds.
    const flagged = new Set();
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        if (a.name.toLowerCase() === b.name.toLowerCase()) continue;
        if (a.data.url && b.data.url && sameUrl(a.data.url, b.data.url)) continue; // dedupe-same-url-bylines.js's case
        const la = textLen(a.data), lb = textLen(b.data);
        if (Math.min(la, lb) / Math.max(la, lb) < MIN_LENGTH_RATIO) continue;
        flagged.add(i); flagged.add(j);
      }
    }
    if (flagged.size < 2) continue;
    const picked = [...flagged].map((i) => members[i]);
    out.push({
      files: picked.map((m) => m.file),
      names: picked.map((m) => m.name),
      outletId: String(picked[0].data.outletId),
      urls: picked.map((m) => m.data.url || null),
    });
  }
  return out;
}

/**
 * @param {Array<{file: string, data: object}>} records
 * @param {object} registry  loaded outlet-registry.json
 * @returns {Array<{file: string, url: string, outletId: string, reason: string|null}>}
 */
function findOwnDomainRoundupFlags(records, registry) {
  const out = [];
  for (const { file, data } of records || []) {
    if (!data || data.isRoundupArticle !== true) continue;
    if (textLen(data) < MIN_ROUNDUP_TEXT_CHARS) continue;
    const url = data.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    if (isRoundupUrl(url).isRoundup) continue;
    if (hostMatchesOutletDomain(url, data.outletId, registry) !== true) continue;
    out.push({ file, url, outletId: String(data.outletId), reason: data.roundupArticleReason || null });
  }
  return out;
}

module.exports = { findSameTextDifferentByline, findOwnDomainRoundupFlags, MIN_TEXT_CHARS, MIN_ROUNDUP_TEXT_CHARS, MIN_LENGTH_RATIO, PREFIX_CHARS };
