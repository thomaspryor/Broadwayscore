/**
 * Shared substring-match predicate for HeaderSearch's exact-match fallback
 * and the search-shows.json generator. Normalizes away punctuation/spacing
 * so title variants (e.g. "Gun & Powder" vs "gun &powder") still match —
 * same normalize-then-compare approach as apostrophe/punct title guards
 * elsewhere in the pipeline.
 */

const { foldDiacritics } = require('./title-match');

// Below this, a stripped query/title is too short to be a meaningful signal
// (e.g. a 1-char akaTitle could substring-match nearly anything) — mirrors
// the 2-char floor HeaderSearch's caller already applies to raw queries.
const MIN_MATCH_LENGTH = 2;

// Fold diacritics BEFORE stripping non-ASCII — otherwise "Les Misérables"
// shreds into "les","mis","rables" and matches nothing (task #648).
function normalizeSearchText(s) {
  return foldDiacritics((s || '').toLowerCase()).replace(/[^a-z0-9]/g, '');
}

/** True if `query` matches show.title or any of show.akaTitles. */
function matchesShowSearchQuery(show, query) {
  const q = normalizeSearchText(query);
  if (q.length < MIN_MATCH_LENGTH) return false;
  if (normalizeSearchText(show.title).includes(q)) return true;
  const akaTitles = show.akaTitles;
  if (Array.isArray(akaTitles)) {
    return akaTitles.some(t => normalizeSearchText(t).includes(q));
  }
  return false;
}

// Cast names are indexed so performer searches ("julia louis-dreyfus") find
// their show (BRO-4225). Top-billed only: six names cost ~48KB gzipped across
// the catalogue (eight ~56KB), and a swing's name should not match a show.
const MAX_SEARCH_CAST = 6;
// A cast-name substring needs a longer query than a title match: two or three
// letters ("ann", "ed") would hit hundreds of performers.
const MIN_CAST_MATCH_LENGTH = 4;

/** Comma-joined top-billed cast names for the search index ('' when none). */
function castNamesForSearch(cast) {
  if (!Array.isArray(cast)) return '';
  return cast
    .map(m => (m && typeof m.name === 'string' ? m.name.trim() : ''))
    .filter(Boolean)
    .slice(0, MAX_SEARCH_CAST)
    .join(', ');
}

/** True if `query` is a substring of one indexed cast member's name. */
function matchesShowCastQuery(show, query) {
  const q = normalizeSearchText(query);
  if (q.length < MIN_CAST_MATCH_LENGTH || !show.castNames) return false;
  return show.castNames.split(',').some(name => normalizeSearchText(name).includes(q));
}

/**
 * True if `query` is part of the show's venue or a creative-team name
 * ("majestic", "st james", "jason robert brown"). Exact like the cast match:
 * Fuse also searches these fields, but fuzzily ("fleabg" hits The Flea Theater).
 */
function matchesShowPlaceOrCreatorQuery(show, query) {
  if (normalizeSearchText(query).length < MIN_CAST_MATCH_LENGTH) return false;
  // Whole words, so a title typo is not swallowed by a name that starts or
  // contains it ("carie" in Vaccariello, "bink" in Binkley, "mcnal" in
  // McNally all block the typo fix). A multi-word query may end mid-word
  // while it is being typed ("jason robert br").
  const qWords = searchWords(query);
  const q = ` ${qWords.join(' ')}${qWords.length === 1 ? ' ' : ''}`;
  const matches = (text) => ` ${searchWords(text).join(' ')} `.includes(q);
  if (matches(show.venue)) return true;
  return !!show.creativeTeamNames && show.creativeTeamNames.split(',').some(matches);
}

// Display tiers: playing/upcoming first, then closed shows we scored, then the
// unscored archive (closed productions with a page but no reviews, BRO-3628).
function searchTier(show) {
  if (show.archived) return 2;
  return show.status === 'closed' ? 1 : 0;
}

const TITLE_KEYS = new Set(['title', 'akaTitles']);

// HeaderSearch's fuzzy index (archived shows are kept out of it, see there).
const HEADER_FUSE_OPTIONS = {
  keys: [
    { name: 'title', weight: 0.6 },
    { name: 'akaTitles', weight: 0.5 },
    { name: 'venue', weight: 0.2 },
    { name: 'creativeTeamNames', weight: 0.2 },
  ],
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeMatches: true, // lets mergeSearchResults rank title hits above venue/creative-only hits
};

/** Main search-shows.json entries plus header-search-extra.json's cast names and archive. */
function withHeaderSearchExtra(shows, extra) {
  const cast = (extra && extra.cast) || {};
  const out = shows.map(show => (cast[show.id] ? { ...show, castNames: cast[show.id] } : show));
  return extra && Array.isArray(extra.archive) ? out.concat(extra.archive) : out;
}

// 0: whole title (or aka) equals the query; 1: a title word starts with it;
// 2: plain substring. Lower ranks first, so "art" finds Art, not tARTuffe.
function titleMatchRank(show, query) {
  const q = normalizeSearchText(query);
  const titles = [show.title, ...(Array.isArray(show.akaTitles) ? show.akaTitles : [])];
  if (titles.some(t => normalizeSearchText(t) === q)) return 0;
  const qWords = searchWords(query).join(' ');
  if (qWords && titles.some(t => ` ${searchWords(t).join(' ')}`.includes(` ${qWords}`))) return 1;
  return 2;
}

/**
 * Merge Fuse's ranked hits with exact substring matches Fuse can miss
 * (multi-word partials). Order:
 *  1. title substring matches, by match quality (exact, word start, inside)
 *     then searchTier, so an exact archive title beats a fuzzy live one and
 *     "anna" lists Anna Christie before shows with an Anna in the cast;
 *  2. cast-name substring matches ("christopher jackso" -> Hamilton);
 *  3. venue / creative-team substring matches ("majestic" -> the shows at
 *     the Majestic, ahead of Fuse's fuzzy "Masticate");
 *  4. only when 1-3 are empty: `closeMatches()` (confident typo fixes,
 *     archive included, which Fuse never indexes: "fleabg" -> Fleabag);
 *  5. Fuse fuzzy title hits, then Fuse hits on venue/creative team only.
 * Groups 2-5 are stable-sorted by searchTier.
 * `fuseResults` are Fuse results made with includeMatches ({ item, matches }),
 * or bare items (treated as title matches). `closeMatches` is a lazy callback
 * so the typo pass only costs anything when nothing else matched.
 * @param {object[]} shows
 * @param {string} query
 * @param {object[]} fuseResults
 * @param {number} [limit]
 * @param {(() => object[]) | null} [closeMatches]
 */
function mergeSearchResults(shows, query, fuseResults, limit = 8, closeMatches = null) {
  const fuseTitled = [];
  const fuseOther = [];
  for (const r of fuseResults) {
    if (r && r.item) {
      const titleHit = !r.matches || r.matches.some(m => TITLE_KEYS.has(m.key));
      (titleHit ? fuseTitled : fuseOther).push(r.item);
    } else {
      fuseTitled.push(r);
    }
  }
  const seen = new Set();
  const take = (list) => list.filter(s => s && !seen.has(s.id)).map(s => { seen.add(s.id); return s; });
  const byTier = (a, b) => searchTier(a) - searchTier(b);
  const titleHits = take(shows.filter(s => matchesShowSearchQuery(s, query)))
    .map(s => ({ s, rank: titleMatchRank(s, query) }))
    .sort((a, b) => a.rank - b.rank || byTier(a.s, b.s))
    .map(x => x.s);
  const castHits = take(shows.filter(s => matchesShowCastQuery(s, query))).sort(byTier);
  const placeHits = take(shows.filter(s => matchesShowPlaceOrCreatorQuery(s, query))).sort(byTier);
  const typoHits = !titleHits.length && !castHits.length && !placeHits.length && closeMatches
    ? take(closeMatches()) : [];
  const merged = [
    ...titleHits,
    ...castHits,
    ...placeHits,
    ...typoHits,
    ...take(fuseTitled).sort(byTier),
    ...take(fuseOther).sort(byTier),
  ].slice(0, limit);
  // False when the list is only Fuse's fuzzy guesses: HeaderSearch logs those
  // queries as misses, same as zero results. A venue or creator match answers
  // the query, so it is not a miss.
  merged.confident = titleHits.length + castHits.length + placeHits.length + typoHits.length > 0;
  return merged;
}

// Looser than HeaderSearch's 0.35 so typos ("hamlton", "phantom of the
// oprea") still reach the right title, but titles only: a fuzzy hit on a venue
// or cast name reads as nonsense under "Did you mean". Fuse's combined score is
// not bounded by `threshold`, so SUGGESTION_MAX_SCORE does the real cut.
// Calibrated on the live index: true typo fixes score 0.26-0.49, wrong titles
// from ~0.52 ("the foreigner" -> The Fever, "fleabag" -> CATS 0.74). Word-level
// matching below covers the multi-word typos this cut drops.
const SUGGESTION_FUSE_OPTIONS = {
  keys: [{ name: 'title', weight: 0.7 }, { name: 'akaTitles', weight: 0.3 }],
  threshold: 0.6,
  ignoreLocation: true,
  minMatchCharLength: 3,
  includeScore: true,
};
const SUGGESTION_MAX_SCORE = 0.5;

// Words that carry no title signal in a search box ("mamma mia musical",
// "oklahoma revival"). A query word one typo away from one of these is
// dropped too, so "musicall" does not count against a match.
const QUERY_NOISE_WORDS = new Set(['the', 'and', 'a', 'an', 'of', 'on', 'in', 'at', 'to', 'musical', 'musicals',
  'show', 'play', 'revival', 'broadway', 'tickets', 'ticket', 'review', 'reviews']);

// One insertion, deletion, substitution or adjacent swap ("thigns" -> things).
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [];
    for (let k = 0; k < a.length && diff.length < 3; k++) if (a[k] !== b[k]) diff.push(k);
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function searchWords(s) {
  return foldDiacritics((s || '').toLowerCase()).split(/[^a-z0-9]+/).filter(Boolean);
}

// Typo tolerance per word: one edit once either side has 5+ letters ("poter"
// -> potter, "chld" -> child); shorter words must match exactly, since one
// slip in "mia" or "six" matches too much.
function wordMatches(q, t) {
  if (Math.max(q.length, t.length) < 5) return q === t;
  return withinOneEdit(q, t);
}

/**
 * Word-level typo matches: titles containing most of the query's meaningful
 * words, each allowing one typo ("harry poter cursed chld", "phantm opra").
 * Needs two thirds of the words, so one shared word ("simon" in "simon and
 * garfunkel story") is not enough.
 */
function wordTypoMatches(index, query) {
  const words = searchWords(query).filter(w => w.length >= 3
    && ![...QUERY_NOISE_WORDS].some(n => n === w || (w.length >= 5 && withinOneEdit(w, n))));
  if (!words.length) return [];
  const need = Math.ceil((words.length * 2) / 3);
  // Count, per show, how many query words hit one of its title words; scan
  // the vocabulary (a few thousand words), not every show's title.
  const hitsByShow = new Map();
  for (const w of words) {
    const shown = new Set();
    for (const [t, showIdx] of index.vocab) {
      if (!wordMatches(w, t)) continue;
      for (const i of showIdx) shown.add(i);
    }
    for (const i of shown) hitsByShow.set(i, (hitsByShow.get(i) || 0) + 1);
  }
  const out = [];
  for (const [i, hits] of hitsByShow) {
    if (hits >= need) out.push({ item: index.entries[i].show, hits, len: index.entries[i].titleWords.length });
  }
  // Most query words matched, then the shortest title (closest to what was
  // typed: "oklahomaa" -> Oklahoma! before a long title that mentions it).
  return out.sort((x, y) => y.hits - x.hits || x.len - y.len || searchTier(x.item) - searchTier(y.item)).map(r => r.item);
}

/**
 * Build once per catalogue (HeaderSearch keeps it in a ref): the suggestion
 * Fuse index and each show's title words, so a zero-result keystroke does not
 * re-index ~3,300 shows.
 */
function createSuggestionIndex(FuseClass, shows) {
  const entries = shows.map(show => ({
    show,
    titleWords: [show.title, ...(Array.isArray(show.akaTitles) ? show.akaTitles : [])].flatMap(searchWords),
  }));
  const vocab = new Map();
  entries.forEach(({ titleWords }, i) => {
    for (const t of titleWords) {
      if (!vocab.has(t)) vocab.set(t, []);
      vocab.get(t).push(i);
    }
  });
  return { fuse: new FuseClass(shows, SUGGESTION_FUSE_OPTIONS), entries, vocab };
}

/**
 * "Did you mean" candidates for a zero-result query: close whole-title
 * matches, then word-level typo matches, one per title (the playing/scored
 * production wins over older ones), or [] when nothing is close enough to be
 * worth suggesting. `index` comes from createSuggestionIndex.
 */
function suggestCloseMatches(index, query, limit = 3) {
  const q = (query || '').trim();
  if (normalizeSearchText(q).length < 3 || !index || !index.entries.length) return [];
  const hits = index.fuse.search(q, { limit: 20 }).filter(r => r.score <= SUGGESTION_MAX_SCORE);
  hits.sort((a, b) => a.score - b.score || searchTier(a.item) - searchTier(b.item));
  const byTitle = new Map();
  for (const item of [...hits.map(r => r.item), ...wordTypoMatches(index, q)]) {
    const key = normalizeSearchText(item.title);
    const prev = byTitle.get(key);
    if (!prev || searchTier(item) < searchTier(prev)) byTitle.set(key, item);
  }
  return [...byTitle.values()].slice(0, limit);
}

module.exports = {
  withinOneEdit,
  QUERY_NOISE_WORDS,
  matchesShowSearchQuery,
  matchesShowCastQuery,
  matchesShowPlaceOrCreatorQuery,
  normalizeSearchText,
  castNamesForSearch,
  mergeSearchResults,
  suggestCloseMatches,
  createSuggestionIndex,
  withHeaderSearchExtra,
  HEADER_FUSE_OPTIONS,
  MAX_SEARCH_CAST,
};
