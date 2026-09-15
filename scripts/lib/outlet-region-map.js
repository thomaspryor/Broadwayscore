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
 * WHY A UK DENYLIST AND NOT A US ALLOWLIST — read before "simplifying" this.
 * The Broadway-local test used to be an allowlist of US-ish region values.
 * That shape failed twice in 24h because the allowlist is OPEN: every time
 * someone tags an outlet with a new city, the allowlist silently starts
 * excluding it from Broadway roundups as "non-local".
 *   - 2026-09-14 (BRO-3247): the set was {nyc, national} and Front Mezz
 *     Junkies (region:'us') was dropped from Safe House's BWW roundup.
 *   - the follow-up fix widened it to {nyc, national, us} and STILL missed
 *     region:'dual' (observer, nytg, musical-theatre-review) — caught by
 *     /second-opinion before it could drop those live.
 * A live audit of data/outlet-registry.json on 2026-09-15 then showed the
 * allowlist was wrong in a third way: 'nyc' and 'national' match ZERO outlets
 * in the registry, while 'new-york' (broadwaypodcastnetwork), 'baltimore',
 * 'washington-dc', 'dc', 'nj', 'pittsburgh' and 'nashville' are all real
 * values that no allowlist version ever covered.
 *
 * The UK set is CLOSED and stable (we cover exactly one foreign market), so
 * defining non-local by what is foreign — rather than enumerating everything
 * domestic — cannot rot the same way. Outlets with NO region are already
 * treated as local by buildOutletMaps (they never enter outletRegionMap), so
 * the denylist preserves that default.
 */
const UK_REGIONS = new Set(['london', 'uk', 'national-uk']);

/**
 * SERP-DISCOVERY whitelist — deliberately NARROW, and deliberately NOT the
 * same thing as isBroadwayLocalRegion(). This one answers "should we spend
 * paid SERP credit enumerating this outlet for a US show?", where the ~863
 * region-less outlets are a long tail of blogs we do not want to query. Do
 * not merge the two sets: widening this one costs money, widening the other
 * one drops real reviews. They are different questions with different
 * failure modes.
 */
const US_SERP_REGIONS = new Set(['us', 'chicago', 'los-angeles', 'philadelphia', 'boston', 'san-francisco', 'dual']);

/**
 * True when an outlet's registry region is local to the Broadway / off-Broadway
 * market. A missing/unknown region is LOCAL (the permissive default that
 * buildOutletMaps already implies) — only an explicitly foreign region is not.
 * @param {string|null|undefined} region
 * @returns {boolean}
 */
function isBroadwayLocalRegion(region) {
  if (!region) return true;
  return !UK_REGIONS.has(String(region).toLowerCase());
}

/**
 * True when an outlet's registry region is local to the West End / off-West-End
 * market. Mirrors the long-standing inline test in gather-reviews.js.
 * @param {string|null|undefined} region
 * @returns {boolean}
 */
function isWestEndLocalRegion(region) {
  if (!region) return false;
  const r = String(region).toLowerCase();
  return r === 'london' || r === 'national-uk' || r === 'national' || r === 'uk';
}

module.exports = { buildOutletMaps, inferOutletRegionFromCategories, backfillMissingOutletRegions, UK_REGIONS, US_SERP_REGIONS, isBroadwayLocalRegion, isWestEndLocalRegion };
