'use strict';

/**
 * Rows written only by the legacy LLM 'web-search' discovery step (BRO-5081).
 *
 * That step made up the row by itself: no aggregator or page ever vouched for
 * it, so its url, byline and excerpt fields (dtliExcerpt and friends) are the
 * step's own guesses. 0 of 34 reachable review pages contained the excerpt.
 * Pure, no I/O.
 *
 * The writer was gather-reviews.js searchForReview(), which asked Claude for a
 * review url WITHOUT web-search tools and wrote whatever came back tagged
 * source:'web-search' (deleted in df2f305f80e, Feb 2026: "271 fabricated
 * entries"). Its rows are still the bulk of the dead urls the gap engine hit
 * in BRO-7171 Stage 4 (WaPo 25/31, WSJ 15/16, New Yorker 10/12, NYT 4/5:
 * invented ids like ".../8c5c5a5a-e4a1-11e5-..._story.html",
 * "...-4c8b8c8a"). findWebSearchSourceWrites() is the class guard that keeps
 * any new code from writing that tag again (legacy-web-search.test.mjs).
 */
function isLegacyWebSearchOnly(data) {
  if (!data) return false;
  const sources = [].concat(data.sources || [], data.source || []).filter((x) => typeof x === 'string' && x);
  return sources.length > 0 && sources.every((x) => x === 'web-search');
}

// `source: 'web-search'`, `source = "web-search"`, `sources.push('web-search')`.
const WRITE_RE = /\bsources?\s*(?::|=(?!=)|\.push\(|\.add\()\s*\[?\s*['"`]web-search['"`]/g;

/**
 * Lines of `src` that tag a record source as 'web-search'. Comment lines are
 * ignored; comparisons (`=== 'web-search'`) are not writes. Pure.
 * @param {string} src
 * @returns {Array<{line:number, text:string}>}
 */
function findWebSearchSourceWrites(src) {
  const out = [];
  String(src || '').split('\n').forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
    WRITE_RE.lastIndex = 0;
    if (WRITE_RE.test(text)) out.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

// A human checked and found no such review exists: never routed to url finding.
function isUserVerifiedFabrication(data) {
  return !!data && data.fabricatedEntry === true && /^User-verified/i.test(String(data.fabricatedReason || ''));
}

const FLAG_REASON_PREFIX = 'Legacy web-search row (BRO-7171):';

/**
 * Should a legacy web-search-only row carry fabricatedEntry (the flag the
 * rebuild, the collector and coverage-holes skip on)? Only on evidence that
 * the stored url never served this review: no url, or the url is dead
 * (stored httpStatus 404/410, incompleteReason url_dead, a failed-fetches
 * url_dead row, or a fresh status probe of 404/410), AND no fetched article
 * text is on file (empty, or the text is just the row's own excerpt). Many
 * web-search urls were real (591 rows hold complete text), so a live url, a
 * paywall or an unreadable page is never enough. A fabricatedEntry of false
 * is a deliberate clear (review-field-edit: clear-only) and stays. Pure.
 * @param {object} data review file
 * @param {{ffReason?: string, probeStatus?: number|null}} [ev]
 * @returns {{fabricatedEntry: true, fabricatedReason: string}|null}
 */
function legacyWebSearchFlagPatch(data, { ffReason = '', probeStatus = null } = {}) {
  if (!isLegacyWebSearchOnly(data) || data.fabricatedEntry === true || data.fabricatedEntry === false) return null;
  if (data.contentTier === 'complete') return null;
  const text = String(data.fullText || '').trim();
  if (text) {
    const { EXCERPT_FIELDS } = require('./excerpt-fields');
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const t = norm(text);
    const ownExcerpt = EXCERPT_FIELDS.some((f) => typeof data[f] === 'string' && data[f].trim().length >= 20 && t.includes(norm(data[f]).slice(0, 60)));
    const fetched = !!(data.textFetchedAt || data.fetchMethod || data.recoveredVia);
    if (fetched && !ownExcerpt) return null; // real text came from somewhere
  }
  const dead = (s) => s === 404 || s === 410;
  let evidence = null;
  if (!data.url) evidence = 'no url';
  else if (dead(data.httpStatus)) evidence = `url answered ${data.httpStatus}`;
  else if (dead(probeStatus)) evidence = `url answered ${probeStatus}`;
  else if (data.incompleteReason === 'url_dead') evidence = 'incompleteReason url_dead';
  else if (/^url_dead/.test(String(ffReason || ''))) evidence = `failed fetch ${ffReason}`;
  if (!evidence) return null;
  return { fabricatedEntry: true, fabricatedReason: `${FLAG_REASON_PREFIX} ${evidence}, no fetched text; the row, url and excerpt came only from the deleted LLM web-search step` };
}

module.exports = { isLegacyWebSearchOnly, findWebSearchSourceWrites, isUserVerifiedFabrication, legacyWebSearchFlagPatch, FLAG_REASON_PREFIX };
