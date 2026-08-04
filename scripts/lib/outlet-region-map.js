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

module.exports = { buildOutletMaps, inferOutletRegionFromCategories };
