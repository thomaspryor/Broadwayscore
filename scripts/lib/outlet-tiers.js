/**
 * Shared outlet tier lookup — reads from outlet-registry.json (source of truth).
 *
 * Supports both canonical IDs (nytimes, vulture) and scoring IDs (NYT, VULT).
 * Replaces hardcoded OUTLET_TIERS in individual scripts to prevent drift.
 *
 * Usage:
 *   const { getTier, getTierWeight, TIER_WEIGHTS } = require('./outlet-tiers');
 *   const tier = getTier('nytimes');       // 1
 *   const tier = getTier('NYT');           // 1
 *   const weight = getTierWeight('vulture'); // 1.0
 */

const path = require('path');
const fs = require('fs');

const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.45 };
const DEFAULT_TIER = 3;

// Build lookup maps lazily on first use
let _canonicalTiers = null; // canonical ID → tier
let _scoringTiers = null;   // scoring ID → tier

function _loadTiers() {
  if (_canonicalTiers) return;

  _canonicalTiers = {};
  _scoringTiers = {};

  // Load outlet-registry.json
  const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
  if (!fs.existsSync(registryPath)) {
    console.warn('[outlet-tiers] WARNING: outlet-registry.json not found, all outlets will default to Tier 3');
    return;
  }

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const outlets = registry.outlets || registry;

  for (const [id, entry] of Object.entries(outlets)) {
    const tier = entry.tier || DEFAULT_TIER;
    _canonicalTiers[id] = tier;
  }

  // Load scoring.ts OUTLET_TIERS via outlet-id-mapper mappings
  // We read the registry aliases to build scoring ID → canonical ID → tier
  try {
    const mapperPath = path.join(__dirname, '..', '..', 'src', 'lib', 'outlet-id-mapper.ts');
    const mapperSrc = fs.readFileSync(mapperPath, 'utf8');

    // Extract REGISTRY_TO_SCORING entries: 'canonical': 'SCORING'
    // First match wins — primary mappings appear before aliases in the file,
    // preventing alias entries (e.g., 'new-york' → VULT) from overwriting
    // the correct tier from the primary mapping ('vulture' → VULT).
    const primaryRegex = /^\s*'([^']+)':\s*'([^']+)'/gm;
    let match;
    while ((match = primaryRegex.exec(mapperSrc)) !== null) {
      const [, canonicalId, scoringId] = match;
      if (_scoringTiers[scoringId] == null && _canonicalTiers[canonicalId] != null) {
        _scoringTiers[scoringId] = _canonicalTiers[canonicalId];
      }
    }
  } catch {
    // Fallback: extract scoring IDs from scoring.ts directly
    try {
      const scoringPath = path.join(__dirname, '..', '..', 'src', 'config', 'scoring.ts');
      const scoringSrc = fs.readFileSync(scoringPath, 'utf8');
      const tierRegex = /^\s*'([A-Z0-9-]+)':\s*\{\s*tier:\s*(\d)/gm;
      let m;
      while ((m = tierRegex.exec(scoringSrc)) !== null) {
        _scoringTiers[m[1]] = parseInt(m[2]);
      }
    } catch {
      // Both fallbacks failed — scoring IDs won't resolve
    }
  }
}

/**
 * Get the tier (1, 2, or 3) for an outlet ID.
 * Accepts both canonical IDs (nytimes) and scoring IDs (NYT).
 */
function getTier(outletId) {
  if (!outletId) return DEFAULT_TIER;
  _loadTiers();

  // Try canonical (lowercase) first
  const lower = outletId.toLowerCase().trim();
  if (_canonicalTiers[lower] != null) return _canonicalTiers[lower];

  // Try scoring (uppercase)
  const upper = outletId.toUpperCase().trim();
  if (_scoringTiers[upper] != null) return _scoringTiers[upper];

  return DEFAULT_TIER;
}

/**
 * Get the tier weight for an outlet ID.
 */
function getTierWeight(outletId) {
  return TIER_WEIGHTS[getTier(outletId)];
}

module.exports = { getTier, getTierWeight, TIER_WEIGHTS, DEFAULT_TIER };
