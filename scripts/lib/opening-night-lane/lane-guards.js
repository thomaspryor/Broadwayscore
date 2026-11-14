'use strict';
/**
 * Non-review and roundup checks the lane runs on a fetched review BEFORE it is scored (BRO-6872).
 *
 * The lane bypasses the write path's nonReview and roundupUrlSwap guards (trust-model LANE_BYPASSED_GUARDS), because
 * those judge stored files and would stand down for a lane row anyway. That let the 2026-10 replays score Gold Derby's
 * "what the critics say" roundups as Ethan Alter reviews of both shows. This applies the same detectors the regular
 * path uses, the shared functions themselves, to the page the lane fetched:
 *   - namedNonReviewReason   (non-review-url-patterns.js; e.g. Gold Derby awards news and interviews)
 *   - isRoundupPageAsReview  (review-guards.js; review-file-writer E0, e.g. Gold Derby /theater/YYYY/*-reviews/)
 *   - detectRoundupDigest    (roundup-digest.js; review-file-writer E3)
 *   - detectPullQuoteCompilation (roundup-digest.js; review-file-writer E4: a page quoting several other outlets)
 * It returns a reason, or null; it sets no flag on any record (the lane drops the row before a file exists).
 */
const { namedNonReviewReason } = require('../non-review-url-patterns');
const { isRoundupPageAsReview, isRoundupUrl } = require('../review-guards');
const { detectRoundupDigest, detectPullQuoteCompilation } = require('../roundup-digest');
const { PROVENANCE_KEY } = require('./trust-model');

/**
 * @param {{url: string, outletId?: string, fullText?: string, criticName?: string}} row (a lane row; its provenance
 *   source decides how wide the named URL patterns apply)
 * @returns {string|null} why the page is not one critic's review, or null
 */
function laneNonReviewReason(row) {
  if (!row || !row.url) return null;
  // As explainExclusion does for stored files: host-wide patterns apply only to unvetted discovery; a link an aggregator
  // cited as a review is held to the allSources patterns alone.
  const prov = row[PROVENANCE_KEY];
  const named = namedNonReviewReason(row.url, { allSourcesOnly: !!(prov && prov.source === 'aggregator') });
  if (named) return `named non-review URL (${named})`;
  // A row without an outletId still gets the outlet-keyed roundup checks (the url names the outlet).
  let outletId = row.outletId || '';
  if (!outletId) { try { outletId = (require('../review-normalization').resolveOutletFromUrl(row.url) || {}).outletId || ''; } catch { /* keep '' */ } }
  const rec = { url: row.url, outletId, fullText: row.fullText || '', criticName: row.criticName || '' };
  if (isRoundupPageAsReview(rec)) return `roundup page (${isRoundupUrl(row.url).reason || 'roundup URL'})`;
  if (/\/article\/Review-Roundup-/i.test(row.url) || /\/news\/post\/(?:review-round[-_ ]?up)/i.test(row.url)) return 'roundup page (URL pattern)';
  if (rec.fullText) {
    const digest = detectRoundupDigest(rec);
    if (digest) return `roundup digest (${digest.reason})`;
    const compilation = detectPullQuoteCompilation(rec);
    if (compilation) return `pull-quote compilation (${compilation.reason})`;
  }
  return null;
}

// Hosts whose critics file one column covering several shows (BRO-6880 column-section-extract.js COLUMN_POST_HOSTS;
// copied, not required, so the lane code hash stays small; tests/unit/opening-night-lane-column-hold.test.mjs pins it).
const COLUMN_POST_HOSTS = [/(^|\.)washingtonpost\.com$/i];
const COLUMN_WINDOW_DAYS = 45;
const COLUMN_MIN_OTHER_SHOWS = 2;
const NYC_CATEGORIES = new Set(['broadway', 'off-broadway']);

const normTitle = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
// Case kept: a title is matched as written ("The Heart" is not "at the heart of the play"). Accents fold to ASCII.
const caseText = (s) => ` ${String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim()} `;
// The name critics write: no parenthetical subtitle ("Two Strangers (Carry a Cake Across New York)"), no leading article.
const ARTICLE = /^(the|a|an) /i;
const columnTitle = (title) => caseText(String(title || '').replace(/\([^)]*\)/g, ' ')).trim().replace(ARTICLE, '');

function isColumnHost(url) {
  try { return COLUMN_POST_HOSTS.some((re) => re.test(new URL(url).hostname.replace(/^www\./, ''))); } catch { return false; }
}

/**
 * Titles of the other New York shows opening within COLUMN_WINDOW_DAYS of this one: the shows a same-week critic column
 * would cover. Two-word titles and longer only ("Company" is everyday prose); none that contains the show's own title or
 * is contained in it.
 * @returns {string[]} titles as critics write them: case kept, no leading article or parenthetical subtitle
 */
function nearbyShowTitles(show, allShows = []) {
  const at = Date.parse((show && show.openingDate) || '');
  if (!show || !at) return [];
  const own = normTitle(show.title);
  const out = new Set();
  for (const s of allShows || []) {
    if (!s || s.id === show.id || !s.title || !NYC_CATEGORIES.has(s.category)) continue;
    const t = Date.parse(s.openingDate || '');
    if (!t || Math.abs(t - at) > COLUMN_WINDOW_DAYS * 86400000) continue;
    // Two words or more once a leading article is dropped: "The Ask", "The Heart" and "Company" are everyday prose.
    const n = columnTitle(s.title);
    const low = normTitle(s.title);
    if (n.split(' ').length < 2 || own.includes(low) || low.includes(own)) continue;
    out.add(n);
  }
  return [...out];
}

/**
 * A critic column on a column host that names two or more other shows opening the same weeks is several reviews in one
 * page: scoring it whole gives this show the column's average (the 10-22 Washington Post column scored 74 as The
 * Imaginary Invalid, BRO-6872). The lane cannot cut out one show's section from the flattened page text it fetches, so it
 * holds the page unscored for the regular pipeline, whose verifier and section isolation (BRO-6880) handle it.
 * Measured on the 305 stored Washington Post texts: 22 match, all multi-show columns or pages naming 2+ same-week shows.
 * @returns {string|null}
 */
function multiShowColumnReason(row, otherTitles = []) {
  if (!row || !row.fullText || !isColumnHost(row.url) || !otherTitles.length) return null;
  const text = caseText(row.fullText);
  const named = otherTitles.filter((t) => text.includes(` ${t} `));
  if (named.length < COLUMN_MIN_OTHER_SHOWS) return null;
  return `multi-show column (also names ${named.join(', ')}); held for the regular pipeline`;
}

module.exports = { laneNonReviewReason, multiShowColumnReason, nearbyShowTitles, COLUMN_POST_HOSTS };
