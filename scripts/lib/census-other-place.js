'use strict';

/**
 * BRO-7129: does a SERP-census candidate review the same title staged in ANOTHER
 * place than this New York show?
 *
 * The naive census arm ("<title> review", no site: and no date window) is how
 * the classics pick up every staging in the English-speaking world. King Lear
 * (Off-Broadway, The Secret Theatre, opened 2026-11-05) counted 10 "known"
 * reviews, all of other productions: Royal Exchange Manchester (Guardian, jadar,
 * theatretradge), Ian McKellen at the Duke of York's, Richmond Theatre, the Lupin
 * Theater in New Orleans, Babes with Blades in Chicago (Chicago Reader, Third
 * Coast Review). The weekly opening grade then read "0 reviews live of 13 known".
 * The existing guards only saw London houses on .uk hosts and BroadwayWorld city
 * editions.
 *
 * Two signals, New York shows only (category broadway / off-broadway), never for
 * a show that declares priorRuns (its earlier run's reviews count):
 *   1. 'place-in-slug': the URL path or SERP title names a non-New-York city or
 *      house (after the show's own title words are removed, so "Chicago" the
 *      musical or "London Road" never trips it) and names neither New York nor
 *      the show's venue.
 *   2. 'regional-outlet': the outlet is registered to a non-NY US metro, is a
 *      small outlet (tier 3+), has no standing New York coverage, and the URL or
 *      title never names New York. Big regional papers (LA Times, Chicago
 *      Tribune) send critics to Broadway, so tier 1-2 stay exempt.
 *
 * Pure (CLAUDE.md section 15): the caller passes the outlet registry entry.
 * Kill switch: CENSUS_OTHER_PLACE_DISABLED=1.
 */

const NY_CATEGORIES = new Set(['broadway', 'off-broadway']);

// Named houses and companies outside New York. Always a place, wherever they sit.
// "national-theatre" / "rsc" also name companies whose shows transfer to New York
// (BRO-4190); a New York review of the transfer names New York or the venue, and
// the NY veto below keeps it.
const OTHER_HOUSES = [
  'royal-exchange', 'duke-of-yorks', 'richmond-theatre', 'lyric-hammersmith', 'royal-court', 'almeida',
  'donmar', 'young-vic', 'old-vic', 'bridge-theatre', 'hampstead-theatre', 'menier-chocolate-factory',
  'barbican', 'southwark-playhouse', 'kiln-theatre', 'orange-tree-theatre', 'shakespeares-globe',
  'sam-wanamaker', 'national-theatre', 'royal-shakespeare-company', 'theatre-royal', 'crucible-theatre',
  'leeds-playhouse', 'oxford-playhouse', 'london-coliseum', 'chichester-festival', 'chicago-shakespeare', 'chicago-shakes',
  'goodman-theatre', 'lupin-theater', 'kennedy-center', 'arena-stage', 'guthrie-theater',
  'mark-taper', 'pasadena-playhouse', 'old-globe', 'la-jolla-playhouse', 'huntington-theatre',
  'american-repertory-theater', 'alley-theatre', 'wales-millennium-centre',
];

// Cities: a city in a slug is often the subject ("madness in Detroit", "from Texas to the
// hospital") or a modifier ("London-born revival", "London hit Cable Street"), so a city only
// counts as a staging place when it IS a path segment (an edition path: /london/, /chicago/)
// or sits next to a staging word ("musical-chicago-review", "palace-theatre-london",
// "los-angeles-theater"). A segment that merely starts with a city ("chicago-duo-zaps",
// "manchester-by-the-sea-author", "london-transplant-...") is not enough. Cities that are also
// common surnames, streets or words (Austin Pendleton, Houston Street, Phoenix Theatre
// Ensemble, Bath, Oxford) are left out.
const CITIES = [
  'chicago', 'los-angeles', 'san-francisco', 'san-diego', 'boston', 'philadelphia', 'washington-dc',
  'seattle', 'atlanta', 'minneapolis', 'pittsburgh', 'new-orleans', 'nola', 'baltimore', 'nashville',
  'st-louis', 'kansas-city', 'milwaukee', 'cincinnati', 'toronto', 'chicagoland',
  'london', 'west-end', 'manchester', 'birmingham', 'liverpool', 'leeds', 'bristol', 'edinburgh',
  'glasgow', 'cardiff', 'chichester', 'sheffield', 'nottingham', 'dublin', 'belfast',
  'stratford-upon-avon',
];
const STAGING_WORDS = new Set([
  'review', 'reviews', 'theatre', 'theater', 'theatres', 'theaters', 'musical', 'production', 'staging',
  'premiere', 'playhouse', 'opera', 'coliseum', 'centre', 'stage', 'run', 'revival', 'shakes',
]);
// A house noun one word further on still names a staging place ("st-louis-family-theatre").
const HOUSE_NOUNS = new Set(['theatre', 'theater', 'playhouse', 'opera', 'centre']);
// "London hit", "London-born", "Chicago transfer": the city describes this show's history.
const CITY_MODIFIER_VETO = new Set(['hit', 'born', 'import', 'transfer', 'transfers', 'transplant', 'smash', 'favorite', 'favourite', 'sensation', 'success', 'bound']);
// "from the West End", "her West End staging", "reprises his London performance": the city is
// where the show came from, so this staging is elsewhere (New York).
const CITY_ORIGIN_VETO = new Set(['from', 'her', 'his', 'their', 'its', 'reprises', 'reprise', 'reprising', 'after']);

const NY_MARKERS = [
  'new-york', 'newyork', 'nyc', 'ny', 'manhattan', 'brooklyn', 'queens', 'bronx', 'harlem',
  'broadway', 'broadways', 'off-broadway', 'offbroadway', 'off-off-broadway', 'astoria', 'long-island-city',
];

// Registry regions that are New York, national or the other market (London outlets review
// New York transfers; that call is otherProductionUrlSignal's, not this one's).
const NOT_REGIONAL = new Set(['nyc', 'nj', 'us', 'dual', 'london', 'uk']);
// A regional outlet with this many reviews already live on New York shows covers New York
// (Arts Fuse 22, Third Coast Review 2, Theater Mirror 1) and keeps its census rows: one live
// New York review is proof it sends critics here, and dropping its rows would blind the
// recall probes (coverage-adversarial-probe, audit-serp-census-recall) to that outlet.
const NY_COVERAGE_MIN = 1;

function tokensOf(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u2019']/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/** Start indexes of every contiguous occurrence of phrase ("a-b") in tokens. */
function runsAt(tokens, phrase) {
  const want = phrase.split('-');
  const at = [];
  for (let i = 0; i + want.length <= tokens.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) if (tokens[i + k] !== want[k]) { ok = false; break; }
    if (ok) at.push(i);
  }
  return at;
}
const hasRun = (tokens, phrase) => runsAt(tokens, phrase).length > 0;

function cityStaged(tokens, city) {
  const len = city.split('-').length;
  return runsAt(tokens, city).some((i) => {
    const before = tokens[i - 1];
    const after = tokens[i + len];
    // "London hit", "Edinburgh Fringe hit", "London-born": the show's history, not this staging.
    if (CITY_MODIFIER_VETO.has(after) || CITY_MODIFIER_VETO.has(tokens[i + len + 1])) return false;
    if (CITY_ORIGIN_VETO.has(before) || (before === 'the' && CITY_ORIGIN_VETO.has(tokens[i - 2]))) return false;
    // "London Review of Books" is a magazine, not a London review.
    if (after === 'review' && tokens[i + len + 1] === 'of') return false;
    return STAGING_WORDS.has(before) || STAGING_WORDS.has(after) || HOUSE_NOUNS.has(tokens[i + len + 1]);
  });
}

function pathOf(u) {
  try { return decodeURIComponent(new URL(u).pathname); } catch { return null; }
}

/**
 * @param {string} url candidate URL
 * @param {string|null} serpTitle SERP result title (empty for prior-census reseeds)
 * @param {{category?: string, title?: string, venue?: string, priorRuns?: any[]}} show
 * @param {{region?: string, tier?: number, isDualMarket?: boolean, standingMarkets?: string[], standingCoverage?: any, displayName?: string, nyReviewCount?: number}|null|(() => object|null)} outletArg
 *   registry entry for the URL's host plus nyReviewCount (its live reviews on New York shows),
 *   or a function returning it (called only for an in-scope show, so London shows never pay
 *   for the lookup)
 * @returns {{signal: string, detail: string}|null}
 */
function censusOtherPlaceSignal(url, serpTitle, show, outletArg) {
  if (process.env.CENSUS_OTHER_PLACE_DISABLED === '1') return null;
  if (!show || !NY_CATEGORIES.has(show.category)) return null;
  if (Array.isArray(show.priorRuns) && show.priorRuns.length > 0) return null;
  const path = pathOf(url);
  if (path == null) return null;
  const outlet = typeof outletArg === 'function' ? outletArg() : outletArg;

  // The show's own title words never count ("Chicago" the musical, "London Road").
  const titleSet = new Set(tokensOf(show.title));
  const strip = (s) => tokensOf(s).filter((t) => !titleSet.has(t));
  const outletToks = new Set(outlet && outlet.displayName ? tokensOf(outlet.displayName) : []);
  const titleToks = strip(serpTitle).filter((t) => !outletToks.has(t));
  const segments = path.split('/').filter(Boolean).map(strip);
  const all = [...segments.flat(), ...titleToks];

  // The New York / venue veto reads the UNSTRIPPED words: a show titled "New York, New York"
  // or named for its venue must still be vetoed by them.
  const raw = [...path.split('/').flatMap(tokensOf), ...tokensOf(serpTitle)];
  const venueKey = tokensOf(String(show.venue || '').replace(/^the\s+/i, '')).join('-');
  if ((venueKey.replace(/-/g, '').length >= 6 && hasRun(raw, venueKey)) || NY_MARKERS.some((m) => hasRun(raw, m))) return null;

  const house = OTHER_HOUSES.find((h) => hasRun(all, h));
  if (house) return { signal: 'place-in-slug', detail: `url/title names "${house.replace(/-/g, ' ')}", not New York or ${show.venue || 'the venue'}` };
  const pathToks = segments.flat();
  const city = CITIES.find((c) => segments.some((seg) => seg.join('-') === c)
    || cityStaged(pathToks, c) || cityStaged(titleToks, c));
  if (city) return { signal: 'place-in-slug', detail: `url/title places it in ${city.replace(/-/g, ' ')}, not New York` };

  if (outlet && outlet.region && !NOT_REGIONAL.has(outlet.region)
    && Number(outlet.tier) >= 3 && !outlet.isDualMarket && !outlet.standingCoverage
    && !(Array.isArray(outlet.standingMarkets) && outlet.standingMarkets.length > 0)
    && !(Number(outlet.nyReviewCount) >= NY_COVERAGE_MIN)) {
    return { signal: 'regional-outlet', detail: `${outlet.displayName || 'outlet'} is a ${outlet.region} outlet with no New York reviews on the site` };
  }
  return null;
}

module.exports = { censusOtherPlaceSignal, OTHER_HOUSES, CITIES, NY_MARKERS, NY_COVERAGE_MIN };
