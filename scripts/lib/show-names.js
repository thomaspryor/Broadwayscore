'use strict';
/**
 * BRO-7778: press titles (shows.json akaTitles). Critics drop subtitles: "It's A Wonderful Life: A Live Radio Play"
 * is reviewed as "Review: It's a Wonderful Life". This file holds the rules for those names. Pure, no I/O (rule 15).
 */
const path = require('path');

const STOP = ['the', 'a', 'an', 'of', 'and', 'in', 'at', 'on', 'to', 'for'];
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Normalised comparison key ("It’s A Wonderful Life" -> "its a wonderful life"). */
function normTitle(t) {
  return fold(t).toLowerCase().replace(/[‘’ʼ']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Significant words (articles and 1-letter words dropped). */
function sigWords(t) {
  return normTitle(t).split(' ').filter((w) => w.length > 1 && !STOP.includes(w));
}

/**
 * The main title before a subtitle, and the subtitle form: a quoted subtitle ('Blue Man Group “A New Holiday
 * Surprise”'), a colon ("It’s A Wonderful Life: A Live Radio Play") or a spaced dash ("Adriana Mater - English
 * National Opera"). Null for an author credit ("Charles Dickens’ “A Christmas Carol”") or a main of fewer than 2
 * significant words ("August: Osage County", "Dolly: A True Original Musical"): one word is no identity, so such a
 * show needs an explicit akaTitles entry (or is caught by the near-miss alert).
 * @returns {{main: string, form: 'quoted'|'colon'|'dash'}|null}
 */
function mainTitleSplit(showTitle) {
  const t = String(showTitle || '').trim();
  let m = t.match(/^(.+?)\s+[\u201C]([^\u201C\u201D]+)[\u201D]\s*$/);
  let form = 'quoted';
  if (!m) { m = t.match(/^(.+?):\s+(.+)$/); form = 'colon'; }
  if (!m) { m = t.match(/^(.+?)\s+[-\u2013\u2014]\s+(.+)$/); form = 'dash'; }
  if (!m) return null;
  const main = m[1].trim();
  if (/['\u2018\u2019]s?$/.test(main)) return null;
  if (sigWords(main).length < 2) return null;
  return { main, form };
}

/**
 * True when no show with a DIFFERENT full title equals the main title or starts with it at a word boundary ("Blue
 * Man" must not block "Blue Mantis"). Fails closed when the show list is missing. Callers pass ALL show titles.
 */
const _uniqueMemo = new WeakMap();
function mainTitleIsUnique(showTitle, main, allShowTitles) {
  if (!main || !Array.isArray(allShowTitles) || allShowTitles.length === 0) return false;
  let memo = _uniqueMemo.get(allShowTitles);
  if (!memo) { memo = new Map(); _uniqueMemo.set(allShowTitles, memo); }
  const key = showTitle + '\u0000' + main;
  if (!memo.has(key)) {
    const own = normTitle(showTitle);
    const mm = normTitle(main);
    memo.set(key, !!mm && !allShowTitles.some((t) => { const n = normTitle(t); return n && n !== own && (n === mm || n.startsWith(mm + ' ')); }));
  }
  return memo.get(key);
}

/** A usable press title: has a 2+ letter word ("860" alone would match any /860/ path) and is not the own title. */
function usableAka(t, ownTitle) {
  if (typeof t !== 'string' || !t.trim() || !/[a-z]{2,}/i.test(fold(t))) return false;
  return normTitle(t) !== normTitle(ownTitle);
}

/**
 * Every press title of a show: billed (show.title), aka (akaTitles, always trusted), main (the title before a
 * subtitle, only when unique among allShows). The one definition every matcher follows; see rss-discovery
 * titleMatchesShow for how each kind is matched.
 * @param {{title: string, akaTitles?: string[]}} show
 * @param {Array<object|string>} [allShows] every show or title, closed ones too (needed for `main`)
 * @returns {{name: string, kind: 'billed'|'aka'|'main', form?: string}[]}
 */
function showNames(show, allShows) {
  if (!show || !show.title) return [];
  const out = [{ name: show.title, kind: 'billed' }];
  const seen = new Set([normTitle(show.title)]);
  for (const a of Array.isArray(show.akaTitles) ? show.akaTitles : []) {
    if (!usableAka(a, show.title) || seen.has(normTitle(a))) continue;
    seen.add(normTitle(a));
    out.push({ name: a.trim(), kind: 'aka' });
  }
  const split = mainTitleSplit(show.title);
  const titles = Array.isArray(allShows) ? allShows.map((x) => (typeof x === 'string' ? x : x && x.title)).filter(Boolean) : null;
  // Only a quoted subtitle (BRO-7739) admits the main title alone. A colon/dash main ("Stranger Things", "Bill Bailey",
  // "It's a Wonderful Life") is also a film, a TV show, a performer or another production, so it is admitted only
  // through an explicit akaTitles entry; on its own it raises the near-miss alert (ship-check, BRO-7778).
  if (split && split.form === 'quoted' && !seen.has(normTitle(split.main)) && mainTitleIsUnique(show.title, split.main, titles)) {
    out.push({ name: split.main, kind: 'main', form: split.form });
  }
  return out;
}

// --- registry: the loaded show list, for matchers that only receive show.title ---------------------------------
let _registry = null; // { akaByTitle: Map, venueByTitle: Map, peopleByTitle: Map, titles: string[] }
function buildRegistry(shows) {
  const akaByTitle = new Map();
  const venueByTitle = new Map();
  const peopleByTitle = new Map(); // name words of the cast and creative team ("rinna", "rannells")
  const titles = [];
  for (const s of shows || []) {
    if (!s || !s.title) continue;
    titles.push(s.title);
    const k = normTitle(s.title);
    if (typeof s.venue === 'string' && s.venue.trim()) venueByTitle.set(k, [...(venueByTitle.get(k) || []), s.venue]);
    for (const p of [...(Array.isArray(s.cast) ? s.cast : []), ...(Array.isArray(s.creativeTeam) ? s.creativeTeam : [])]) {
      const name = typeof p === 'string' ? p : p && p.name;
      if (typeof name !== 'string') continue;
      if (!peopleByTitle.has(k)) peopleByTitle.set(k, new Set());
      for (const w of normTitle(name).split(' ')) if (w.length > 1) peopleByTitle.get(k).add(w);
    }
    for (const a of Array.isArray(s.akaTitles) ? s.akaTitles : []) {
      if (!usableAka(a, s.title)) continue;
      if (!akaByTitle.has(k)) akaByTitle.set(k, []);
      if (!akaByTitle.get(k).some((x) => normTitle(x) === normTitle(a))) akaByTitle.get(k).push(a.trim());
    }
  }
  return { akaByTitle, venueByTitle, peopleByTitle, titles };
}
function registry() {
  if (!_registry) {
    try {
      const raw = require(path.join(__dirname, '..', '..', 'data', 'shows.json'));
      _registry = buildRegistry(Array.isArray(raw) ? raw : raw.shows || []);
    } catch (_) { _registry = buildRegistry([]); }
  }
  return _registry;
}
/** Tests (or a caller holding its own list) set the registry; null resets it to data/shows.json, read lazily. */
function setPressNameShows(shows) { _registry = shows ? buildRegistry(shows) : null; }
/** akaTitles for a billed title (union over shows billed the same). Read once per process. */
function pressAkaForTitle(title) { return registry().akaByTitle.get(normTitle(title)) || []; }
/** Venues of the shows billed with this title (for otherProductionCue). */
function pressVenuesForTitle(title) { return registry().venueByTitle.get(normTitle(title)) || []; }

// A headline naming Broadway or the show's venue skips these (a stage adaptation is reviewed as "the beloved film").
const FILM_CUE_RE = /\b(movie|movies|film|films|cinema|netflix|blu[- ]?ray|dvd|1946|capra|album|episode|tv series)\b/i;
// Capitalized company words in a headline's tail ("Oil Lamp Theater's live radio play", "| English National Opera").
const NAMED_COMPANY_RE = /\b[A-Z][A-Za-z'.]*(?:\s+[A-Z][A-Za-z'.]*){0,3}\s+(?:Theatre|Theater|Repertory|Rep|Players|Playhouse|Opera|Company)\b/;
const NOT_COMPANY_POSSESSIVE = new Set(['broadway', 'review', 'critic', 'critics', 'tonight', 'year', 'season', 'today', 'week', 'nyc', 'london', 'it', 'that', 'what', 'here', 'there', 'who']);
const COMPANY_WORD_RE = /\b(theatre|theater|theatres|theaters|rep|repertory|players|playhouse|company|stage|stages|productions?|opera|college|university|school|center|centre|hall|arts)\b/i;
const VENUE_GENERIC = new Set(['theatre', 'theater', 'the']);
/**
 * BRO-7778: a headline that names a show only by a press title (akaTitles) can be about another production of the same
 * work: a regional staging ("Review: Rosebud's It's A Wonderful Life", "'It's A Wonderful Life' is a Wonderful Time at
 * Hope Repertory"), another version ("It's A Wonderful Life: The Musical") or the film ("It's a Wonderful Life (1946)
 * Review"). Returns the cue found, or null. Only for press-title matches: the billed title is the show's own name.
 * A headline naming Broadway or the show's own venue is the show's own, whatever else it says (ship-check).
 * @param {string} text headline (or slug text)
 * @param {string} aka the press title that matched
 * @param {{title: string, venue?: string}} show the show (venue read from the loaded show list when absent)
 * @returns {string|null}
 */
function otherProductionCue(text, aka, show) {
  const raw = fold(String(text || '')).replace(/[‘’ʼ`]/g, "'");
  const own = (show && show.title) || '';
  const venues = [...(show && show.venue ? [show.venue] : []), ...pressVenuesForTitle(own)];
  const venueW = new Set(venues.flatMap((v) => sigWords(v)).filter((w) => !VENUE_GENERIC.has(w)));
  const textW = new Set(normTitle(raw).split(' '));
  if (textW.has('broadway') || textW.has('broadways') || [...venueW].some((w) => textW.has(w))) return null;
  if (FILM_CUE_RE.test(raw)) return 'film';
  const akaW = normTitle(aka).split(' ').filter(Boolean);
  if (!akaW.length) return null;
  const re = new RegExp(`(^|[^a-z0-9])${akaW.map((w) => w.split('').join("'?")).join("[^a-z0-9]+")}(?![a-z0-9])`, 'i');
  const m = re.exec(raw);
  if (!m) return null;
  const before = raw.slice(0, m.index + m[1].length);
  const after = raw.slice(m.index + m[0].length);
  // A company's possessive before the press title ("Rosebud's It's A Wonderful Life", "Studio Tenn's ... IT'S A
  // WONDERFUL LIFE"). The press title's own "It's" is not before the match.
  // A word of the billed title is the show's own ("Billy Crystal's Solo Show 860" for Billy Crystal 860).
  // A cast or creative member's possessive is the show's own ("Lisa Rinna's debut in It's a Wonderful Life").
  const billedW = new Set(sigWords(own));
  const people = registry().peopleByTitle.get(normTitle(own)) || new Set();
  for (const pos of before.matchAll(/\b([A-Za-z0-9]+)(?:'s|s')(?![a-z])/g)) {
    const w = pos[1].toLowerCase();
    if (NOT_COMPANY_POSSESSIVE.has(w) || billedW.has(normTitle(w)) || people.has(w) || people.has(`${w}s`)) continue;
    return `possessive:${pos[1]}`;
  }
  // A company or venue named right after it: ", Reading Rep Theatre", "by American Blues Theater".
  const tail = /^\s*["']?\s*(?:,|\bby\b)\s*([^,|:–—]{0,60})/i.exec(after);
  if (tail && /^[A-Z]/.test(tail[1]) && COMPANY_WORD_RE.test(tail[1])) return `company:${tail[1].trim().slice(0, 40)}`;
  // Another version's subtitle after a colon ("It's A Wonderful Life: The Musical", "...: Live in Chicago!"). Dash
  // decks and parentheticals are a critic's own words ("- Feldman shines", "(radio play)").
  const sub = /^\s*["']?\s*:\s*([^:|]*)/.exec(after);
  if (sub) {
    const words = sigWords(sub[1]).filter((w) => !/^review(s|ed)?$/.test(w)).slice(0, 3);
    const ownW = new Set(sigWords(own));
    if (words.length && words.some((w) => !ownW.has(w))) return `subtitle:${sub[1].trim().slice(0, 40)}`;
  }
  const named = NAMED_COMPANY_RE.exec(after);
  if (named) return `company:${named[0].trim().slice(0, 40)}`;
  // "at <Somewhere> Theatre/Rep/Playhouse/Center" naming a venue (Title Case prose "At Every Turn" is not one).
  for (const a of after.matchAll(/\b(?:at|At|AT)\s+(?:(?:the|The|THE)\s+)?([A-Z][A-Za-z0-9'.]*(?:\s+[A-Z][A-Za-z0-9'.]*){0,4})/g)) {
    if (COMPANY_WORD_RE.test(a[1])) return `venue:${a[1].trim().slice(0, 40)}`;
  }
  return null;
}

/** Every billed title in the registry (closed shows too), for main-title uniqueness. Empty when unavailable. */
function registryShowTitles() { return registry().titles; }

/**
 * Plan value check for shows.json akaTitles (data-edit-action.js): null clears it; otherwise a non-empty array of
 * distinct press titles. An entry the plan ADDS must not be another show's billed title or aka (that would file one
 * show's reviews under the other) unless that show is the same work (same workKey). Entries already stored are not
 * re-judged (as images are not): some existing akas predate this check. A case/punctuation variant of the show's own
 * title is allowed (Playbill matching uses those).
 * @param {string[]|null} [prevValue] the stored value
 * @returns {string|null}
 */
function akaTitlesValueProblem(value, show, shows, prevValue = null) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return 'akaTitles: must be null or a non-empty array of strings';
  const seen = new Set();
  for (const a of value) {
    if (typeof a !== 'string' || a.trim().length < 2 || a.length > 150) return `akaTitles: bad entry ${JSON.stringify(a)}`;
    const k = normTitle(a);
    if (!k) return `akaTitles: bad entry ${JSON.stringify(a)}`;
    if (seen.has(k)) return `akaTitles: duplicate ${JSON.stringify(a)}`;
    seen.add(k);
    if (Array.isArray(prevValue) && prevValue.some((p) => normTitle(p) === k)) continue;
    const work = show && show.workKey;
    const other = (shows || []).find((s) => s && s.id !== (show && show.id) && !(work && s.workKey === work) && (normTitle(s.title) === k
      || (Array.isArray(s.akaTitles) && s.akaTitles.some((x) => normTitle(x) === k))));
    if (other) return `akaTitles: ${JSON.stringify(a)} is already a title of another show (${other.id})`;
  }
  return null;
}

module.exports = {
  akaTitlesValueProblem, normTitle, sigWords, mainTitleSplit, mainTitleIsUnique, showNames,
  pressAkaForTitle, pressVenuesForTitle, registryShowTitles, setPressNameShows, otherProductionCue,
};
