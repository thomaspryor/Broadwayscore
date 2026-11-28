#!/usr/bin/env node
/**
 * generate-outlet-logos.js
 *
 * Builds src/config/outlet-logos-generated.json — a slim
 *   outletId -> { domain, displayName, color?, abbrev }
 * map derived from the CANONICAL data/outlet-registry.json.
 *
 * Why this exists:
 *   The legacy OUTLET_LOGOS map in src/config/outlet-logos.ts was a
 *   hand-maintained, display-name-keyed table covering ~100 outlets. The other
 *   ~370 outlets that appear in reviews had no entry, so OutletLogo fell through
 *   to a plain gray letter-circle ("missing logo"). The registry already has a
 *   real `domain` for 433 outlets and every review carries an `outletId`, so we
 *   resolve logos by outletId and never miss a configured outlet again.
 *
 * Brand colors/abbreviations curated in outlet-logos.ts are preserved by
 * matching on domain.
 *
 * Run: node scripts/generate-outlet-logos.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data/outlet-registry.json');
const LEGACY_TS_PATH = path.join(ROOT, 'src/config/outlet-logos.ts');
const OUT_PATH = path.join(ROOT, 'src/config/outlet-logos-generated.json');

// --- Parse curated color/abbrev from the legacy TS map, keyed by domain ---
// Lines look like:  'New York Times': { domain: 'nytimes.com', color: '#000000', abbrev: 'T', darkBg: true },
function parseCurated() {
  const src = fs.readFileSync(LEGACY_TS_PATH, 'utf8');
  const byDomain = {};
  const lineRe = /\{\s*domain:\s*['"]([^'"]+)['"]([^}]*)\}/g;
  let m;
  while ((m = lineRe.exec(src))) {
    const domain = m[1];
    const rest = m[2];
    const color = (rest.match(/color:\s*['"]([^'"]+)['"]/) || [])[1];
    const abbrev = (rest.match(/abbrev:\s*['"]([^'"]+)['"]/) || [])[1];
    const darkBg = /darkBg:\s*true/.test(rest);
    // Keep the first (richest) definition per domain.
    if (!byDomain[domain]) byDomain[domain] = { color, abbrev, darkBg };
  }
  return byDomain;
}

// Derive a short abbreviation from a display name (initials, max 3 chars).
function deriveAbbrev(displayName) {
  const stop = new Set(['the', 'of', 'and', 'on', '&', 'a', 'an']);
  const words = String(displayName)
    .replace(/[().]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !stop.has(w.toLowerCase()));
  if (words.length === 0) return String(displayName).slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join('');
}

// Build the slim outletId -> logo-config map. Pure function of the two inputs
// so the drift-guard test can call it and compare against the committed JSON.
function buildMap() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const curated = parseCurated();
  const outlets = registry.outlets || {};

  const out = {};
  let curatedHits = 0;

  for (const [id, o] of Object.entries(outlets)) {
    const domain = o.domain || o.domains?.[0] || null;
    const displayName = o.displayName || o.name || id;
    if (!domain) continue; // no domain -> client falls back to colored/letter circle

    const cur = curated[domain] || {};
    if (cur.color || cur.abbrev) curatedHits++;

    const entry = {
      domain,
      displayName,
      abbrev: cur.abbrev || deriveAbbrev(displayName),
    };
    if (cur.color) entry.color = cur.color;
    if (cur.darkBg) entry.darkBg = true;
    out[id] = entry;
  }

  // Stable, sorted output for clean diffs.
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return { map: sorted, registryCount: Object.keys(outlets).length, curatedHits };
}

function serialize(map) {
  return JSON.stringify(map, null, 0) + '\n';
}

function main() {
  const { map, registryCount, curatedHits } = buildMap();
  fs.writeFileSync(OUT_PATH, serialize(map));
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  registry outlets: ${registryCount}`);
  console.log(`  with domain (emitted): ${Object.keys(map).length}`);
  console.log(`  preserved curated color/abbrev: ${curatedHits}`);
}

module.exports = { buildMap, serialize, OUT_PATH };

if (require.main === module) main();
