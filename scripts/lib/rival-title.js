'use strict';

/**
 * Rival-title guard (BRO-8321).
 *
 * "A Christmas Carol" (Old Vic) is a title INSIDE "A Christmas Carol Goes Wrong"
 * (a Mischief comedy on tour). The outlet-listing poller matched The Reviews Hub's
 * "a-christmas-carol-goes-wrong-grand-theatre-wolverhampton" to the Old Vic show,
 * the review scored 80 and went into the Old Vic's composite (2026-11-25).
 *
 * Three gaps let it through, all closed with this module:
 *   1. dropTitlesInsideLongerMatch only compared SHORTER vs LONGER among the shows
 *      that matched, and the poller only matches OPEN/PREVIEWS shows. The longer
 *      title ("Christmas Carol Goes Wrong") was upcoming/closed, so it was never in
 *      the pool to out-match the shorter one.
 *   2. Even when in the pool, the longer title is stored without the leading article
 *      ("Christmas Carol Goes Wrong") while the shorter one keeps it
 *      ("A Christmas Carol"), so " a christmas carol " is not a substring of
 *      " christmas carol goes wrong ". Titles compare article-insensitively here.
 *   3. Nothing re-checked a filed review. otherProductionSignal now reads the same
 *      index ('rival-title'), so the rebuild flags it and the audit reports it.
 *
 * Pure: no fs, no network. Callers pass every show in shows.json, whatever its
 * status (a closed or upcoming rival still proves the headline is about it).
 */

const ARTICLES = new Set(['a', 'an', 'the']);

// Words that turn a title into a NAME VARIANT of the same work, not a different show
// ("Oliver!" / "Oliver! The Musical"; "Hadestown" / "Hadestown on Broadway"). A rival
// whose extra words are all in this set is an alias, never a rival.
const GENERIC_SUFFIX_WORDS = new Set([
  'the', 'a', 'an', 'musical', 'play', 'new', 'live', 'concert', 'show', 'revival', 'tour',
  'uk', 'us', 'broadway', 'west', 'end', 'off', 'in', 'on', 'at', 'of', 'and', 'ballet', 'opera',
  'production', 'version', 'edition', 'cast', 'recording', 'film', 'movie', 'review', 'reviews',
]);

function foldDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Lowercase alphanumeric tokens; "&" reads as "and"; slug dashes read as spaces. */
function tokens(text) {
  return foldDiacritics(text).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Title tokens with ONE leading article dropped ("A Christmas Carol" -> christmas carol). */
function titleTokens(title) {
  const t = tokens(String(title || '').replace(/\s*\([^)]*\)/g, ' '));
  return t.length > 1 && ARTICLES.has(t[0]) ? t.slice(1) : t;
}

function indexOfSeq(hay, needle, from = 0, used = null) {
  if (!needle.length) return -1;
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j] || (used && used[i + j])) continue outer;
    }
    return i;
  }
  return -1;
}

function containsSeq(hay, needle) { return indexOfSeq(hay, needle) !== -1; }

/** Raw title, lowercased, one leading article dropped, whitespace collapsed (punctuation kept). */
function rawTitleKey(title) {
  const t = foldDiacritics(String(title || '')).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  return t.replace(/^(?:a|an|the)\s+(?=\S)/, '');
}

/**
 * True when `rival` is the shorter title with MORE WORDS APPENDED and nothing between them:
 * "Christmas Carol Goes Wrong" after "A Christmas Carol", "Peter Pan Goes Wrong" after "Peter Pan".
 *
 * That is deliberately narrow. The other ways a longer title contains a shorter one are NAME
 * VARIANTS of the same production, not other shows, and must never swallow a review:
 *   - a possessive credit before it: "Disney's Beauty and the Beast", "August Wilson's Fences",
 *     "Stephen Sondheim's Old Friends" (measured 2026-11-25: 100+ real reviews of the right show)
 *   - a punctuated subtitle after it: "I'm Every Woman, The Chaka Khan Musical", "Hamlet: ..."
 *   - generic trailing words: "Oliver! The Musical"
 */
function extendsAsSuffix(rivalTitle, showTitle) {
  const r = rawTitleKey(rivalTitle);
  const t = rawTitleKey(showTitle);
  if (!t || r.length <= t.length || !r.startsWith(t + ' ')) return false;
  // One-word titles ("Once", "Chicago") are ordinary words: "Once in a Lifetime" is a phrase, not a rival.
  if (tokens(t).length < 2) return false;
  // A title that ends in "!" or "?" is complete; what follows is its subtitle ("On Your Feet! The Story of ...").
  if (/[!?.]$/.test(t)) return false;
  const tail = r.slice(t.length + 1);
  if (!/^[a-z0-9]/.test(tail) || /[(),:;\u2013\u2014]|\s-\s/.test(tail)) return false;
  return tokens(tail).some((w) => !GENERIC_SUFFIX_WORDS.has(w));
}

/**
 * Index every show by the token prefixes of its title, so the rivals of a title are one lookup.
 * @param {Array<{id:string,title:string,workKey?:string}>} allShows every show, any status
 * @returns {{ rivalsFor: (show:object) => Array<{id:string,title:string,toks:string[]}> }}
 */
function buildRivalIndex(allShows) {
  const byPrefix = new Map(); // "christmas carol" -> Map(rivalKey -> rival)
  for (const s of allShows || []) {
    if (!s || !s.title) continue;
    const toks = titleTokens(s.title);
    if (toks.length < 2) continue;
    const key = toks.join(' ');
    for (let j = 1; j < toks.length; j++) {
      const prefix = toks.slice(0, j).join(' ');
      let m = byPrefix.get(prefix);
      if (!m) { m = new Map(); byPrefix.set(prefix, m); }
      if (!m.has(key)) m.set(key, { id: s.id, title: s.title, toks, workKey: s.workKey || null });
    }
  }
  const cache = new Map();
  return {
    rivalsFor(show) {
      if (!show || !show.title) return [];
      const key = titleTokens(show.title).join(' ');
      const ck = `${show.id}|${key}`;
      if (cache.has(ck)) return cache.get(ck);
      const found = [...(byPrefix.get(key) || new Map()).values()]
        .filter((r) => r.id !== show.id && !(show.workKey && r.workKey && r.workKey === show.workKey) && extendsAsSuffix(r.title, show.title));
      cache.set(ck, found);
      return found;
    },
  };
}

/**
 * Is the show's title present in `text` ONLY as part of a longer rival title?
 * Every mention of the title is covered by a rival's title (longest first), so
 * "A Christmas Carol Goes Wrong, Grand Theatre Wolverhampton" is the rival's and
 * "A Christmas Carol Goes Wrong ... unlike the Old Vic's A Christmas Carol" is not.
 * @returns {{id:string,title:string}|null} the rival that swallowed the title
 */
function rivalSwallowsTitle(text, show, index) {
  if (!text || !show || !index) return null;
  const rivals = index.rivalsFor(show);
  if (!rivals.length) return null;
  const hay = tokens(text);
  const own = titleTokens(show.title);
  if (!containsSeq(hay, own)) return null;
  const used = new Array(hay.length).fill(false);
  let swallowedBy = null;
  for (const r of [...rivals].sort((a, b) => b.toks.length - a.toks.length)) {
    let at = indexOfSeq(hay, r.toks, 0, used);
    while (at !== -1) {
      for (let k = 0; k < r.toks.length; k++) used[at + k] = true;
      swallowedBy = swallowedBy || r;
      at = indexOfSeq(hay, r.toks, at + r.toks.length, used);
    }
  }
  if (!swallowedBy) return null;
  const rest = hay.map((t, i) => (used[i] ? '|' : t));
  return containsSeq(rest, own) ? null : { id: swallowedBy.id, title: swallowedBy.title };
}

let _defaultIndex;
/** Index over data/shows.json (every status), built once per process. Null when the file is absent. */
function defaultRivalIndex() {
  if (_defaultIndex !== undefined) return _defaultIndex;
  try {
    const S = require(require('path').join(__dirname, '..', '..', 'data', 'shows.json'));
    _defaultIndex = buildRivalIndex(S.shows || S);
  } catch { _defaultIndex = null; }
  return _defaultIndex;
}

module.exports = { defaultRivalIndex, buildRivalIndex, rivalSwallowsTitle, titleTokens, tokens, extendsAsSuffix, GENERIC_SUFFIX_WORDS };
