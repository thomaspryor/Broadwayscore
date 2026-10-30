'use strict';

const fs = require('fs');
const { checkRoundupRunWindow } = require('./roundup-link-coverage');
const {
  validateRoundupPageTitle,
  isPunctuationFalsePositive,
  checkTitleMatchSiblingGuards,
  buildSiblingCategoriesFromShows,
  detectPageMarketQualifier,
} = require('./show-matching');
const { categoriesOfCoreTitle } = require('./title-containment');
const path = require('path');
const { pageTitleTypoMatch } = require('./fuzzy-title-token');

// Shows whose BWW roundup URL a human listed in data/bww-roundup-urls.json.
// Only those get the one-typo title rescue below (BWW titled one roundup
// "CELEBRITY AUTOPBIOGRAPHY"); a discovered page never does.
let _overrideShowIds = null;
function hasBwwRoundupOverride(showId) {
  if (!showId) return false;
  if (!_overrideShowIds) {
    try {
      _overrideShowIds = new Set(Object.keys(JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'data', 'bww-roundup-urls.json'), 'utf8'))));
    } catch { _overrideShowIds = new Set(); }
  }
  return _overrideShowIds.has(showId);
}

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
 * isPunctuationFalsePositive()'s own jsdoc. A rescued page still goes through
 * checkTitleMatchSiblingGuards() (the same sibling checks a word-matched page
 * gets inside validateRoundupPageTitle), so a rescue can never bypass them
 * (BRO-3607).
 *
 * Originally BWW-only (bww-archive-category-guard.js); generalized to
 * archive-cache-guard.js by BRO-2565 once DTLI, Playbill Verdict, NYC
 * Theatre, and London Box Office all needed the identical predicate — the
 * function itself was already source-agnostic (it only ever looked at
 * show.title/show.category), so the rename carries no behavior change.
 *
 * @param {string} html
 * Roundup/Verdict pages also have to pass the run-window check before any
 * title match or punctuation rescue can be trusted.
 *
 * @param {{title: string, category: string, openingDate?: string, previewsStartDate?: string, venue?: string}} show
 * @param {string[]} [siblingCategories]
 * @returns {object} same shape as validateRoundupPageTitle(); a rescued
 *   punctuation false positive comes back with ok:true and rescued:true, or
 *   ok:false with the sibling guard's reason and rescuedTitle:true when the
 *   rescued page is really a sibling's.
 */
// BRO-6141: shows whose containing-title sibling is the same work in another market,
// checked against the archived pages. Add a show here only after reading both titles.
const SAME_WORK_OTHER_MARKET_SHOWS = new Set([
  'tina-2019',                          // West End "Tina The Tina Turner Musical" (2018)
  'old-friends-west-end-2023',          // Broadway "Stephen Sondheim's Old Friends" (2025)
  'the-old-man-and-the-pool-west-end-2023', // Broadway "Mike Birbiglia: The Old Man & The Pool"
]);

function checkArchiveCategory(html, show, siblingCategories) {
  let check = validateRoundupPageTitle(html, show.title, show.category, siblingCategories);
  const typoRescue = () => /Review Roundup/i.test(check.pageTitle || '')
    && hasBwwRoundupOverride(show.id) && !!pageTitleTypoMatch(show.title, html);
  // containing-title-sibling means a longer title in shows.json contains this
  // one. When that longer title is only ever another MARKET's production of the
  // same work and the page itself names THIS show's market ("Tina ... on
  // Broadway" vs the West End "Tina The Tina Turner Musical", Show Score's
  // "Old Friends (West End)" vs the 2025 Broadway "Stephen Sondheim's Old
  // Friends"), the page is this show's, not a sibling's (BRO-6141). A longer
  // title that also exists in the page's own market stays rejected.
  // Only for shows verified by hand as the same work (SAME_WORK_OTHER_MARKET_SHOWS):
  // a containing title can also be a DIFFERENT work ("A Christmas Carol" vs the
  // West End "A Christmas Carol Goes Wrong"), and title words cannot tell those apart.
  if (check.reason === 'containing-title-sibling' && check.sibling && check.pageTitle
      && SAME_WORK_OTHER_MARKET_SHOWS.has(show.id)) {
    // Did They Like It carries no market word in its titles; it reviews
    // Broadway productions, so its canonical host stands in for "on Broadway".
    const qualifier = detectPageMarketQualifier(html, check.pageTitle)
      || (/<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/(?:www\.)?didtheylikeit\.com\//i.test(html) ? 'broadway' : null);
    const siblingCats = categoriesOfCoreTitle(check.sibling);
    if (qualifier && qualifier === show.category && siblingCats.length && !siblingCats.includes(qualifier)) {
      check = { ok: true, reason: 'matched-other-market-sibling', pageTitle: check.pageTitle, confidence: check.confidence, rescued: true };
    }
  }
  if (check.reason === 'page-title-mismatch'
      && (isPunctuationFalsePositive(check.pageTitle, show.title) || typoRescue())) {
    // A rescue only proves the page names this title. The sibling guards a
    // word-matched page gets (containing-title-sibling, cross-market-sibling)
    // must still run, or a regional show's cache holding its Broadway
    // sibling's "(Broadway)" page is rescued and accepted (BRO-3607).
    const siblingFailure = checkTitleMatchSiblingGuards(
      html, check.pageTitle, show.title, show.category, siblingCategories);
    if (siblingFailure) {
      return { ok: false, pageTitle: check.pageTitle, rescuedTitle: true, ...siblingFailure };
    }
    check = { ...check, ok: true, rescued: true };
  }
  if (check.ok) {
    // Scope run-window checks to roundup/Verdict pages, not evergreen show
    // listings (BWW /reviews/, Show Score, etc.) that share this guard.
    const kind = /Review Roundup/i.test(check.pageTitle) ? 'bww-roundups'
      : /\bPlaybill\b/i.test(check.pageTitle) ? 'playbill-verdict' : null;
    if (kind) return { ...check, ...checkRoundupRunWindow(html, show, kind) };
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
  // ENOENT-tolerant throughout (BRO-3621): gather-reviews.js and
  // opening-night-poller.js read and purge the same files with no lock. Both
  // run this same predicate on the same shows.json, so their verdicts agree;
  // the one real race is a file vanishing between steps (the other reader
  // purged it), which must read as "no cache", not crash the run.
  let html;
  try {
    const age = (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24);
    if (age >= maxAgeDays) return null;
    html = fs.readFileSync(archivePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const check = checkArchiveCategory(html, show, siblingCategories);
  if (check.ok) {
    return { valid: true, html, check };
  }
  try {
    fs.unlinkSync(archivePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
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
 * Files named by a show's slug (older Playbill Verdict runs) resolve to that
 * show too, so they are checked rather than waved through.
 *
 * @returns {(html: string, showId: string) => object|null} the failing check
 *   (validateRoundupPageTitle() shape), or null when the page passes or the id
 *   is not in shows.
 */
function makeArchiveShowChecker(shows) {
  const byId = {};
  for (const s of shows) if (s && s.id) byId[s.id] = s;
  for (const s of shows) if (s && s.slug && !byId[s.slug]) byId[s.slug] = s;
  const siblings = buildSiblingCategoriesFromShows(shows);
  return (html, showId) => {
    const show = byId[showId];
    if (!show) return null;
    const check = checkArchiveCategory(html, show, siblings[show.id]);
    return check.ok ? null : check;
  };
}

/**
 * makeArchiveShowChecker() shaped for the aggregator COUNT readers
 * (build-aggregator-truth.js, audit-aggregator-coverage.js): a wrong-show page
 * comes back as an explicit 'wrong-show' result instead of a count, so the
 * show is reported as such rather than compared against another show's count
 * (BRO-4563) or filed as never-searched. Shows load lazily, once.
 *
 * @param {() => Array<object>} loadShows
 * @returns {(html: string, showId: string) => null|{reviewCount: null, hasArchive: false, error: 'wrong-show', reason: string, pageTitle: string}}
 */
function makeArchiveCountGuard(loadShows) {
  let checker = null;
  return (html, showId) => {
    if (!checker) checker = makeArchiveShowChecker(loadShows());
    const check = checker(html, showId);
    if (!check) return null;
    return { reviewCount: null, hasArchive: false, error: 'wrong-show', reason: check.reason, pageTitle: check.pageTitle };
  };
}

/**
 * Full identity check for a page about to be cached or trusted under a show:
 * checkArchiveCategory() first (sync, free, catches cross-market siblings),
 * then validatePageMatchesShow() (title + opening year + production category;
 * an LLM tiebreak only on partial title matches). Same pair the Playbill
 * Verdict Google path already runs at read and write time.
 *
 * @param {string} html
 * @param {{title: string, category: string, openingDate?: string}} show
 * @param {string[]} [siblingCategories]
 * @param {{validatePage?: Function}} [opts] test seam for validatePageMatchesShow
 * @returns {Promise<{ok: true}|{ok: false, reason: string, pageTitle?: string}>}
 */
async function checkArchivePageIdentity(html, show, siblingCategories, { validatePage } = {}) {
  const cat = checkArchiveCategory(html, show, siblingCategories);
  if (!cat.ok) return { ok: false, reason: cat.reason, pageTitle: cat.pageTitle };
  const validate = validatePage || require('./page-validator').validatePageMatchesShow;
  const v = await validate(html, show.title, {
    openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
    category: show.category,
  });
  return v.valid ? { ok: true } : { ok: false, reason: v.reason };
}

/**
 * Remembers pages that were fetched and then REJECTED (wrong market, wrong
 * show), keyed by url + show id, so a rejected page costs one paid fetch per
 * maxAgeDays instead of one per run. Rejected pages are never written to the
 * archive (BRO-3608), so the archive's own 14-day freshness can no longer
 * stand in for this. A missing or corrupt file starts empty.
 *
 * @param {string} ledgerPath  JSON file: { [url]: {showId, reason, at} }
 * @param {{maxAgeDays?: number, now?: () => number}} [opts]
 */
function createRejectedPageLedger(ledgerPath, { maxAgeDays = 14, now = Date.now } = {}) {
  let entries = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed;
  } catch { /* missing or corrupt: start empty */ }
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const fresh = (e) => e && now() - Date.parse(e.at) < maxAgeMs;
  // One url can be matched to several shows; each rejection is its own row.
  const key = (url, showId) => `${showId} ${url}`;
  return {
    recentRejection(url, showId) {
      const e = entries[key(url, showId)];
      return fresh(e) ? e : null;
    },
    record(url, showId, reason) {
      entries[key(url, showId)] = { url, showId, reason, at: new Date(now()).toISOString() };
    },
    save() {
      const kept = {};
      for (const [k, e] of Object.entries(entries)) if (fresh(e)) kept[k] = e;
      fs.writeFileSync(ledgerPath, JSON.stringify(kept, null, 2) + '\n');
    },
  };
}

module.exports = {
  SAME_WORK_OTHER_MARKET_SHOWS,
  readCachedArchiveIfValid,
  checkArchiveCategory,
  makeArchiveShowChecker,
  makeArchiveCountGuard,
  checkArchivePageIdentity,
  createRejectedPageLedger,
};
