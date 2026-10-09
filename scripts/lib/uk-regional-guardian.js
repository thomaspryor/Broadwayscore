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

/**
 * Which flagship UK house a Guardian item belongs to, from its keyword tags
 * and URL slug. Aliases are matched on whole words, so "rsc" in a slug counts
 * but "rscx" does not.
 *
 * @param {{tags?: string[], slug?: string}} p tags already lower-cased/decoded or not (normalised here)
 * @returns {{venue: string, city: string, match: string, domain: string}|null}
 */
function ukFlagshipVenueFor({ tags = [], slug = '' } = {}) {
  const haystacks = [...tags.map(norm), norm(String(slug).replace(/-/g, ' '))].filter(Boolean);
  for (const v of UK_VENUES) {
    const aliases = (v.aliases && v.aliases.length ? v.aliases : [v.match]).map(norm);
    for (const a of aliases) {
      const re = new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
      if (haystacks.some((h) => re.test(h))) {
        return { venue: v.venue || v.match, city: v.city, match: v.match, domain: v.domain };
      }
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

module.exports = { ukFlagshipVenueFor, isUkFlagshipVenue, ukVenueEntry, ukFlagshipShows, decideUkFlagshipPromotion, stageUkRegionalCandidates };
