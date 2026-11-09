/**
 * BRO-7086: undated review rows whose URL slug names a different venue.
 *
 * date-guard.js and collected-before-previews both need a publishDate, so an
 * undated row skips every date gate. market-routing's venue-in-URL check only
 * runs when a sibling show exists. A URL that names ANOTHER production's
 * venue (".../when-we-are-married-donmar-warehouse-review/" filed under the
 * 2010 Garrick run) therefore stays on the show with nothing to catch it.
 *
 * This is the standalone check: the URL names a known venue, and none of the
 * show's own venues (current, prior runs, transfer origin, renames) appear in
 * the URL. Scoped to the show's own venue list on purpose: a blanket "any
 * venue word" rule was rejected (BRO-6896, it would drop 633 live reviews).
 *
 * Pure functions, no I/O except buildVenueIndex's optional data reads.
 */
const fs = require('fs');
const path = require('path');
const { venuePhrases } = require('./market-routing');
const { foldDiacritics } = require('./title-match');
const { VENUE_ALIASES, findCanonical, parentBuildingOf } = require('./venue-aliases');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/** Lowercase URL path (host dropped), non-alphanumerics folded to hyphens, hyphen-padded. */
function urlPathSlug(url) {
  const noHost = String(url || '').replace(/^[a-z]+:\/\/[^\/]+/i, '').split(/[?#]/)[0];
  return `-${foldDiacritics(noHost).toLowerCase().replace(/[‘’′']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-`;
}

// Venue names that are also ordinary URL words or another show's title word
// ("The Revival, Chicago" vs every "revival" headline).
const EXTRA_AMBIGUOUS = new Set(['revival', 'factory', 'skylight', 'warehouse', 'cambridge', 'arts', 'lyric', 'apollo', 'onstage']);

// Theatres named after a person: the bare name in a URL is the person ("noel-coward-on-broadway",
// "stephen-sondheim-musical"), so it only counts as the venue when "theatre"/"theater" follows.
const PERSON_NAMED = new Set([
  'sondheim', 'stephen-sondheim', 'noel-coward', 'harold-pinter', 'august-wilson', 'james-earl-jones',
  'todd-haimes', 'brooks-atkinson', 'ethel-barrymore', 'john-golden', 'neil-simon', 'samuel-j-friedman',
  'richard-rodgers', 'eugene-oneill', 'lena-horne', 'gerald-schoenfeld', 'bernard-b-jacobs', 'walter-kerr',
  'helen-hayes', 'tom-stoppard', 'gillian-lynne', 'sam-wanamaker', 'vivian-beaumont', 'goodman', 'crucible',
]);

// One physical building / campus under several names. A URL naming any member is not foreign to a
// show filed at another member.
const CAMPUSES = [
  ['lincoln-center', 'vivian-beaumont', 'newhouse', 'claire-tow', 'mitzi'],
  ['pershing-square', 'signature', 'irene-diamond', 'romulus-linney', 'alice-griffin'],
  ['barbican'],
  ['city-center', 'encores'],
  ['national-theatre', 'olivier', 'lyttelton', 'dorfman', 'cottesloe'],
  ['shakespeares-globe', 'sam-wanamaker', 'globe'],
  ['young-vic', 'the-maria', 'maria', 'the-clare', 'clare'],
  ['helen-hayes', 'second-stage', 'hayes'],
  ['samuel-j-friedman', 'friedman', 'manhattan-theatre-club', 'mtc', 'biltmore'],
  ['todd-haimes', 'roundabout', 'laura-pels', 'american-airlines', 'stephen-sondheim-theatre', 'harold-and-miriam-steinberg'],
  ['southbank', 'queen-elizabeth-hall', 'purcell-room'],
];
function campusOf(phrase) {
  return CAMPUSES.findIndex(c => c.some(k => phrase === k || phrase.includes(k)));
}

function readJsonArray(file) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch (_) { return []; }
}

/** Every venue name the show legitimately covers: current, prior runs, rename history. */
function ownVenueNames(show) {
  const names = new Set();
  const add = v => { if (v && typeof v === 'string') names.add(v); };
  add(show.venue);
  for (const p of show.priorRuns || []) add(p && p.venue);
  for (const v of show.inheritedRunVenues || []) add(v);
  for (const n of [...names]) {
    const canon = findCanonical ? findCanonical(n) : null;
    const entry = canon && VENUE_ALIASES[canon];
    if (entry) { add(canon); for (const a of entry.aliases || []) add(a); }
  }
  return [...names];
}

/**
 * Map of slug phrase -> display venue name for every venue we know of
 * (shows.json venues, west-end / off-broadway lists, rename history).
 */
function buildVenueIndex(shows, extraNames = null) {
  const idx = new Map();
  const put = name => {
    for (const p of venuePhrases(name)) if (!idx.has(p)) idx.set(p, name);
  };
  for (const s of shows) {
    put(s.venue);
    for (const p of s.priorRuns || []) put(p && p.venue);
  }
  const lists = extraNames || [...readJsonArray('west-end-venues.json'), ...readJsonArray('off-broadway-venues.json')];
  for (const n of lists) put(n);
  for (const [canon, e] of Object.entries(VENUE_ALIASES)) {
    put(canon);
    for (const a of e.aliases || []) put(a);
  }
  return idx;
}

/**
 * @param {object} row  reviews.json row ({url, publishDate, ...})
 * @param {object} show shows.json entry for row.showId
 * @param {Map} venueIndex from buildVenueIndex
 * @returns {null | {venues: string[]}} the foreign venues the URL names
 */
function detectUndatedVenueUrl(row, show, venueIndex) {
  if (!row || !row.url || row.publishDate || !show) return null;
  const urlPath = urlPathSlug(row.url);
  const titleSlug = `-${foldDiacritics(String(show.title || '')).toLowerCase().replace(/[‘’′']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-`;
  const ownPhrases = new Set();
  for (const n of ownVenueNames(show)) for (const p of venuePhrases(n)) ownPhrases.add(p);
  // Any own-venue phrase in the URL means the review may be about this run.
  for (const p of ownPhrases) if (urlPath.includes(`-${p}-`)) return null;
  // Campus membership is read off the full venue slugs too: "National Theatre (Dorfman)" has no
  // venue phrase of its own (national is ambiguous) but its slug names the Dorfman.
  const ownSlugs = ownVenueNames(show).map(n => urlPathSlug(n).slice(1, -1));
  const ownCampuses = new Set([...ownPhrases, ...ownSlugs].map(campusOf).filter(i => i >= 0));
  for (const n of ownVenueNames(show)) {
    const par = parentBuildingOf(n);
    if (par) for (const pn of par.parentNames) for (const p of venuePhrases(pn)) ownPhrases.add(p);
  }
  // A tour plays many houses by design.
  if (show.category === 'tour' || /\btour\b/i.test(String(show.venue || ''))) return null;
  const named = [];
  for (const [phrase, name] of venueIndex) {
    if (!urlPath.includes(`-${phrase}-`)) continue;
    if (EXTRA_AMBIGUOUS.has(phrase)) continue;
    // The phrase is a word of the show's own title, not a venue mention.
    if (titleSlug.includes(`-${phrase}-`)) continue;
    if (PERSON_NAMED.has(phrase) && !/-(theatre|theater|playhouse)-/.test(urlPath.slice(urlPath.indexOf(`-${phrase}-`)))) continue;
    const c = campusOf(phrase);
    if (c >= 0 && ownCampuses.has(c)) continue;
    named.push({ phrase, name });
  }
  // A longer phrase absorbs shorter ones it contains ("donmar-warehouse" vs "warehouse").
  const foreign = named.filter(a => !named.some(b => b !== a && b.phrase.length > a.phrase.length && b.phrase.includes(a.phrase)));
  const clean = foreign.filter(f => ![...ownPhrases].some(o => o.includes(f.phrase) || f.phrase.includes(o)));
  return clean.length ? { venues: [...new Set(clean.map(f => f.name))] } : null;
}

module.exports = { detectUndatedVenueUrl, buildVenueIndex, ownVenueNames };
