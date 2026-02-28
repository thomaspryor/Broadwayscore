// Outlet ID Mapper — Registry-based tier lookup
//
// After the Feb 27 namespace unification, OUTLET_TIERS in scoring.ts uses
// lowercase registry IDs directly. The old uppercase mapping layer
// (REGISTRY_TO_SCORING, toScoringId, toRegistryId) has been removed.
//
// This file retains only getRegistryTier() — a fallback for the ~700+ outlets
// in outlet-registry.json that don't have explicit entries in OUTLET_TIERS.

let _registryTierCache: Record<string, number> | null = null;

function _loadRegistryTiers(): Record<string, number> {
  if (_registryTierCache) return _registryTierCache;
  _registryTierCache = {};
  try {
    const fs = require('fs');
    const path = require('path');
    const registryPath = path.join(process.cwd(), 'data', 'outlet-registry.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const outlets = registry.outlets || registry;
      for (const [id, entry] of Object.entries(outlets)) {
        const e = entry as { tier?: number };
        if (e.tier) _registryTierCache[id] = e.tier;
      }
    }
  } catch {
    // Registry not available (e.g., in browser context) — return empty
  }
  return _registryTierCache;
}

/**
 * Get the tier for an outlet directly from outlet-registry.json.
 * Used as a fallback in getOutletConfig() for outlets not in OUTLET_TIERS.
 * @param outletId - A canonical (lowercase) outlet ID
 * @returns The tier (1, 2, or 3), or undefined if not in registry
 */
export function getRegistryTier(outletId: string): number | undefined {
  if (!outletId) return undefined;
  const tiers = _loadRegistryTiers();
  return tiers[outletId.toLowerCase().trim()];
}
