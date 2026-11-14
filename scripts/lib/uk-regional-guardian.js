'use strict';
// venue-write-guard-ok: venue here is a name from the checked-in data/uk-regional-venues.json table, passed on as a routing hint; the shows.json write goes through buildRegionalShowEntry -> sanitizeVenueForWrite.
/**
 * Noteworthy-UK-regional trigger (BRO-4923, owner ask 2026-10-09: "pull
 * reviews for As You Like It and any other high profile shows outside of
 * London ... not all, but some threshold or trigger for the really
 * noteworthy ones").
 *
 * THE GAP: a UK show outside London only reached shows.json when a BWW or
 * Playbill roundup named it (Game of Thrones: The Mad King did; the RSC As
 * You Like It with Jonathan Groff, press night 2026-10-06, did not), and the
 * Guardian reverse-discovery feed dropped every non-London, non-NYC review.
 *
 * THE TRIGGER: a Guardian critic review of a production at one of the
 * flagship houses in data/uk-regional-venues.json. The venue table is the
 * "noteworthy" filter (RSC, Chichester, Royal Exchange, Crucible, ...); the
 * Guardian review is the proof critics covered it. Adding a house is one
 * entry in that JSON. A show promoted this way is provisional, and a regional
 * show shows no score until it has 3 reviews (score-buckets.ts), so a house
 * production the national press ignores stays unscored rather than wrong.
 *
 * Pure (no I/O beyond the venue table) per CLAUDE.md §15.
 */

const UK_VENUES = require('../../data/uk-regional-venues.json');
const { foldDiacritics } = require('./title-match');

const norm = (s) => foldDiacritics(String(s || ''))
  .toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[^a-z0-9']+/g, ' ')
  .trim();

// Words that mark a slug as naming SOME venue. A company-level tag ("Royal
// Shakespeare Company") alone does not prove the review is of a show AT that
// company's house: the RSC and Bristol Old Vic co-produce and tour, and the
// Guardian tags the company either way.
const SLUG_VENUE_WORDS = new Set([
  'theatre', 'theater', 'playhouse', 'rep', 'opera', 'hall', 'festival', 'arts',
  'centre', 'center', 'lyceum', 'stage', 'studio', 'cathedral', 'castle',
]);

/**
 * Which flagship UK house a Guardian item belongs to, from its keyword tags
 * and URL slug. Aliases are matched on whole phrases.
 *
 * A slug that names the house is proof. A tag alone is accepted only when the
 * slug names no other venue, or also names this house's city (Antigone Exits:
 * tag "Chichester Festival theatre", slug "...-minerva-theatre-chichester-..."),
 * so a tour date reviewed at a Newcastle theatre but tagged with the RSC is
 * dropped instead of filed at Stratford.
 *
 * @param {{tags?: string[], slug?: string}} p tags already lower-cased/decoded or not (normalised here)
 * @returns {{venue: string, city: string, match: string, domain: string}|null}
 */
function ukFlagshipVenueFor({ tags = [], slug = '' } = {}) {
  const slugText = norm(String(slug).replace(/-/g, ' '));
  const slugTokens = slugText.split(' ').filter(Boolean);
  const tagTexts = tags.map(norm).filter(Boolean);
  // Receiving houses (guardianTrigger: false) mostly host tours, so a review
  // there is not a new regional production (BRO-6516 ship-check).
  const venues = UK_VENUES.filter((v) => v.guardianTrigger !== false);
  const entry = (v) => {
    const aliases = (v.aliases && v.aliases.length ? v.aliases : [v.match]).map(norm);
    const hit = (h) => aliases.some((a) => new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(h));
    return { hit, result: { venue: v.venue || v.match, city: v.city, match: v.match, domain: v.domain } };
  };
  // Slug first across every house: a slug naming the Playhouse beats an
  // earlier house's tag ("Liverpool Everyman and Playhouse").
  for (const v of venues) {
    const { hit, result } = entry(v);
    if (hit(slugText)) return result;
  }
  for (const v of venues) {
    const { hit, result } = entry(v);
    if (tagTexts.some(hit)) {
      const cityToken = norm(v.city).split(' ')[0];
      const namesOtherVenue = slugTokens.some((t) => SLUG_VENUE_WORDS.has(t));
      if (!namesOtherVenue || slugTokens.includes(cityToken)) return result;
    }
  }
  return null;
}

/** The table entry for `venue` (as stored on a candidate or show), or undefined. */
function ukVenueEntry(venue) {
  const v = norm(venue);
  return v ? UK_VENUES.find((e) => v.includes(norm(e.match))) : undefined;
}

/** True when `venue` (as stored on a candidate or show) is one of the flagship UK houses. */
function isUkFlagshipVenue(venue) {
  return !!ukVenueEntry(venue);
}

/**
 * Regional shows at a flagship UK house. The audit's "is this already
 * catalogued?" index is built from these only: a title-only index would let an
 * open US regional Hamlet hide the RSC Hamlet the Guardian just reviewed.
 */
function ukFlagshipShows(shows) {
  return (shows || []).filter((s) => s && s.category === 'regional' && isUkFlagshipVenue(s.venue));
}

const DAY_MS = 86400000;
const titleKeys = (t) => {
  const full = norm(t).replace(/ /g, '');
  const keys = new Set(full ? [full] : []);
  const head = norm(String(t || '').split(/:| - /)[0]);
  // A multi-word head ("Game of Thrones" for "Game of Thrones: The Mad King") matches too.
  if (head && head.includes(' ') && head.length >= 6) keys.add(head.replace(/ /g, ''));
  return keys;
};

/**
 * Is `candidate` (a Guardian item or staged row: title, venue, date or
 * articlePublishedAt) a review of the production `show` already catalogues?
 * Same flagship house, same title, and a review date inside the show's run
 * (previews to closing, or 120 days when it has no closing date) give or take
 * three weeks. Title alone is not enough: the RSC restages the canon, so a new
 * Twelfth Night must not be swallowed by a closed 2019 one, and a Hamlet at
 * Bristol Old Vic is not the RSC Hamlet.
 *
 * `opts.houseOf` swaps the house table: the Off-West End Guardian stager
 * (lib/owe-guardian-staging.js) passes its London one. It maps a venue string
 * to a table entry (compared by identity) or undefined.
 */
function isSameProduction(candidate, show, opts = {}) {
  if (!candidate || !show) return false;
  const houseOf = typeof opts.houseOf === 'function' ? opts.houseOf : ukVenueEntry;
  const house = houseOf(candidate.venue);
  if (!house || house !== houseOf(show.venue)) return false;
  const a = titleKeys(candidate.title);
  const b = titleKeys(show.title);
  if (![...a].some((k) => b.has(k))) return false;
  const at = Date.parse(candidate.date || candidate.articlePublishedAt);
  const dates = [show.previewsStartDate, show.openingDate].map((d) => Date.parse(d)).filter(Number.isFinite);
  if (!Number.isFinite(at) || dates.length === 0) return true; // cannot tell: treat as already catalogued
  const start = Math.min(...dates);
  const close = Date.parse(show.closingDate);
  const end = Number.isFinite(close) ? close : Math.max(...dates) + 120 * DAY_MS;
  return at >= start - 21 * DAY_MS && at <= end + 21 * DAY_MS;
}

/** The catalogued show `candidate` reviews, or undefined. */
function findSameProduction(candidate, shows, opts = {}) {
  return (shows || []).find((s) => isSameProduction(candidate, s, opts));
}

/**
 * Promotion gate for a staged Guardian-sourced candidate. A named national
 * critic's review at a flagship house is the whole signal; fail closed on
 * anything else.
 *
 * @param {{source?: string, venue?: string, sourceUrl?: string}} candidate
 * @returns {{confirmed: boolean, reason: string, source?: string}}
 */
function decideUkFlagshipPromotion(candidate) {
  if (!candidate || candidate.source !== 'guardian-review') {
    return { confirmed: false, reason: 'not a guardian-review candidate' };
  }
  if (!isUkFlagshipVenue(candidate.venue)) {
    return { confirmed: false, reason: `venue "${candidate.venue}" is not a flagship UK regional house (data/uk-regional-venues.json)` };
  }
  if (ukVenueEntry(candidate.venue).guardianTrigger === false) {
    return { confirmed: false, reason: `venue "${candidate.venue}" is a receiving house; its Guardian reviews are mostly tours` };
  }
  if (!candidate.sourceUrl) {
    return { confirmed: false, reason: 'guardian-review candidate has no review URL' };
  }
  return {
    confirmed: true,
    reason: `Guardian review at flagship UK house (${candidate.venue})`,
    source: 'guardian-review',
  };
}

/**
 * Staged-candidate rows for the uk-regional items reverse-discovery found
 * missing from shows.json. Same row shape the roundup extractor stages, so
 * the existing regional promotion loop (dedup, id, validate-data gate) takes
 * them with no second code path.
 *
 * @param {Array<{title: string, url: string, date: string, market?: string, venue?: string, source?: string}>} candidates
 *   data/audit/reverse-discovery-candidates.json `candidates`
 * @param {string} [nowIso]
 */
function stageUkRegionalCandidates(candidates, nowIso = new Date().toISOString()) {
  const out = [];
  const seen = new Set();
  for (const c of candidates || []) {
    if (!c || c.market !== 'uk-regional' || c.source !== 'guardian-review') continue;
    if (!c.title || !c.url || !c.venue || !isUkFlagshipVenue(c.venue)) continue;
    const titleSlug = foldDiacritics(c.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // The house key keeps ids apart when two flagship houses stage the same
    // title in one year (Hamlet at the RSC and at Bristol Old Vic).
    const slug = titleSlug && `${titleSlug}-${ukVenueEntry(c.venue).idKey}`;
    const key = `${slug}|${norm(c.venue)}`;
    if (!slug || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: c.title,
      slug,
      venue: c.venue,
      category: 'regional',
      source: 'guardian-review',
      sourceUrl: c.url,
      articlePublishedAt: c.date,
      discoveredAt: nowIso,
    });
  }
  return out;
}

module.exports = { ukFlagshipVenueFor, isUkFlagshipVenue, ukVenueEntry, ukFlagshipShows, isSameProduction, findSameProduction, decideUkFlagshipPromotion, stageUkRegionalCandidates };
