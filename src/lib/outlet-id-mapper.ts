// Outlet ID Mapper — Registry-based tier lookup
//
// After the Feb 27 namespace unification, OUTLET_TIERS in scoring.ts uses
// lowercase registry IDs directly. The old uppercase mapping layer
// (REGISTRY_TO_SCORING, toScoringId, toRegistryId) has been removed.
//
// This file retains only getRegistryTier() — a fallback for the ~700+ outlets
// in outlet-registry.json that don't have explicit entries in OUTLET_TIERS.
//
// Per-region tiers (added 2026-04-29 with v5):
// Outlets can declare `tiers: { nyc, london }` in the registry. The regional
// tier is selected based on the show's category. Falls back to legacy `tier`
// field if regional tiers absent.

type RegistryTierEntry = {
  default: number;
  nyc?: number;
  london?: number;
};

let _registryTierCache: Record<string, RegistryTierEntry> | null = null;

function _loadRegistryTiers(): Record<string, RegistryTierEntry> {
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
        const e = entry as { tier?: number; tiers?: { nyc?: number; london?: number } };
        const norm: RegistryTierEntry = { default: 0 };
        if (e.tiers && typeof e.tiers === 'object') {
          if (e.tiers.nyc != null) norm.nyc = e.tiers.nyc;
          if (e.tiers.london != null) norm.london = e.tiers.london;
        }
        if (e.tier != null) {
          norm.default = e.tier;
        } else if (norm.nyc != null) {
          norm.default = norm.nyc;
        } else if (norm.london != null) {
          norm.default = norm.london;
        }
        if (norm.default) _registryTierCache[id] = norm;
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
 *
 * @param outletId - A canonical (lowercase) outlet ID
 * @param showCategory - Optional show category for region-aware lookup
 * @returns The tier (1, 2, 3, or 4), or undefined if not in registry
 */
export function getRegistryTier(outletId: string, showCategory?: string): number | undefined {
  if (!outletId) return undefined;
  const tiers = _loadRegistryTiers();
  const entry = tiers[outletId.toLowerCase().trim()];
  if (!entry) return undefined;
  if (showCategory) {
    const region = (showCategory === 'west-end' || showCategory === 'off-west-end') ? 'london' : 'nyc';
    if (entry[region] != null) return entry[region];
  }
  return entry.default;
}
