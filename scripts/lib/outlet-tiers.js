/**
 * Shared outlet tier lookup helper for scripts.
 *
 * Lookup priority (mirrors src/lib/engine.ts::getOutletConfig()):
 *   1. src/config/outlet-tiers.json — 81 authoritative overrides (single source of truth)
 *   2. data/outlet-registry.json — ~775 long-tail outlets
 *   3. DEFAULT_TIER (3)
 *
 * Before April 2026 this module only consulted outlet-registry.json,
 * which had the wrong tier for 5 UK outlets (thestage, timeout-london,
 * financialtimes, daily-mail, artsdesk). Any consumer using getTier()
 * for scoring-adjacent work (gold lists, dedup priority, LLM scoring
 * config) silently produced wrong results for West End shows. Fixed by
 * layering the authoritative overrides on top of the registry.
 *
 * Usage:
 *   const { getTier, getTierWeight, TIER_WEIGHTS } = require('./outlet-tiers');
 *   const tier = getTier('thestage');       // 1 (was wrongly 2 pre-fix)
 *   const weight = getTierWeight('vulture'); // 1.0
 */

const path = require('path');
const fs = require('fs');

const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.35 };
const DEFAULT_TIER = 3;

// Build lookup map lazily on first use
let _tiers = null; // lowercase ID → tier

function _loadTiers() {
  if (_tiers) return;
  _tiers = {};

  // Layer 2 (lower priority): outlet-registry.json — long-tail outlets (~775)
  const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const outlets = registry.outlets || registry;
      for (const [id, entry] of Object.entries(outlets)) {
        _tiers[id] = entry.tier || DEFAULT_TIER;
      }
    } catch {
      console.warn('[outlet-tiers] WARNING: could not parse outlet-registry.json');
    }
  }

  // Layer 1 (higher priority): src/config/outlet-tiers.json — overrides registry
  const overridesPath = path.join(__dirname, '..', '..', 'src', 'config', 'outlet-tiers.json');
  if (fs.existsSync(overridesPath)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
      for (const [id, entry] of Object.entries(overrides)) {
        _tiers[id] = entry.tier; // authoritative override
      }
    } catch {
      console.warn('[outlet-tiers] WARNING: could not parse src/config/outlet-tiers.json');
    }
  } else {
    console.warn('[outlet-tiers] WARNING: src/config/outlet-tiers.json missing — UK outlet tiers may be wrong');
  }
}

/**
 * Get the tier (1, 2, or 3) for an outlet ID.
 * Accepts canonical lowercase IDs (nytimes, vulture).
 */
function getTier(outletId) {
  if (!outletId) return DEFAULT_TIER;
  _loadTiers();

  const lower = outletId.toLowerCase().trim();
  if (_tiers[lower] != null) return _tiers[lower];

  return DEFAULT_TIER;
}

/**
 * Get the tier weight for an outlet ID.
 */
function getTierWeight(outletId) {
  return TIER_WEIGHTS[getTier(outletId)];
}

module.exports = { getTier, getTierWeight, TIER_WEIGHTS, DEFAULT_TIER };
