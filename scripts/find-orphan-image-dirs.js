#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const data = require('../data/shows.json');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `find-orphan-image-dirs.js — see file header for details.

Usage:
  node scripts/find-orphan-image-dirs.js [options]
  node scripts/find-orphan-image-dirs.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const shows = data.shows || data;
const ids = new Set((Array.isArray(shows) ? shows : Object.values(shows)).map(s => s.id));
const imgDir = path.join(__dirname, '../public/images/shows');
const dirs = fs.readdirSync(imgDir).filter(d => fs.statSync(path.join(imgDir, d)).isDirectory());
const orphans = dirs.filter(d => !ids.has(d));

console.log(`Total image dirs: ${dirs.length}`);
console.log(`Shows in shows.json: ${ids.size}`);
console.log(`Orphan dirs: ${orphans.length}`);

if (process.argv.includes('--delete')) {
  let deleted = 0;
  for (const d of orphans) {
    const full = path.join(imgDir, d);
    fs.rmSync(full, { recursive: true });
    deleted++;
    if (deleted % 50 === 0) console.log(`  Deleted ${deleted}/${orphans.length}...`);
  }
  console.log(`Deleted ${deleted} orphan directories.`);
} else {
  orphans.forEach(d => console.log(d));
  console.log(`\nRun with --delete to remove them.`);
}
