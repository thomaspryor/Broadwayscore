#!/usr/bin/env node
// Generates data/actor-slugs.json: a static manifest mapping
// `${showId}:${normalizedName}` → ibdbPersonId for every cast member in data/cast/.
//
// Why: src/lib/data-tony-nominees.ts previously read data/cast/${showId}.json
// at runtime via a dynamic process.cwd() path. Next File Tracing can't predict
// which files are needed, so it bundled all ~2400 cast files (300MB+) into the
// serverless function, breaking Vercel's 300MB limit. Replacing the dynamic
// read with a single static-required manifest cuts the bundle dramatically.
// See memory/feedback_vercel_nft_dynamic_paths.md.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CAST_DIR = path.join(ROOT, 'data', 'cast');
const OUT_PATH = path.join(ROOT, 'data', 'actor-slugs.json');

function normalizeName(name) {
  return String(name || '').toLowerCase().trim();
}

if (!fs.existsSync(CAST_DIR)) {
  console.error(`[build-actor-slugs-manifest] data/cast/ not found at ${CAST_DIR} — writing empty manifest`);
  fs.writeFileSync(OUT_PATH, JSON.stringify({ entries: {} }, null, 2));
  process.exit(0);
}

const files = fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json'));
const entries = {};
let fileCount = 0;
let memberCount = 0;
let skippedNoId = 0;

for (const file of files) {
  const showId = file.replace(/\.json$/, '');
  let castFile;
  try {
    castFile = JSON.parse(fs.readFileSync(path.join(CAST_DIR, file), 'utf-8'));
  } catch {
    continue;
  }
  const cast = castFile.openingNightCast ?? castFile.currentCast ?? [];
  if (!Array.isArray(cast)) continue;
  fileCount++;
  for (const member of cast) {
    if (!member?.name) continue;
    // Orphans (no ibdbPersonId) are intentionally skipped here even though
    // build-cast-manifest.js includes them — this manifest powers the
    // name → ibdb-id lookup for /cast/[slug] linking, which orphans don't
    // have. The two manifests diverge by design as of 2026-05-24.
    if (!member.ibdbPersonId) { skippedNoId++; continue; }
    const key = `${showId}:${normalizeName(member.name)}`;
    // First match wins — openingNightCast preferred over currentCast (matches runtime logic)
    if (!(key in entries)) {
      entries[key] = String(member.ibdbPersonId);
      memberCount++;
    }
  }
}

fs.writeFileSync(OUT_PATH, JSON.stringify({ entries }, null, 0) + '\n');
console.log(`[build-actor-slugs-manifest] ${memberCount} entries from ${fileCount} cast files → ${OUT_PATH} (skipped ${skippedNoId} without ibdbPersonId)`);
