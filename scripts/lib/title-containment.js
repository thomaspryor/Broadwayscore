'use strict';
/**
 * Title-vs-title containment: one show's title appearing as a whole phrase
 * inside a DIFFERENT show's longer title.
 *
 * data/shows.json has hundreds of these pairs: "The Heart" inside "The Heart
 * of Rock and Roll", "Home" inside "Fun Home", "Once" inside "Once Upon a
 * Mattress", "Cats" inside "Cats: The Jellicle Ball", "Sea Wall" inside "Sea
 * Wall/A Life". A word-overlap matcher (titleWordsMatchWithConfidence) says
 * every one of those longer titles "matches" the short one, because every
 * word of the short title is present.
 *
 * BRO-4953 (GitHub #1018): the NYC Theatre and Playbill Verdict scrapers both
 * accepted the 2024 "Heart of Rock and Roll" roundup for "The Heart"
 * (Laura Pels, 2026), and four of its excerpts went live on The Heart's page
 * before the show had even opened. A sweep of the cached aggregator archive
 * found the same class on 20+ other shows.
 *
 * Two layers live here:
 *   - containsTitle / maskLongerTitles: generic, normaliser-pluggable helpers
 *     (also used by newsletter-render-invariants.js, which owned them first).
 *   - findContainingTitleSibling: the page-heading guard the aggregator
 *     validators call ("does this heading name a longer, different show?").
 *
 * Kept free of show-matching.js requires so show-matching can call it
 * without a cycle.
 */

const fs = require('fs');
const path = require('path');

/** Light normaliser: lowercase, curly quotes folded, whitespace collapsed. */
function basicNorm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phrase normaliser for comparing titles against page headings. Diacritics
 * folded ("Misérables"), "&" / "+" / "'n'" read as "and" ("& Juliet",
 * "Rodgers + Hammerstein's", "Rock 'n' Roll"), and every other non-alphanumeric
 * run becomes one space ("Sea Wall/A Life", "Cats: The Jellicle Ball").
 */
function phraseNorm(s) {
  return String(s || '')
    // Raw <title> text keeps its entities ("Broadway&#039;s"); decode the
    // common ones so "&" is not read as "and" inside them.
    .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘]n['’‘]/g, ' and ')
    .replace(/[&+]/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    // "Rock n Roll" with the apostrophes already stripped upstream.
    .replace(/(^| )n(?= |$)/g, '$1and')
    .trim();
}

/**
 * Whole-title containment, NOT a substring test.
 *
 * data/shows.json carries hundreds of single-word titles, many of them
 * ordinary English: "Art", "Home", "Elf", "Bug", "Chess", "Job", "English".
 * A plain `includes()` breaks in BOTH directions: "Art" inside "smart" is a
 * false positive, and a genuinely missing "Art" still "matches" elsewhere.
 *
 * \b is not usable: titles end in punctuation and apostrophes
 * ("Schmigadoon!", "I'm Every Woman"), and \b after "!" behaves the opposite
 * of what you want. Use explicit non-alphanumeric boundary checks on the
 * normalised strings.
 */
function containsTitle(haystack, title, norm = basicNorm) {
  const hay = norm(haystack);
  const needle = norm(title);
  if (!hay || !needle) return false;
  const isWordChar = (ch) => !!ch && /[a-z0-9]/.test(ch);
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? hay[idx - 1] : '';
    const after = idx + needle.length < hay.length ? hay[idx + needle.length] : '';
    // A match is real unless it is glued to a word character on a side where
    // the title itself starts/ends with a word character. "Art" inside "smart"
    // fails (word char before); "Art," or "(Art)" or "Art." all pass.
    const leftOK = !isWordChar(before) || !isWordChar(needle[0]);
    const rightOK = !isWordChar(after) || !isWordChar(needle[needle.length - 1]);
    if (leftOK && rightOK) return true;
    from = idx + 1;
  }
}

/**
 * Blank out occurrences of OTHER, LONGER titles that wholly contain `title`,
 * so a caller can then ask whether the short title survives on its own.
 * Returns the normalised text with those spans replaced by spaces.
 */
function maskLongerTitles(text, title, knownTitles, norm = basicNorm) {
  const target = norm(title);
  let masked = norm(text);
  const longer = (Array.isArray(knownTitles) ? knownTitles : [])
    .map((t) => norm(t))
    .filter((t) => t && t !== target && t.length > target.length && containsTitle(t, target, norm))
    .sort((a, b) => b.length - a.length);
  for (const other of longer) {
    let from = 0;
    for (;;) {
      const idx = masked.indexOf(other, from);
      if (idx === -1) break;
      masked = masked.slice(0, idx) + ' '.repeat(other.length) + masked.slice(idx + other.length);
      from = idx + other.length;
    }
  }
  return masked;
}

// Words that don't make a longer title a different show on their own:
// "Hadestown" vs "Hadestown: The Musical", "Six" vs "Six on Broadway".
// Everything else counts ("concert", "ball", "rock", "fun", "upon").
const NON_DISTINGUISHING_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'musical', 'play', 'new', 'broadway', 'off',
  'on', 'live', 'revival', 'tour', 'show', 'production',
]);

/** Title in phraseNorm form with a leading article dropped ("The Heart" -> "heart"). */
function coreTitle(title) {
  return phraseNorm(title).replace(/^(?:the|a|an) /, '');
}

/**
 * Build { coreTitle -> [longer core titles of OTHER shows that contain it] }.
 * O(n^2) over distinct titles (~2.7k), so callers memoise it (see below).
 */
function buildContainingTitleIndex(shows) {
  const cores = new Set();
  for (const s of Array.isArray(shows) ? shows : []) {
    const c = s && typeof s.title === 'string' ? coreTitle(s.title) : '';
    if (c.length >= 2) cores.add(c);
  }
  const list = [...cores];
  const index = new Map();
  for (const short of list) {
    const padded = ` ${short} `;
    for (const long of list) {
      if (long === short || long.length <= short.length) continue;
      const pl = ` ${long} `;
      const at = pl.indexOf(padded);
      if (at === -1) continue;
      const extra = (pl.slice(0, at) + ' ' + pl.slice(at + padded.length))
        .split(' ').filter((w) => w && !NON_DISTINGUISHING_WORDS.has(w));
      if (extra.length === 0) continue;
      if (!index.has(short)) index.set(short, []);
      index.get(short).push(long);
    }
  }
  return index;
}

/**
 * Title with non-distinguishing words dropped, for "same show?" comparisons:
 * "Little Women the Musical" and "Little Women" both -> "little women".
 */
function distinctTitleKey(title) {
  return coreTitle(title).split(' ').filter((w) => w && !NON_DISTINGUISHING_WORDS.has(w)).join(' ');
}

// One index per shows array: callers alternate between their own subset and
// the full catalogue (lbo-roundup-discover, opening-night-poller), and a
// rebuild costs ~0.5s.
const _indexCache = new WeakMap();
let _defaultShows = null;

function defaultShows() {
  if (_defaultShows) return _defaultShows;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/shows.json'), 'utf8'));
    _defaultShows = Array.isArray(raw) ? raw : (raw.shows || []);
  } catch {
    // No shows.json (fresh checkout, unit test sandbox): the guard has nothing
    // to compare against and stays inert rather than throwing.
    _defaultShows = [];
  }
  return _defaultShows;
}

function indexFor(shows) {
  const list = shows || defaultShows();
  let index = _indexCache.get(list);
  if (!index) { index = buildContainingTitleIndex(list); _indexCache.set(list, index); }
  return index;
}

/**
 * Does `text` (a page's title/headings) name a DIFFERENT, longer show title
 * that contains `targetTitle`, with no standalone mention of the target?
 *
 *   findContainingTitleSibling("... Broadway's The Heart of Rock and Roll | Playbill", "The Heart")
 *     -> { sibling: "heart of rock and roll" }
 *   findContainingTitleSibling("THE HEART Off-Broadway Reviews", "The Heart") -> null
 *
 * @param {string} text
 * @param {string} targetTitle
 * @param {object} [options]
 * @param {object[]} [options.shows] shows.json entries; defaults to data/shows.json
 * @returns {{ sibling: string } | null}
 */
function findContainingTitleSibling(text, targetTitle, options = {}) {
  // Kill switch: if the guard ever over-rejects, set this in the workflow env
  // and both validators fall back to their pre-BRO-4953 behaviour.
  if (process.env.CONTAINING_TITLE_GUARD_OFF === '1') return null;
  const target = coreTitle(targetTitle);
  if (target.length < 2) return null;
  const longer = indexFor(options.shows).get(target);
  if (!longer || longer.length === 0) return null;
  const hay = phraseNorm(text);
  if (!hay) return null;
  const hits = longer.filter((t) => containsTitle(hay, t, phraseNorm));
  if (hits.length === 0) return null;
  const masked = maskLongerTitles(hay, target, hits, phraseNorm);
  if (containsTitle(masked, target, phraseNorm)) return null;
  hits.sort((a, b) => b.length - a.length);
  return { sibling: hits[0] };
}

module.exports = {
  basicNorm,
  phraseNorm,
  coreTitle,
  distinctTitleKey,
  containsTitle,
  maskLongerTitles,
  buildContainingTitleIndex,
  findContainingTitleSibling,
  NON_DISTINGUISHING_WORDS,
};
