'use strict';

/**
 * Single source of truth for deriving outlet → region / dual-market / tier lookups
 * from outlet-registry.json. Extracted from validate-data.js (2026-06-26) so the
 * cross-market contamination audit and validate-data.js share ONE implementation —
 * including the alias-lowercasing nuance that a ship-check already had to fix once
 * (uppercase aliases like "The Times"/"FT" otherwise miss the region lookup and
 * silently classify 'skip'; ship-check 2026-06-15).
 *
 * Pure function — pass the parsed registry object (the thing with `.outlets`).
 *
 * @param {object} reg - parsed outlet-registry.json ({ outlets: { id: {...} } })
 * @returns {{
 *   outletRegionMap: Record<string,string>,   // id + lowercased aliases -> region ('london'|'new-york'|'us'|'dual'|...)
 *   dualMarket: Set<string>,                   // ids + lowercased aliases with isDualMarket:true
 *   tier12Outlets: Set<string>,                // ids + lowercased aliases at tier 1 or 2
 *   outletTierMap: Record<string,number>,      // id + lowercased aliases -> numeric tier
 *   canonicalOutletId: Record<string,string>,  // id + lowercased aliases -> canonical id
 * }}
 */
function buildOutletMaps(reg) {
  const outletRegionMap = {};
  const dualMarket = new Set();
  const tier12Outlets = new Set();
  const outletTierMap = {};
  const canonicalOutletId = {};
  const outlets = (reg && reg.outlets) || {};

  for (const [id, info] of Object.entries(outlets)) {
    // west-end market with no explicit region falls back to 'london' (mirrors validate-data.js).
    const region = info.region || (info.market === 'west-end' ? 'london' : null);
    if (region) {
      outletRegionMap[id] = region;
      // Lowercase alias keys — lookups normalize via toLowerCase(); uppercase aliases
      // ("The Times", "FT") would otherwise miss. (ship-check 2026-06-15)
      if (info.aliases) for (const alias of info.aliases) outletRegionMap[alias.toLowerCase()] = region;
    }

    if (info.isDualMarket) {
      dualMarket.add(id);
      if (info.aliases) for (const alias of info.aliases) dualMarket.add(alias.toLowerCase());
    }

    canonicalOutletId[id] = id;
    if (info.aliases) for (const alias of info.aliases) canonicalOutletId[alias.toLowerCase()] = id;

    if (typeof info.tier === 'number') {
      outletTierMap[id] = info.tier;
      if (info.aliases) for (const alias of info.aliases) outletTierMap[alias.toLowerCase()] = info.tier;
    }
    if (info.tier === 1 || info.tier === 2) {
      tier12Outlets.add(id);
      if (info.aliases) for (const alias of info.aliases) tier12Outlets.add(alias.toLowerCase());
    }
  }

  return { outletRegionMap, dualMarket, tier12Outlets, outletTierMap, canonicalOutletId };
}

/**
 * Infer a region for a NEWLY auto-registered outlet from the market categories
 * of the shows its reviews appear on. Registering without a region makes the
 * rebuild's cross-market guard treat the outlet as US and flag its genuine
 * reviews wrongProduction on the very London shows it was discovered from
 * (task #817: liamodell/jonathan-baz on Now You See Me Live, 2026-08-04).
 *
 * Only returns 'london' when the market evidence is unanimously London; anything
 * else returns null (leave region unset — same behavior as before). A 'us'
 * inference is deliberately NOT made: the cross-market guard's US-side behavior
 * is already the default for region-less outlets, and stamping region:'us'
 * would disable the guard's urlIsUK domain fallback for that outlet's future
 * reviews — a net safety-net loss with no consumer (the self-heal only checks
 * 'london').
 *
 * @param {string[]} categories - show categories the outlet's reviews are filed under
 * @param {(cat: string) => boolean} isLondonMarket - venue-classification.js's predicate
 * @returns {'london'|null}
 */
function inferOutletRegionFromCategories(categories, isLondonMarket) {
  const cats = [...new Set((categories || []).filter(Boolean))];
  if (cats.length === 0) return null;
  if (cats.every(c => isLondonMarket(c))) return 'london';
  return null;
}

/**
 * Backfill region on ALREADY-REGISTERED outlets that have none, using the same
 * unanimous-category-evidence inference as auto-registration (BRO-133).
 *
 * inferOutletRegionFromCategories() above only ever ran at the moment an
 * outlet was FIRST auto-registered (task #817) — an outlet registered
 * before that fix landed (2026-08-04), or one whose first-seen review's
 * show category was inconclusive at registration time, was stuck
 * region-less forever: the newOutlets loop only touches outlets NOT YET in
 * the registry, so a region-less entry never got a second look even once
 * its evidence became unanimous. That left the cross-market guard's
 * fragile isUkUrl domain-substring fallback (venue-classification.js) as
 * the ONLY defense for these outlets — real for londonmumsmagazine
 * (auto-registered 2026-08-02, saved only because "london" happens to be a
 * substring of its own domain) and the root cause behind the
 * amomentwithfranca/readaboutstuff strandings this backfill retroactively
 * resolves.
 *
 * Mutates `outlets` in place (same contract as the auto-register call
 * site) and returns the list of ids that were backfilled, for logging.
 *
 * Stamps `regionInferredBy`/`regionInferredAt` alongside `region` — this is a
 * once-and-done inference (an outlet that already has a `region` is skipped
 * on every future call, same as auto-registration always was), so if the
 * evidence a stamp was based on later turns out wrong there is otherwise no
 * record of why `region` is what it is. `region` stays the field every guard
 * reads; the two new fields are metadata only, for a human tracing a bad
 * stamp back to this pass (ship-check adversarial review, codex, BRO-133).
 *
 * @param {object} outlets - outletRegistry.outlets (mutated in place)
 * @param {Record<string, Set<string>|string[]>} outletShowCategories - outlet id -> show categories it's been reviewed under
 * @param {(cat: string) => boolean} isLondonMarket
 * @param {string} [nowIso] - injectable clock for tests; defaults to new Date().toISOString()
 * @returns {string[]} ids that were backfilled with region:'london'
 */
function backfillMissingOutletRegions(outlets, outletShowCategories, isLondonMarket, nowIso) {
  const backfilled = [];
  for (const [id, info] of Object.entries(outlets || {})) {
    if (!info || info.region || info.isDualMarket) continue;
    const inferredRegion = inferOutletRegionFromCategories(
      [...(outletShowCategories[id] || [])], isLondonMarket);
    if (inferredRegion) {
      info.region = inferredRegion;
      info.regionInferredBy = 'backfillMissingOutletRegions (BRO-133)';
      info.regionInferredAt = nowIso || new Date().toISOString();
      backfilled.push(id);
    }
  }
  return backfilled;
}

/**
 * Region sets — the single source of truth for "is this outlet's region local
 * to this market?" (BRO-3247, 2026-09-15).
 *
 * SHAPE: a NATIONWIDE-OR-NEW-YORK allowlist, with unknown regions falling to
 * NON-local. Read this before widening it.
 *
 * The original bug was not that an allowlist is the wrong tool — it is that the
 * allowlist enumerated the wrong THING. It listed {nyc, national} and later
 * {nyc, national, us}, mixing "nationwide" values with an incomplete guess at
 * the city list, so outlets whose region named a real US market fell out:
 *   - 2026-09-14 (BRO-3247): Front Mezz Junkies (region:'us') was dropped from
 *     Safe House's BWW roundup as "non-local".
 *   - the follow-up fix added 'us' and still missed 'dual' (observer, nytg,
 *     musical-theatre-review) — caught by /second-opinion.
 *   - a live audit of the registry then showed 'new-york'
 *     (broadwaypodcastnetwork) was never covered by any version.
 *
 * So the allowlist now holds ONLY values meaning "nationwide" or "New York".
 * Anything else — a UK region, or any US CITY region (chicago, baltimore,
 * boston, ...) — is non-local, and a region value nobody has seen yet lands
 * non-local automatically, which is the safe default for a locality test whose
 * job is to reject a foreign or out-of-town roundup.
 *
 * A previous revision of this fix inverted it into a UK-only denylist. That
 * made every US city region Broadway-local and silently killed the validator's
 * other documented job — a 4/4 Chicago roundup served for a same-named
 * Broadway show passed intact (see the failure modes documented on
 * gather-reviews.js's validateBWWRoundupGeography). Do not re-invert it.
 *
 * 'nyc' and 'national' currently match ZERO outlets in the registry; they are
 * kept deliberately as defensive synonyms so a future writer using either
 * spelling is not silently classified foreign.
 */
const BROADWAY_LOCAL_REGIONS = new Set(['us', 'dual', 'national', 'nyc', 'new-york']);

/**
 * West End / off-West-End locality. 'dual' is included for the same reason it
 * is on the Broadway side: an explicitly dual-market outlet (observer, nytg,
 * musical-theatre-review) genuinely covers both, so it is local to both. The
 * inline test this replaces omitted 'dual' AND 'uk', which meant a WE roundup
 * carrying those outlets could be rejected wholesale as "non-London".
 *
 * NOTE vs cross-market-guard.js's UK_SIDE_REGIONS ({london, uk, dual}): that
 * set answers a DIFFERENT question — which regions are exempt from the
 * US-outlet cross-market FLAG — and deliberately treats 'dual' as UK-side for
 * flag purposes while excluding it from self-heal. Locality and
 * flag-exemption are not the same predicate; keep them separate.
 */
const WEST_END_LOCAL_REGIONS = new Set(['london', 'uk', 'national-uk', 'national', 'dual']);

/**
 * SERP-DISCOVERY whitelists — deliberately NARROW, and deliberately NOT the
 * locality sets above. These answer "should we spend paid SERP credit
 * enumerating this outlet for a show in this market?", where the ~863
 * region-less outlets are a long tail of blogs we do not want to query.
 * Widening these costs money; widening the locality sets drops real reviews.
 * Different questions, different failure modes — consumed by
 * gather-reviews.js's loadOutlets().
 */
const UK_SERP_REGIONS = new Set(['london', 'uk']);
const US_SERP_REGIONS = new Set(['us', 'chicago', 'los-angeles', 'philadelphia', 'boston', 'san-francisco', 'dual']);

/**
 * True when an outlet's registry region is local to the Broadway / off-Broadway
 * market. A missing region is LOCAL — buildOutletMaps never puts region-less
 * outlets into outletRegionMap, so treating them as local preserves the
 * long-standing permissive default for the ~863 untagged outlets. A region we
 * do not recognise is NOT local (see the shape note above).
 * @param {string|null|undefined} region
 * @returns {boolean}
 */
function isBroadwayLocalRegion(region) {
  if (!region) return true;
  return BROADWAY_LOCAL_REGIONS.has(String(region).toLowerCase());
}

/**
 * True when an outlet's registry region is local to the West End / off-West-End
 * market. Unlike the Broadway side, a missing region is NOT local here: that
 * mirrors the inline test this replaced, where only an explicit London-ish
 * region counted.
 * @param {string|null|undefined} region
 * @returns {boolean}
 */
function isWestEndLocalRegion(region) {
  if (!region) return false;
  return WEST_END_LOCAL_REGIONS.has(String(region).toLowerCase());
}

module.exports = {
  buildOutletMaps,
  inferOutletRegionFromCategories,
  backfillMissingOutletRegions,
  BROADWAY_LOCAL_REGIONS,
  WEST_END_LOCAL_REGIONS,
  UK_SERP_REGIONS,
  US_SERP_REGIONS,
  isBroadwayLocalRegion,
  isWestEndLocalRegion,
};
