'use strict';

/**
 * Per-city config for the Theatre Limelight review sites (theatreinchicago.com,
 * theatreindc.com). BRO-6518 built the Chicago pickup; BRO-6771 generalizes it
 * so a city is a config entry here, not a copy of the scripts. Pure data.
 *
 *   key              --city= value on the CLIs
 *   base             site origin (listing, reviews and detail pages hang off it)
 *   host             hostname used to recognise our own evidenceUrls
 *   discoverySource  shows.json discoverySource (also in src/lib/local-market.ts)
 *   metro            data/venue-metros.json place slug written to show.city
 *   files            audit memory files, kept per city so the two never mix
 *   since            optional: only productions that opened on/after this date,
 *                    or are still open, are staged (short-history launch)
 */

// Built from data/city-hubs.json (BRO-6833): a city's `tic` block is its Theatre Limelight config.
// tourHouses / allowTypes are stored as case-insensitive pattern strings.
const registry = require('../../data/city-hubs.json');

const re = (p) => new RegExp(p, 'i');
const CITIES = {};
for (const [slug, hub] of Object.entries(registry.hubs)) {
  const t = hub.tic;
  if (!t) continue;
  CITIES[t.key] = {
    key: t.key,
    label: hub.short,
    base: t.base,
    host: t.host,
    discoverySource: hub.discoverySource,
    metro: slug,
    launched: hub.launched !== false,
    files: t.files,
    since: t.since || null,
    // null = no extra rules (Chicago keeps its original tour-house and IL/IN city logic in tic-stage.js).
    tourHouses: t.tourHouses ? t.tourHouses.map(re) : null,
    venueCities: t.venueCities || null,
    requireMetro: !!t.requireMetro,
    ...(t.minOutlets ? { minOutlets: t.minOutlets } : {}),
    ...(t.allowTypes ? { allowTypes: t.allowTypes.map(re) } : {}),
  };
}

function getCity(key) {
  const c = CITIES[key || 'chicago'];
  if (!c) throw new Error(`unknown city "${key}" (known: ${Object.keys(CITIES).join(', ')})`);
  return c;
}

/** The city config whose host appears in a URL, or null. */
function cityForUrl(url) {
  const u = String(url || '');
  return Object.values(CITIES).find((c) => u.includes(c.host)) || null;
}

/** A staged city (launched:false) may only be dry-run; a real run would write its shows into shows.json. */
function assertRunnable(city, dryRun) {
  if (!city.launched && !dryRun) throw new Error(`city "${city.key}" is staged (launched:false in data/city-hubs.json): use --dry-run, or launch it first`);
}

module.exports = { CITIES, getCity, cityForUrl, assertRunnable };
