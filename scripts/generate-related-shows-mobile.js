#!/usr/bin/env node
/**
 * Writes public/data/related-shows-mobile.json for the iOS app from data/related-shows.json.
 * Runs in prebuild (gitignored output, like diary-search.json), so it always matches the
 * build's data and no workflow has to stage it.
 */
const fs = require('fs');
const path = require('path');
const { buildMobileRelated } = require('./lib/related-shows-mobile');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/generate-related-shows-mobile.js\nWrites public/data/related-shows-mobile.json from data/related-shows.json + data/shows.json (no flags).');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const related = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'related-shows.json'), 'utf8'));
const { shows } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const out = buildMobileRelated(related.shows, shows);
const outPath = path.join(ROOT, 'public', 'data', 'related-shows-mobile.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`related-shows-mobile: ${Object.keys(out.r).length} shows, ${out.ids.length} ids, ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
