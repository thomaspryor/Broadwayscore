/**
 * submission-show-match.js — which shows.json entries does a submitted show
 * name refer to?
 *
 * Shared by validate-review-submission.js and test-review-submission.js,
 * which each carried their own copy of a raw-substring matcher. That matcher
 * returned "Ma" (ma-1971) for "Thelma and Louise" because "thelma" contains
 * "ma", and missed "Thelma & Louise: A New Musical" because "&" != "and".
 * The validator then sent issue #919 to manual review (BRO-4141).
 *
 * Titles are compared after normalizeTitle() (the project-wide title
 * normalizer: & → and, punctuation, diacritics) and partial matches must land
 * on whole words.
 */

const { normalizeTitle } = require('./title-match');

// A one-word partial match needs at least this many characters, so short
// titles ("Ma", "Us", "Hair") don't match every name that contains them as a
// word by accident. Multi-word partials are specific enough on their own.
const MIN_SINGLE_WORD_PARTIAL = 5;

function wordContains(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

function specificEnough(normalized) {
  return normalized.includes(' ') || normalized.length >= MIN_SINGLE_WORD_PARTIAL;
}

/**
 * @param {string} showName  the submitter's show name
 * @param {Array<{id:string, slug?:string, title:string}>} shows
 * @returns {Array} every candidate (a title can span several productions)
 */
function findMatchingShows(showName, shows) {
  if (!showName) return [];
  const input = normalizeTitle(showName);
  // Title before slug: "ragtime" is ragtime-2025's slug, but a submitted
  // "Ragtime" must still return all three productions for disambiguation.
  const exact = input ? shows.filter((s) => normalizeTitle(s.title) === input) : [];
  if (exact.length) return exact;

  const raw = showName.toLowerCase().trim();
  const bySlug = shows.filter((s) => s.id === raw || s.slug === raw);
  if (bySlug.length) return bySlug;
  if (!input) return [];

  return shows.filter((s) => {
    const title = normalizeTitle(s.title);
    if (!title) return false;
    if (specificEnough(input) && wordContains(title, input)) return true;
    if (specificEnough(title) && wordContains(input, title)) return true;
    // Shorthand: "Les Mis" -> "Les Miserables" (input is the start of the title).
    if (input.length >= 3 && title.startsWith(input)) return true;
    // Short title as the first word: "Six on Broadway", "Cats West End".
    return input.startsWith(`${title} `);
  });
}

// A review is plausible for a production from shortly before it opens (previews)
// to a while after it closes (late reviews, retrospectives).
const PREVIEW_LEAD_DAYS = 60;
const POST_CLOSE_GRACE_DAYS = 120;
const DAY_MS = 86400e3;

function dayMs(iso) {
  const t = Date.parse(`${String(iso || '').slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/** Does this review date fall in the production's run window? null when the show or date is undated. */
function reviewDateFitsShow(show, reviewDate) {
  const r = dayMs(reviewDate);
  const open = dayMs(show && show.openingDate);
  if (r == null || open == null) return null;
  if (r < open - PREVIEW_LEAD_DAYS * DAY_MS) return false;
  const close = dayMs(show.closingDate);
  return close == null || r <= close + POST_CLOSE_GRACE_DAYS * DAY_MS;
}

/**
 * Issue #1178: "Waiting for Lefty" exact-matched only the closed 2024 regional
 * production (the 2026 off-Broadway entry is titled "Clifford Odets' Waiting
 * for Lefty"), so a Nov 2026 review was filed under the wrong show. When the
 * resolved show's run window excludes the review date, look for the same title
 * (whole-word, either direction) among the other shows and return the one whose
 * window fits. Returns the original show when it fits, when its dates are
 * unknown, or when zero or several alternatives fit (never guess between them).
 * @param {{show: object, showName: string, shows: object[], reviewDate: string|null}} opts
 */
function preferProductionByDate({ show, showName, shows, reviewDate }) {
  if (!show || !reviewDate || reviewDateFitsShow(show, reviewDate) !== false) return show;
  const input = normalizeTitle(showName || show.title);
  if (!input || !specificEnough(input)) return show;
  const alternatives = shows.filter((s) => {
    if (s.id === show.id) return false;
    const title = normalizeTitle(s.title);
    if (!title) return false;
    const same = wordContains(title, input) || (specificEnough(title) && wordContains(input, title));
    return same && reviewDateFitsShow(s, reviewDate) === true;
  });
  return alternatives.length === 1 ? alternatives[0] : show;
}

const HTML_ENTITIES = { amp: '&', '#38': '&', '#038': '&', '#x26': '&', nbsp: ' ', '#8217': "'", '#39': "'", rsquo: "'", quot: '"' };

/**
 * Does a fetched page's HTML mention this show? Used by the score-only
 * (paywalled, no body) ingest path as its only wrong-show guard (BRO-4141).
 * The raw-substring check it replaces refused "Thelma & Louise: A New
 * Musical" on The Stage's own review: "&amp;" normalized to "amp", "&" was
 * dropped from the title, and the ": A New Musical" subtitle never appears
 * on the page. Uses normalizeTitle (& -> and, punctuation, diacritics) on
 * both sides; accepts the full title or the main title (before ":" / "("),
 * the latter only when specific enough that a short title ("Ma") can't
 * match by accident. Whole-word matching.
 * @param {string} html
 * @param {string} title  shows.json title
 * @returns {boolean}
 */
function pageMentionsShowTitle(html, title) {
  if (!html || !title) return false;
  let decoded = String(html).replace(/<[^>]+>/g, ' ');
  // Pages double-encode ("&amp;amp;" on The Stage) — decode until stable.
  for (let i = 0; i < 3; i++) {
    const next = decoded.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => HTML_ENTITIES[e.toLowerCase()] ?? ' ');
    if (next === decoded) break;
    decoded = next;
  }
  const page = strictNorm(decoded);
  const full = strictNorm(title);
  if (full && wordContains(page, full)) return true;
  const main = strictNorm(title.split(/[:(]/)[0]);
  return Boolean(main) && main !== full && specificEnough(main) && wordContains(page, main);
}

// Deliberately NOT normalizeTitle(): that drops a leading "The" and
// parenthesized text, so "The Audience" became "audience" and matched any
// page saying "its audience" (Codex review). Keep every word; only fold
// case, diacritics, & -> and, apostrophes, and punctuation.
function strictNorm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

module.exports = { findMatchingShows, pageMentionsShowTitle, preferProductionByDate, reviewDateFitsShow };
