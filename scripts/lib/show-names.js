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
let _registry = null; // { akaByTitle, venueByTitle, peopleByTitle, marketsByTitle: Map, titles: string[] }
function buildRegistry(shows) {
  const akaByTitle = new Map();
  const venueByTitle = new Map();
  const peopleByTitle = new Map(); // name words of the cast and creative team ("rinna", "rannells")
  const marketsByTitle = new Map(); // categories of the shows billed with a title (BRO-7785)
  const titles = [];
  for (const s of shows || []) {
    if (!s || !s.title) continue;
    titles.push(s.title);
    const k = normTitle(s.title);
    if (s.category) marketsByTitle.set(k, new Set([...(marketsByTitle.get(k) || []), String(s.category)]));
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
  return { akaByTitle, venueByTitle, peopleByTitle, marketsByTitle, titles };
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
// Not "Magazine Theater Review": a company word followed by "review" is the article type (BRO-7785).
const NAMED_COMPANY_RE = /\b[A-Z][A-Za-z'.]*(?:\s+[A-Z][A-Za-z'.]*){0,3}\s+(?:Theatre|Theater|Repertory|Rep|Players|Playhouse|Opera|Company)\b(?!\s+[Rr]eview)/;
const NOT_COMPANY_POSSESSIVE = new Set(['broadway', 'review', 'critic', 'critics', 'tonight', 'year', 'season', 'today', 'week', 'nyc', 'london', 'it', 'that', 'what', 'here', 'there', 'who']);
// BRO-7785 added guild/ensemble/festival/society/theatreworks ("Washington Stage Guild", "TheatreWorks Silicon Valley").
const COMPANY_WORD_RE = /\b(theatre|theater|theatres|theaters|theatreworks|theaterworks|rep|repertory|players|playhouse|company|stage|stages|productions?|opera|college|university|school|center|centre|hall|arts|guild|ensemble|festival|society)\b/i;
const VENUE_GENERIC = new Set(['theatre', 'theater', 'the']);
// Names critics use for a show's venue that shows.json does not store (BRO-7785: "Cloud 9 at the National Theatre" is the
// Lyttelton production; Rent "at the Tom Stoppard Theatre" is the Duke of York's). Plus content-quality's groups.
const VENUE_ALIAS_EXTRA = [
  ['National Theatre', 'Lyttelton Theatre', 'Olivier Theatre', 'Dorfman Theatre'],
  ["Duke of York's Theatre", 'Tom Stoppard Theatre'],
  ['Harold Pinter Theatre', 'Comedy Theatre'],
  ['Soho Place', 'sohoplace'],
];
function venueAliases(venue) {
  const k = normTitle(venue);
  const extra = VENUE_ALIAS_EXTRA.find((g) => g.some((v) => normTitle(v) === k)) || [];
  let cq = [];
  try { cq = require('./content-quality').getVenueAliasGroup(venue) || []; } catch (_) { /* optional */ }
  return [venue, ...extra, ...cq];
}
// Words that mark another version of a work in a subtitle ("It's A Wonderful Life: The Musical", "...: Film Review").
// A billed-title headline's colon is usually a critic's deck ("Hay Fever: Richard E. Grant hams it up"), so only these count.
// "musical", "play" and "show" are not among them: they describe the show itself ("The Last Ship: Sting's musical is ...").
const VERSION_WORD_RE = /^(radio|opera|ballet|concert|panto|pantomime|program|programme|film|movie|remix|edition|version|cookbook|album|tour|touring|series|season|episode|novel)$/;
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
function otherProductionCue(text, aka, show, opts = {}) {
  let raw = fold(String(text || '')).replace(/[‘’ʼ`]/g, "'");
  // A Google News title ends " - <Publisher>" ("- Maryland Theatre Guide", "- Broadway Shows"): the publisher is not
  // the staging (BRO-7785). Dropped when the last dash segment holds none of the matched title's words.
  const pub = /\s[-–—]\s([^-–—]{2,60})$/.exec(raw);
  if (pub && !sigWords(pub[1]).some((w) => sigWords(aka).includes(w))) raw = raw.slice(0, pub.index);
  const own = (show && show.title) || '';
  const venues = [...(show && show.venue ? [show.venue] : []), ...pressVenuesForTitle(own)].flatMap(venueAliases);
  const billed = !!opts.billed; // a billed or main title matched: only cues that name a company or another version
  const venueW = new Set(venues.flatMap((v) => sigWords(v)).filter((w) => !VENUE_GENERIC.has(w)));
  const textW = new Set(normTitle(raw).split(' '));
  if (textW.has('broadway') || textW.has('broadways') || [...venueW].some((w) => textW.has(w))) return null;
  if (opts.film !== false && FILM_CUE_RE.test(raw)) return 'film';
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
    // Billed title: only a company's possessive ("Irish Rep's", "Ross Valley Players'"), not a playwright's ("Caryl
    // Churchill's magnificent Cloud 9") or a critic's.
    if (billed && !COMPANY_WORD_RE.test(before.slice(Math.max(0, pos.index - 40), pos.index + pos[0].length).split(/[,:;|"“”]/).pop())) continue;
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
    const fresh = words.filter((w) => !ownW.has(w));
    if (fresh.length && (!billed || fresh.some((w) => VERSION_WORD_RE.test(w)))) return `subtitle:${sub[1].trim().slice(0, 40)}`;
  }
  // A parenthetical right after the title naming somewhere else ("It's A Wonderful Life" the Live Radio Show ( Citadel)):
  // a capitalised word that is not the show's own, a review word or a star rating (BRO-7785).
  const paren = /^[^()]{0,40}\(\s*([^()]{2,60})\)/.exec(after);
  if (paren && /^[A-Z]/.test(paren[1])) {
    const ownW = new Set(sigWords(own));
    // "(Published 2025)" is the New York Times archive tag; "(Theatre Review)" the article type.
    const pw = sigWords(paren[1]).filter((w) => !ownW.has(w) && !/^(review(s|ed)?|preview|nyc|ny|published|theatre|theater|\d+)$/.test(w));
    if (pw.length) return `paren:${paren[1].trim().slice(0, 40)}`;
  }
  const named = NAMED_COMPANY_RE.exec(after);
  if (named) return `company:${named[0].trim().slice(0, 40)}`;
  // "at <Somewhere> Theatre/Rep/Playhouse/Center" naming a venue (Title Case prose "At Every Turn" is not one).
  // "to/in <Somewhere> Stage" too ("Brings Sweet Nostalgia to Portland Stage"), but only with a name word besides the
  // company words: "Brings Joy to the Stage" names no venue (BRO-7785).
  for (const a of after.matchAll(/\b(at|At|AT|to|To|TO|in|In|IN)\s+(?:(?:the|The|THE)\s+)?([A-Z][A-Za-z0-9'.]*(?:\s+[A-Z][A-Za-z0-9'.]*){0,4})/g)) {
    if (!COMPANY_WORD_RE.test(a[2])) continue;
    if (!/^at$/i.test(a[1]) && !a[2].split(/\s+/).some((w) => !COMPANY_WORD_RE.test(w) && !/^(the|of|and)$/i.test(w))) continue;
    return `venue:${a[2].trim().slice(0, 40)}`;
  }
  // "at The Old Joint Stock, Birmingham": a named place then a city after a comma (BRO-7785).
  const place = /\bat\s+(?:the\s+|The\s+)?([A-Z][A-Za-z0-9'.]*(?:\s+[A-Z][A-Za-z0-9'.]*){0,4}),\s+([A-Z][a-z]+)/.exec(after);
  if (place) return `venue:${place[1].trim().slice(0, 40)}, ${place[2]}`;
  return null;
}

/**
 * BRO-7785: otherProductionCue for a headline that names the show by its billed or main title. Licensed titles are
 * staged everywhere ("Review: IT'S A WONDERFUL LIFE: A LIVE RADIO PLAY at Stages Houston"), so the billed title is no
 * proof of this production either. Applies to NYC and London shows only: a regional or touring entry IS one of those
 * other stagings, and its venue list is the weaker evidence. The film cue is off for the full billed title (a stage
 * adaptation's own review says "the beloved film"); the main title alone keeps it ("It's a Wonderful Life (1946)").
 * @param {string} text headline (or cased slug text)
 * @param {string} name the billed or main title that matched
 * @param {string} showTitle the show's billed title
 * @param {{main?: boolean}} [opts] main: the match was on the main title before a subtitle
 * @returns {string|null}
 */
const HOME_MARKETS = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);
function billedTitleOtherProductionCue(text, name, showTitle, opts = {}) {
  const markets = registry().marketsByTitle.get(normTitle(showTitle));
  if (markets && ![...markets].some((m) => HOME_MARKETS.has(m))) return null;
  return otherProductionCue(text, name, { title: showTitle }, { film: !!opts.main, billed: true });
}

/** Name words of a show's cast and creative team, by billed title (BRO-7785). Empty when unknown. */
function pressPeopleForTitle(title) { return registry().peopleByTitle.get(normTitle(title)) || new Set(); }

// NYC and London houses and resident companies a review names instead of the venue field (old names included).
const HOME_HOUSES = ['cort', 'james earl jones', 'american airlines', 'todd haimes', 'roundabout', 'laura pels', 'manhattan theatre club',
  'friedman', 'lincoln center', 'beaumont', 'newhouse', 'second stage', 'hayes', 'atlantic', 'linda gross', 'playwrights horizons',
  'public theater', 'signature', 'mcc', 'new york theatre workshop', 'nytw', 'vineyard', 'primary stages', 'irish rep',
  'irish repertory', 'soho rep', 'ars nova', 'audible', 'park avenue armory', 'st anns', 'st ann s', 'bam', 'classic stage',
  'pershing square', 'mint', 'keen', 'transport group', 'york theatre', '59e59', 'theatre row', 'lortel', 'cherry lane',
  'minetta lane', 'westside', 'new world stages', 'daryl roth', 'orpheum', 'astor place', 'city center', 'brooks atkinson',
  'lena horne', 'henry miller', 'sondheim', 'biltmore', 'royale', 'jacobs', 'plymouth', 'schoenfeld', 'virginia',
  'august wilson', 'foxwoods', 'lyric', 'hilton', 'longacre', 'booth', 'belasco', 'hudson', 'lyceum', 'studio 54',
  'national theatre', 'lyttelton', 'olivier', 'dorfman', 'donmar', 'almeida', 'old vic', 'young vic', 'bridge theatre',
  'royal court', 'hampstead', 'menier', 'barbican', 'globe', 'kiln', 'southwark playhouse', 'park theatre', 'orange tree',
  'arcola', 'finborough', 'kings head', 'jermyn street', 'charing cross', 'turbine', 'riverside', 'sohoplace', 'harold pinter',
  'comedy theatre', 'tom stoppard', 'duke of york', 'wyndham', 'noel coward', 'gielgud', 'garrick', 'haymarket', 'apollo',
  'shubert', 'majestic', 'imperial', 'winter garden', 'hirschfeld', 'st james', 'nederlander', 'gershwin', 'ambassador',
  'richard rodgers', 'walter kerr', 'eugene oneill', 'music box', 'neil simon', 'broadhurst', 'barrymore', 'golden',
  'marquis', 'minskoff', 'new amsterdam', 'palace', 'circle in the square', 'helen hayes', 'stephen sondheim', 'mark taper',
  'victoria palace', 'piccadilly', 'phoenix', 'cambridge', 'criterion', 'fortune', 'vaudeville', 'ambassadors', 'st martins',
  'st lukes', 'sadlers wells', 'stratford east', 'pan asian', 'etcetera', 'regents park', 'open air', 'chichester',
  'savoy', 'palladium', 'dominion', 'adelphi', 'aldwych', 'novello', 'prince edward', 'prince of wales', 'shaftesbury'];
const SLUG_COMPANY_RE = /^(theatre|theater|theatres|theaters|theatreworks|theaterworks|rep|repertory|players|playhouse|company|stages|guild|ensemble)$/;
const SLUG_SKIP = new Set(['as', 'is', 'for', 'to', 'on', 'end', 'review', 'reviews', 'reviewed', 'theater', 'theatre', 'the', 'a', 'an', 'of', 'at', 'by', 'in', 'and', 'with', 'html', 'htm', 'php', 'amp', 'article', 'news', 'stage', 'play', 'musical']);
const SLUG_PLACE_SKIP = new Set(['nyc', 'ny', 'new', 'york', 'london', 'west', 'end', 'off']);
/**
 * BRO-7785: a URL slug that names another staging after the show's title ("...-a-live-radio-play-at-stages-houston",
 * "...-review-oil-lamp-theaters-live-radio-play"): a company word with a name word before it, the venue and Broadway
 * aside. NYC and London shows only (as billedTitleOtherProductionCue). Returns the cue or null.
 */
function slugOtherStagingCue(url, showTitle) {
  // Only titles billed by NYC/London entries alone: a tour or regional entry with the same title is gathered with this
  // same check (it receives only the title), and its reviews name every city's venue.
  const markets = registry().marketsByTitle.get(normTitle(showTitle));
  if (!markets || [...markets].some((m) => !HOME_MARKETS.has(m))) return null;
  let p;
  try { p = decodeURIComponent(new URL(url).pathname); } catch (_) { return null; }
  const toks = normTitle(p.replace(/\.[a-z0-9]+$/i, '')).split(' ').filter(Boolean);
  if (toks.includes('broadway') || toks.includes('broadways')) return null;
  // A home-city slug ("-at-the-cort-theatre-new-york") or a home-city house under any of its names is the show's own
  // city: renamed venues and resident companies are not in shows.json's venue field.
  const flat = ` ${toks.join(' ')} `;
  if (/ (new york|nyc|manhattan|london|west end|off broadway) /.test(flat) || HOME_HOUSES.some((h) => flat.includes(` ${h} `))) return null;
  const venueW = new Set(pressVenuesForTitle(showTitle).flatMap(venueAliases).flatMap((v) => sigWords(v)).filter((w) => !VENUE_GENERIC.has(w)));
  if (toks.some((t) => venueW.has(t))) return null;
  const titleW = new Set(sigWords(showTitle));
  // The end of the first run of title words: the staging is named after it ("...-wonderful-life-review-oil-lamp-
  // theaters-live-radio-play" names Oil Lamp before the subtitle's own words).
  let last = toks.findIndex((t) => titleW.has(t));
  if (last < 0) return null;
  while (last + 1 < toks.length && (toks[last + 1] !== 'at' || titleW.has(toks[last + 2])) && (titleW.has(toks[last + 1]) || STOP.includes(toks[last + 1]))) last += 1;
  const nameWord = (t) => !SLUG_SKIP.has(t) && !titleW.has(t) && !SLUG_COMPANY_RE.test(t) && !/^\d+$/.test(t) && !SLUG_PLACE_SKIP.has(t);
  // "-at-<place>-<company>" or "-at-<company>-<place>" after the title ("-at-stages-houston", "-at-oil-lamp-theater").
  // A bare company word is not enough: "-theater-review-glenn-close" is the article type and a star's name.
  for (let a = last + 1; a < toks.length; a += 1) {
    if (toks[a] !== 'at') continue;
    const span = toks.slice(a + 1, a + 6);
    const c = span.findIndex((t) => SLUG_COMPANY_RE.test(t));
    if (c < 0 || !span.slice(0, c).every((t) => t === 'the' || nameWord(t))) continue;
    const name = [...span.slice(0, c), ...span.slice(c + 1, c + 3)].filter(nameWord);
    if (name.length) return `slug:at-${span.slice(0, c + 1).join('-')}`;
  }
  // "...-wonderful-life-review-oil-lamp-theaters-...": a named company straight after the title (and "review").
  let b = last + 1;
  while (b < toks.length && /^(review|reviews|reviewed)$/.test(toks[b])) b += 1;
  const head = toks.slice(b, b + 4);
  const c = head.findIndex((t) => SLUG_COMPANY_RE.test(t));
  // Two name words at least ("oil-lamp-theaters"): one is usually a description ("dark-theater", "union-theatre-review").
  // A singular "theater"/"theatre" there is mostly a description ("riveting-documentary-theater", "fishburne-theater-review").
  if (c > 1 && !/^(theater|theatre)$/.test(head[c]) && head.slice(0, c).every(nameWord) && !/^critics?$/.test(head[c + 1] || '')) return `slug:${head.slice(0, c + 1).join('-')}`;
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
  billedTitleOtherProductionCue, slugOtherStagingCue, pressPeopleForTitle,
};
