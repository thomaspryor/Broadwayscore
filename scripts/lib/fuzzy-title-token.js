/**
 * One-typo title-token tolerance for BWW Review-Roundup slug matchers.
 *
 * Why: BWW slugged the 2026 Other Desert Cities roundup
 * "Review-Roundup-OTHER-DESERT-CITES-Returns-to-Broadway-Updating-Live-20261019"
 * ("CITES"). Both slug matchers (bww-roundup-validator titleWordsPassSlugCheck,
 * bww-rr-discover slugMatchesShow) demand exact word membership, so the poller
 * never read the roundup until a manual override went into
 * data/bww-roundup-urls.json.
 *
 * Deliberately narrow, because loose fuzzy title matching once filed 27
 * wrong-show archives: callers use this ONLY after their exact match fails,
 * ONLY when the slug's trailing YYYYMMDD is within FUZZY_DATE_WINDOW_DAYS of the
 * show's openingDate, a fuzzy match ranks below every exact match, and it is
 * rejected outright when another active show matches the slug exactly.
 *
 * Token rule (tokenFuzzyMatch): the title needs >= 2 significant tokens; every
 * token must match a slug word exactly except at most ONE, which must be >= 5
 * letters, not a generic word, and within one Damerau-Levenshtein edit
 * (insert / delete / substitute / adjacent swap) of some slug word.
 */

const path = require('path');
const { withinOneEdit, QUERY_NOISE_WORDS } = require('./show-search-match');

const FUZZY_MIN_TOKEN_LEN = 5;
const FUZZY_MIN_TITLE_TOKENS = 2;
const FUZZY_DATE_WINDOW_DAYS = 14;
// Every non-closed show can own a slug: a near-twin still at upcoming/announced
// (status lags) must block a fuzzy claim on its roundup just like an open one.
const INACTIVE_STATUSES = new Set(['closed']);

// BWW slug boilerplate is never a title word, so a title token one edit away
// from "opens"/"returns"/"updating" must not count as a match.
const SLUG_BOILERPLATE = new Set(['opens', 'opening', 'returns', 'reopens', 'premieres', 'debuts',
  'updating', 'review', 'reviews', 'roundup', 'broadway', 'critics', 'weigh', 'starring',
  // venue / market words that sit in slugs beside the title
  'theatre', 'theater', 'theatres', 'theaters', 'premiere', 'playhouse', 'london', 'national',
  'center', 'centre', 'stage', 'world', 'musical', 'revival']);

/**
 * @param {string[]} titleTokens significant title tokens (stop words removed)
 * @param {Iterable<string>} slugWords the slug's words
 * @param {{isExact?: (token: string) => boolean}} [opts] exact predicate
 *   (callers with looser exact rules, e.g. a trailing plural S, pass theirs)
 * @returns {{token: string, slugWord: string}|null} the one fuzzy pair, or
 *   null when the tokens do not match under the one-typo rule (an all-exact
 *   match also returns null: the caller's exact path owns that case)
 */
function tokenFuzzyMatch(titleTokens, slugWords, opts = {}) {
  const tokens = (titleTokens || []).map(t => String(t).toLowerCase()).filter(Boolean);
  if (tokens.length < FUZZY_MIN_TITLE_TOKENS) return null;
  const words = [...new Set([...(slugWords || [])].map(w => String(w).toLowerCase()))];
  const wordSet = new Set(words);
  const isExact = opts.isExact
    ? (t) => opts.isExact(t)
    : (t) => wordSet.has(t);
  const missing = tokens.filter(t => !isExact(t));
  if (missing.length !== 1) return null;
  const token = missing[0];
  if (token.length < FUZZY_MIN_TOKEN_LEN || /^\d+$/.test(token) || QUERY_NOISE_WORDS.has(token)) return null;
  const slugWord = words.find(w => w.length >= FUZZY_MIN_TOKEN_LEN - 1 && !/^\d+$/.test(w)
    && !QUERY_NOISE_WORDS.has(w) && !SLUG_BOILERPLATE.has(w) && withinOneEdit(token, w));
  return slugWord ? { token, slugWord } : null;
}

/** Trailing YYYYMMDD of a BWW article URL/slug, as a UTC ms timestamp, or null. */
function slugDateMs(urlOrSlug) {
  const m = String(urlOrSlug || '').split(/[?#]/)[0].replace(/\/+$/, '').match(/-(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(ms) ? null : ms;
}

/** True only when the slug carries a date AND it is within windowDays of openingDate. */
function slugDateNearOpening(urlOrSlug, openingDate, windowDays = FUZZY_DATE_WINDOW_DAYS) {
  const urlMs = slugDateMs(urlOrSlug);
  const m = String(openingDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (urlMs === null || !m) return false;
  const openMs = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.abs(urlMs - openMs) / 86400000 <= windowDays;
}

let _activeShowsCache = null;
/** Non-closed shows from data/shows.json; null when shows.json is unreadable. */
function loadActiveShows() {
  if (_activeShowsCache) return _activeShowsCache;
  try {
    const raw = require(path.join(__dirname, '../../data/shows.json'));
    const shows = Array.isArray(raw) ? raw : (raw.shows || []);
    _activeShowsCache = shows.filter(s => s && !INACTIVE_STATUSES.has(String(s.status || '').toLowerCase()));
  } catch {
    return null;
  }
  return _activeShowsCache;
}

/**
 * Does any OTHER active show match this slug exactly? If so a fuzzy match
 * for `show` must be rejected: the slug belongs to that show.
 * @param {object} show the show being matched ({ id?, title })
 * @param {(other: object) => boolean} exactMatchFn caller's exact matcher
 * @param {object[]} [activeShows] override (tests); defaults to shows.json
 */
function otherActiveShowMatchesExactly(show, exactMatchFn, activeShows) {
  const pool = activeShows || loadActiveShows();
  // No show list to check ownership against: refuse the fuzzy match.
  if (!pool) {
    console.warn('[fuzzy-title-token] data/shows.json unreadable; refusing fuzzy roundup match');
    return true;
  }
  const selfId = show && show.id;
  const selfTitle = String((show && show.title) || '').trim().toLowerCase();
  return pool.some(other => {
    if (!other || !other.title) return false;
    if (selfId && other.id === selfId) return false;
    if (!selfId && String(other.title).trim().toLowerCase() === selfTitle) return false;
    try { return exactMatchFn(other) === true; } catch { return false; }
  });
}

/**
 * One-typo match of a show title against a fetched page's <title>/<h1>, for a
 * roundup URL a human put in data/bww-roundup-urls.json. BWW titled
 * Celebrity Autobiography's roundup "CELEBRITY AUTOPBIOGRAPHY", so the
 * override fetched fine and then the page-title check threw it away.
 * Same one-typo rule as the slug matcher; never used for discovered URLs.
 * @returns {{token: string, slugWord: string}|null}
 */
function pageTitleTypoMatch(showTitle, html) {
  const src = String(html || '');
  const heads = [];
  const t = src.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t) heads.push(t[1]);
  const h = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h) heads.push(h[1].replace(/<[^>]*>/g, ' '));
  const words = (x) => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const titleTokens = words(showTitle).filter(w => !QUERY_NOISE_WORDS.has(w));
  for (const head of heads) {
    const m = tokenFuzzyMatch(titleTokens, words(head));
    if (m) return m;
  }
  return null;
}

module.exports = {
  tokenFuzzyMatch,
  pageTitleTypoMatch,
  slugDateMs,
  slugDateNearOpening,
  loadActiveShows,
  otherActiveShowMatchesExactly,
  FUZZY_DATE_WINDOW_DAYS,
  FUZZY_MIN_TOKEN_LEN,
};
