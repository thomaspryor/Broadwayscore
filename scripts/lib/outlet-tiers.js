/**
 * Shared outlet tier lookup — reads from outlet-registry.json (source of truth).
 *
 * Replaces hardcoded OUTLET_TIERS in individual scripts to prevent drift.
 * OUTLET_TIERS in scoring.ts now uses the same lowercase registry IDs.
 *
 * Usage:
 *   const { getTier, getTierWeight, TIER_WEIGHTS } = require('./outlet-tiers');
 *   const tier = getTier('nytimes');       // 1
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

  // Load outlet-registry.json (single source of truth for all tiers)
  const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
  if (!fs.existsSync(registryPath)) {
    console.warn('[outlet-tiers] WARNING: outlet-registry.json not found, all outlets will default to Tier 3');
    return;
  }

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const outlets = registry.outlets || registry;

  for (const [id, entry] of Object.entries(outlets)) {
    const tier = entry.tier || DEFAULT_TIER;
    _tiers[id] = tier;
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
