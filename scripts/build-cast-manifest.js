#!/usr/bin/env node
// Generates data/cast-manifest.json: a flat array of every cast member entry
// across all data/cast/*.json files, with the fields data-actors.ts needs to
// build actor profiles (showId, name, ibdbPersonId, role, castType, flags).
//
// Why: src/lib/data-actors.ts used to read data/cast/${file}.json dynamically
// at runtime via fs.readdirSync(process.cwd() + '/data/cast'). Next File
// Tracing can't predict those dynamic paths, so it bundled all ~2400 cast
// files (300MB+) into the serverless function, tripping Vercel's 300MB limit.
//
// Commit e2154a1b23 added data/cast/** to outputFileTracingExcludes as a
// belt-and-suspenders guard — but that broke the runtime reads in
// data-actors.ts, making every /cast/[slug] page return 404 in production.
//
// This manifest collapses the per-show files into a single ~5MB JSON that
// data-actors.ts can static-require, so NFT can keep data/cast/** excluded.
// See memory/feedback_vercel_nft_dynamic_paths.md.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CAST_DIR = path.join(ROOT, 'data', 'cast');
const OUT_PATH = path.join(ROOT, 'data', 'cast-manifest.json');

if (!fs.existsSync(CAST_DIR)) {
  console.error(`[build-cast-manifest] data/cast/ not found at ${CAST_DIR} — writing empty manifest`);
  fs.writeFileSync(OUT_PATH, JSON.stringify({ entries: [] }) + '\n');
  process.exit(0);
}

const files = fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json'));
const entries = [];
let fileCount = 0;
let skippedNoId = 0;

for (const file of files) {
  const showId = file.replace(/\.json$/, '');
  let castFile;
  try {
    castFile = JSON.parse(fs.readFileSync(path.join(CAST_DIR, file), 'utf-8'));
  } catch {
    continue;
  }
  fileCount++;

  const pushMembers = (members, castType) => {
    if (!Array.isArray(members)) return;
    for (const member of members) {
      if (!member || !member.ibdbPersonId) { skippedNoId++; continue; }
      entries.push({
        showId,
        castType,
        name: String(member.name || ''),
        ibdbPersonId: String(member.ibdbPersonId),
        role: String(member.role || ''),
        flags: Array.isArray(member.flags) && member.flags.length ? member.flags : undefined,
      });
    }
  };

  pushMembers(castFile.openingNightCast, 'obc');
  pushMembers(castFile.replacements, 'replacement');
  pushMembers(castFile.currentCast, 'current');
}

fs.writeFileSync(OUT_PATH, JSON.stringify({ entries }) + '\n');
const sizeKB = Math.round(fs.statSync(OUT_PATH).size / 1024);
console.log(`[build-cast-manifest] ${entries.length} entries from ${fileCount} cast files → ${OUT_PATH} (${sizeKB}KB, skipped ${skippedNoId} without ibdbPersonId)`);
