'use strict';

const fs = require('fs');
const { validateRoundupPageTitle, isPunctuationFalsePositive, buildSiblingCategoriesFromShows } = require('./show-matching');

/**
 * The one place "is this archive's category/title acceptable" gets decided —
 * used at write time (BWW's /reviews/ and roundup writes in
 * scrape-bww-reviews.js, plus the DTLI/Playbill Verdict/NYC Theatre/London
 * Box Office write paths) AND at read time (readCachedArchiveIfValid below).
 *
 * Wraps validateRoundupPageTitle() with the SAME 'page-title-mismatch' rescue
 * the standing audit (scripts/audit-aggregator-archive-integrity.js) applies
 * via isPunctuationFalsePositive — trailing punctuation, dotted acronyms,
 * slash-joined titles, byline-prefixed subtitles. Before this, that rescue
 * lived only in the audit; each scraper's write-time and read-time guards
 * had started drifting from the audit's actual acceptance policy in opposite
 * directions (a write guard stricter than the audit rejects valid pages; a
 * read guard rescuing a page the write guard then refuses to save means that
 * page can never be cached at all). One predicate, used everywhere a "keep
 * or drop this archive" decision is made, closes that drift for good.
 * NOT applied to 'cross-market-sibling' — a distinct, deliberate check per
 * isPunctuationFalsePositive()'s own jsdoc.
 *
 * Originally BWW-only (bww-archive-category-guard.js); generalized to
 * archive-cache-guard.js by BRO-2565 once DTLI, Playbill Verdict, NYC
 * Theatre, and London Box Office all needed the identical predicate — the
 * function itself was already source-agnostic (it only ever looked at
 * show.title/show.category), so the rename carries no behavior change.
 *
 * @param {string} html
 * @param {{title: string, category: string}} show
 * @param {string[]} [siblingCategories]
 * @returns {object} same shape as validateRoundupPageTitle(); a rescued
 *   punctuation false positive comes back with ok:true and rescued:true.
 */
function checkArchiveCategory(html, show, siblingCategories) {
  const check = validateRoundupPageTitle(html, show.title, show.category, siblingCategories);
  if (check.ok) return check;
  if (check.reason === 'page-title-mismatch' && isPunctuationFalsePositive(check.pageTitle, show.title)) {
    return { ...check, ok: true, rescued: true };
  }
  return check;
}

/**
 * Read a cached aggregator archive file, but only trust it if it still
 * passes checkArchiveCategory() — the same predicate applied at write time
 * (BRO-2547's write-time guard for BWW, extended to BWW roundups by BRO-2549,
 * and to DTLI/Playbill Verdict/NYC Theatre/London Box Office by BRO-2565).
 *
 * A fresh mtime is not proof the file arrived via this scraper's validated
 * write path — a restore, a manual copy, a different writer, or a rolled-back
 * deploy can all put a poisoned file on disk with a fresh mtime, and an
 * age-only check would serve it for up to maxAgeDays regardless. When the
 * cached HTML fails the check here, the poisoned file is deleted so the
 * caller falls through to a fresh fetch, which the write-time guard then
 * protects again.
 *
 * @param {string} archivePath
 * @param {number} maxAgeDays
 * @param {{title: string, category: string}} show
 * @param {string[]} [siblingCategories]
 * @returns {null|{valid: true, html: string, check: object}|{valid: false, purged: true, check: object}}
 *   null when there is no usable cache to consider (missing file, or older
 *   than maxAgeDays — the normal "go fetch fresh" case, not a validation
 *   failure).
 */
function readCachedArchiveIfValid(archivePath, maxAgeDays, show, siblingCategories) {
  if (!fs.existsSync(archivePath)) return null;
  const age = (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24);
  if (age >= maxAgeDays) return null;

  const html = fs.readFileSync(archivePath, 'utf8');
  const check = checkArchiveCategory(html, show, siblingCategories);
  if (check.ok) {
    return { valid: true, html, check };
  }
  fs.unlinkSync(archivePath);
  return { valid: false, purged: true, check };
}

/**
 * For readers that take an archive by show id and count or parse it without
 * re-fetching (build-aggregator-truth.js). The file name is only the id it was
 * saved under: the Hay Fever roundup sat in
 * bww-roundups/richard-ii-off-west-end-2026.html and counted as 8 Richard II
 * reviews (BRO-4563). Runs checkArchiveCategory() against that id's show.
 *
 * @param {Array<{id:string,title:string,category:string}>} shows
 * @returns {(html: string, showId: string) => object|null} the failing check
 *   (validateRoundupPageTitle() shape), or null when the page passes or the id
 *   is not in shows.
 */
function makeArchiveShowChecker(shows) {
  const byId = {};
  for (const s of shows) if (s && s.id) byId[s.id] = s;
  const siblings = buildSiblingCategoriesFromShows(shows);
  return (html, showId) => {
    const show = byId[showId];
    if (!show) return null;
    const check = checkArchiveCategory(html, show, siblings[showId]);
    return check.ok ? null : check;
  };
}

module.exports = { readCachedArchiveIfValid, checkArchiveCategory, makeArchiveShowChecker };
