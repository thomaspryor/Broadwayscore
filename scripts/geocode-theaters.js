#!/usr/bin/env node
/**
 * Geocode theater coordinates for the Show Stats map (plan v2 Sprint 1).
 *
 * - Broadway: adds `lat`/`lng` fields inside each existing entry of
 *   data/theater-metadata.json (never touches other fields).
 * - West End: writes NEW keyed file data/we-theater-metadata.json
 *   ({ normalizedName: { lat, lng, query } }). data/west-end-venues.json
 *   stays an untouched string[] — venue-classification.ts depends on that
 *   shape for market routing.
 *
 * Source: OSM Nominatim (1.1s spacing per usage policy). Every result is
 * validated against a city bounding box; a miss throws — no silent nulls.
 *
 * Run: node scripts/geocode-theaters.js            (writes both files)
 *      node scripts/geocode-theaters.js --check    (validate existing coords only)
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const TM_PATH = path.join(dataDir, 'theater-metadata.json');
const WE_OUT_PATH = path.join(dataDir, 'we-theater-metadata.json');

// Broadway houses cluster in the Theater District plus Lincoln Center
// (Vivian Beaumont). West End box stretches to Victoria (Apollo Victoria,
// Victoria Palace) and the Barbican.
const BOXES = {
  nyc: { latMin: 40.75, latMax: 40.78, lngMin: -74.0, lngMax: -73.97 },
  london: { latMin: 51.485, latMax: 51.53, lngMin: -0.165, lngMax: -0.08 }, // stretches to Sloane Square (Royal Court) and Victoria
};

function inBox(box, lat, lng) {
  return lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BroadwayScorecard/1.0 (theater map; thomas.pryor@gmail.com)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`nominatim ${res.status} for "${query}"`);
  const rows = await res.json();
  if (!rows.length) return null;
  return { lat: Number(rows[0].lat), lng: Number(rows[0].lon), display: rows[0].display_name };
}

async function geocodeWithFallbacks(queries, box, label) {
  for (const q of queries) {
    let hit = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { hit = await geocode(q); break; }
      catch (e) { console.log(`  ↳ retry ${attempt + 1} for "${q}": ${e.message}`); await sleep(3000); }
    }
    await sleep(1100);
    if (hit && inBox(box, hit.lat, hit.lng)) return { ...hit, query: q };
    if (hit) console.log(`  ↳ out-of-box for "${q}": ${hit.lat},${hit.lng} (${hit.display.slice(0, 60)})`);
  }
  throw new Error(`no in-box geocode for ${label} (tried: ${queries.join(' | ')})`);
}

function checkOnly() {
  const tm = JSON.parse(fs.readFileSync(TM_PATH, 'utf-8'));
  const houses = Object.keys(tm).filter((k) => k !== '_meta');
  const missing = houses.filter((h) => typeof tm[h].lat !== 'number' || typeof tm[h].lng !== 'number');
  const outOfBox = houses.filter((h) => tm[h].lat && !inBox(BOXES.nyc, tm[h].lat, tm[h].lng));
  const we = JSON.parse(fs.readFileSync(WE_OUT_PATH, 'utf-8'));
  const weKeys = Object.keys(we).filter((k) => k !== '_meta');
  const weMissing = weKeys.filter((k) => typeof we[k].lat !== 'number');
  const weOut = weKeys.filter((k) => we[k].lat && !inBox(BOXES.london, we[k].lat, we[k].lng));
  console.log(`Broadway: ${houses.length} houses, ${missing.length} missing coords, ${outOfBox.length} out of box`);
  console.log(`West End: ${weKeys.length} venues, ${weMissing.length} missing coords, ${weOut.length} out of box`);
  if (missing.length || outOfBox.length || weMissing.length || weOut.length) process.exit(1);
}

async function main() {
  if (process.argv.includes('--check')) return checkOnly();

  const tm = JSON.parse(fs.readFileSync(TM_PATH, 'utf-8'));
  const houses = Object.keys(tm).filter((k) => k !== '_meta');
  console.log(`Geocoding ${houses.length} Broadway houses…`);
  for (const name of houses) {
    if (typeof tm[name].lat === 'number' && inBox(BOXES.nyc, tm[name].lat, tm[name].lng)) continue;
    const hit = await geocodeWithFallbacks(
      [`${name}, Manhattan, New York`, `${name}, Broadway, New York, NY`],
      BOXES.nyc, name,
    );
    tm[name].lat = hit.lat;
    tm[name].lng = hit.lng;
    console.log(`  ✓ ${name}: ${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}`);
  }
  fs.writeFileSync(TM_PATH, JSON.stringify(tm, null, 2) + '\n');

  const weNames = JSON.parse(fs.readFileSync(path.join(dataDir, 'west-end-venues.json'), 'utf-8'));
  const weOut = fs.existsSync(WE_OUT_PATH) ? JSON.parse(fs.readFileSync(WE_OUT_PATH, 'utf-8')) : {};
  weOut._meta = {
    description: 'West End theatre coordinates for the Show Stats map. Keyed by the normalized names in west-end-venues.json (which stays a plain string[] — venue-classification.ts depends on that shape).',
    source: 'OSM Nominatim',
    generated: 'scripts/geocode-theaters.js',
  };
  // Venue-list names that OSM knows under a different (usually post-rename) name
  const WE_QUERY_ALIASES = {
    "her majesty's": "His Majesty's Theatre",   // renamed 2023 (King Charles III)
    "queen's": 'Sondheim Theatre',              // renamed 2019
    'new london': 'Gillian Lynne Theatre',      // renamed 2018
    'soho place': '@sohoplace',                 // official stylized name (opened 2022)
    wyndhams: "Wyndham's Theatre",              // apostrophe required for OSM match
  };
  const failed = [];
  console.log(`Geocoding ${weNames.length} West End venues…`);
  for (const name of weNames) {
    if (weOut[name] && typeof weOut[name].lat === 'number' && inBox(BOXES.london, weOut[name].lat, weOut[name].lng)) continue;
    const base = / theatre$| theater$/.test(name) ? name : `${name} theatre`;
    const queries = [`${base}, West End, London`, `${base}, London, UK`, `${name}, London theatre`];
    if (WE_QUERY_ALIASES[name]) queries.unshift(`${WE_QUERY_ALIASES[name]}, London`);
    let hit;
    try { hit = await geocodeWithFallbacks(queries, BOXES.london, name); }
    catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed.push(name); continue; }
    weOut[name] = { lat: hit.lat, lng: hit.lng, query: hit.query };
    // checkpoint after every venue — a mid-run failure must not lose progress
    fs.writeFileSync(WE_OUT_PATH, JSON.stringify(weOut, null, 2) + '\n');
    console.log(`  ✓ ${name}: ${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}`);
  }
  fs.writeFileSync(WE_OUT_PATH, JSON.stringify(weOut, null, 2) + '\n');
  if (failed.length) { console.log(`FAILED (${failed.length}): ${failed.join(', ')}`); process.exit(1); }
  console.log('Done. Run with --check to validate.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
