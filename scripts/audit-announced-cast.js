#!/usr/bin/env node
'use strict';
/**
 * audit-announced-cast — announced shows must not carry a cast from an older
 * production (BRO-5809: Private Lives 2025 held the 1948 Tallulah Bankhead cast).
 * Flags announced rows with a cast whose data/cast file is rejected by
 * castFileMismatchReason, or that have no cast file at all (source unknown).
 *   node scripts/audit-announced-cast.js [--strict]   --strict exits 1 on any hit
 */
const fs = require('fs');
const path = require('path');
const { castFileMismatchReason } = require('./lib/cast-tombstone');
require('./lib/cli-help').exitOnHelp(module);

const ROOT = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const shows = Array.isArray(raw) ? raw : raw.shows;
const hits = [];
let withCast = 0;
for (const s of shows) {
  if (s.status !== 'announced' || !Array.isArray(s.cast) || !s.cast.length) continue;
  withCast++;
  const f = path.join(ROOT, 'data', 'cast', `${s.id}.json`);
  const reason = fs.existsSync(f)
    ? castFileMismatchReason(JSON.parse(fs.readFileSync(f, 'utf8')), s)
    : 'no-cast-file';
  if (reason) hits.push({ id: s.id, reason, first: s.cast[0].name });
}
console.log(`announced rows with a cast: ${withCast}; suspicious: ${hits.length}`);
for (const h of hits) console.log(`  ${h.id} (${h.reason}) first=${h.first}`);
process.exit(process.argv.includes('--strict') && hits.length ? 1 : 0);
