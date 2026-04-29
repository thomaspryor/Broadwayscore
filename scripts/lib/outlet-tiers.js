/**
 * Shared outlet tier lookup helper for scripts.
 *
 * Lookup priority (mirrors src/lib/engine.ts::getOutletConfig()):
 *   1. src/config/outlet-tiers.json — authoritative overrides (single source of truth)
 *   2. data/outlet-registry.json — long-tail outlets
 *   3. DEFAULT_TIER (3)
 *
 * Per-region tiers (added 2026-04-29 with v5):
 *   Outlets can declare `tiers: { nyc, london }` in either source. The
 *   regional tier is selected based on the show's category:
 *     - broadway / off-broadway → NYC tier
 *     - west-end / off-west-end → London tier
 *   Falls back to legacy `tier` field if regional tiers absent.
 *
 *   Example: NYT NYC=1, London=2. The Stage NYC=2, London=1.
 *
 * T4 (weight 0.20) added 2026-04-29 — single-author blog floor for outlets
 * with no aggregator pickup and no recognized-critic status.
 *
 * Usage:
 *   const { getTier, getTierWeight, TIER_WEIGHTS } = require('./outlet-tiers');
 *   // Backwards-compatible — returns NYC tier (or legacy single tier):
 *   const tier = getTier('thestage');
 *   // Region-aware — returns London tier when show is West End:
 *   const tier = getTier('thestage', { showCategory: 'west-end' });
 *   const weight = getTierWeight('vulture', { showCategory: 'broadway' });
 */

const path = require('path');
const fs = require('fs');

// Tier weights — v5 (2026-04-29). T4 added; T3 raised 0.35→0.40.
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.40, 4: 0.20 };
const DEFAULT_TIER = 3;

// Off-market multiplier — applied to Off-Broadway and Off-West-End reviews
// to acknowledge that off-market coverage is typically lighter critical
// engagement than the parent market. Set OFF_MARKET_MULTIPLIER = 1.0 to disable.
const OFF_MARKET_MULTIPLIER = 0.8;

// Build lookup map lazily on first use.
// Stores { default: number, nyc?: number, london?: number } per outlet.
let _tiers = null; // lowercase ID → entry

function _entryFromRaw(entry) {
  // Accept either { tier: N } or { tiers: { nyc, london } } or both.
  // Returns normalized { default, nyc, london }.
  const out = {};
  if (entry.tiers && typeof entry.tiers === 'object') {
    if (entry.tiers.nyc != null) out.nyc = entry.tiers.nyc;
    if (entry.tiers.london != null) out.london = entry.tiers.london;
  }
  if (entry.tier != null) {
    out.default = entry.tier;
  } else if (out.nyc != null) {
    out.default = out.nyc; // back-fill default from NYC if no top-level tier
  } else if (out.london != null) {
    out.default = out.london;
  }
  return out;
}

function _loadTiers() {
  if (_tiers) return;
  _tiers = {};

  // Layer 2 (lower priority): outlet-registry.json — long-tail outlets
  const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const outlets = registry.outlets || registry;
      for (const [id, entry] of Object.entries(outlets)) {
        _tiers[id] = _entryFromRaw(entry);
        if (_tiers[id].default == null) _tiers[id].default = DEFAULT_TIER;
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
        const normalized = _entryFromRaw(entry);
        // Override REPLACES registry entry (don't merge — explicit wins)
        _tiers[id] = normalized;
        if (_tiers[id].default == null) _tiers[id].default = DEFAULT_TIER;
      }
    } catch {
      console.warn('[outlet-tiers] WARNING: could not parse src/config/outlet-tiers.json');
    }
  } else {
    console.warn('[outlet-tiers] WARNING: src/config/outlet-tiers.json missing');
  }
}

/**
 * Map a show category to the tier region.
 *   'broadway' / 'off-broadway' → 'nyc'
 *   'west-end' / 'off-west-end' → 'london'
 */
function regionForShowCategory(showCategory) {
  if (showCategory === 'west-end' || showCategory === 'off-west-end') return 'london';
  return 'nyc';
}

/**
 * Get the tier for an outlet ID.
 *
 * @param {string} outletId  — canonical lowercase ID (nytimes, vulture)
 * @param {Object} [opts]    — optional context
 * @param {string} [opts.showCategory] — when provided, returns the region-specific tier
 *
 * Backwards-compatible: callers that don't pass showCategory get the NYC tier
 * (or legacy single tier). NYC is the default region because the catalog is
 * Broadway-heavy.
 */
function getTier(outletId, opts) {
  if (!outletId) return DEFAULT_TIER;
  _loadTiers();
  const lower = outletId.toLowerCase().trim();
  const entry = _tiers[lower];
  if (!entry) return DEFAULT_TIER;
  if (opts && opts.showCategory) {
    const region = regionForShowCategory(opts.showCategory);
    if (entry[region] != null) return entry[region];
    // No region-specific tier defined — fall back to default (legacy)
  }
  return entry.default != null ? entry.default : DEFAULT_TIER;
}

/**
 * Get the base tier weight for an outlet ID (without off-market multiplier).
 */
function getTierWeight(outletId, opts) {
  return TIER_WEIGHTS[getTier(outletId, opts)];
}

/**
 * Get the FINAL effective weight including off-market multiplier.
 * Use this for scoring; getTierWeight() returns the base tier weight.
 */
function getEffectiveWeight(outletId, opts) {
  const base = getTierWeight(outletId, opts);
  if (!opts || !opts.showCategory) return base;
  const isOffMarket = opts.showCategory === 'off-broadway' || opts.showCategory === 'off-west-end';
  return isOffMarket ? base * OFF_MARKET_MULTIPLIER : base;
}

module.exports = {
  getTier,
  getTierWeight,
  getEffectiveWeight,
  regionForShowCategory,
  TIER_WEIGHTS,
  OFF_MARKET_MULTIPLIER,
  DEFAULT_TIER,
};
